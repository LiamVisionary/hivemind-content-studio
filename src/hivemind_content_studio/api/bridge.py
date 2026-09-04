"""Same-origin proxies: the local-inference bridge and the Civitai handoff.

Moved out of control_api.py unchanged (2026-09-04). The staged-media route is
reachable without a session on purpose; the reason, and the check that stands
in for the session, are in control_api.py beside the gate.
"""

from __future__ import annotations

import asyncio
import json
import mimetypes
import re
import urllib.request
from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response

from .. import civitai_post
from ..media_studio import local_gateway_token, sanitize_error_detail
from ..settings import settings as studio_settings


def register(app, ctx) -> None:
    """Register the bridge, the open-gen API proxy and the Civitai staging routes."""
    router = APIRouter()
    require_owner = ctx.require_owner

    # /local-ai/* is the same bridge without the prefix — the unified frontend
    # served at "/" calls it same-origin (hosted-local-ai.js apiBase = '').
    # DELETE is here for one route only — cancelling a Civitai download — but the
    # allowlist below still decides which paths exist at all.
    @router.api_route("/local-ai/{subpath:path}", methods=["GET", "POST", "DELETE"], dependencies=[Depends(require_owner)])
    async def local_ai_bridge(subpath: str, request: Request) -> Response:
        return await open_gen_api(f"local-ai/{subpath}", request)

    @router.api_route("/open-gen-api/{path:path}", methods=["GET", "POST", "DELETE"], dependencies=[Depends(require_owner)])
    async def open_gen_api(path: str, request: Request) -> Response:
        allowed = {
            "health",
            "healthz",
            "local-ai/binary-status",
            "local-ai/models",
            "local-ai/generate",
            "local-ai/upscale",
            "local-ai/interpolate",
            "local-ai/episode",
            "local-ai/smart-mask",
            "local-ai/ltx-director",
            "local-ai/prompt-helper",
            "local-ai/civitai-download",
            "local-ai/lora-updates",
            # Model manager: the installed library, Civitai browse, and its filter
            # vocabulary. All read-only; downloads still go through civitai-download.
            "local-ai/library",
            "local-ai/civitai-search",
            "local-ai/civitai-base-models",
            # The inspiration finder: Civitai images/videos that carry a
            # reusable prompt. Read-only, same bridge, same Civitai key.
            "local-ai/civitai-images",
        }
        dynamic_local_ai_route = any(
            path.startswith(prefix)
            and path.removeprefix(prefix).replace("-", "").replace("_", "").replace("%", "").isalnum()
            for prefix in (
                "local-ai/job/",
                "local-ai/loras/",
                "local-ai/lora-preview/",
                "local-ai/model-preview/",
                "local-ai/civitai-download/",
            )
        ) or (
            # Stopping an image job at the gateway: one id segment, then "cancel".
            request.method == "POST"
            and re.fullmatch(r"local-ai/job/[A-Za-z0-9_.:%-]+/cancel", path) is not None
        )
        if path not in allowed and not dynamic_local_ai_route:
            raise HTTPException(status_code=404, detail="OpenGen bridge route not found")
        body = await request.body()
        # Forward the query string too. The route allowlist above is matched on the
        # PATH only, so this cannot widen it — but dropping the query silently broke
        # callers that pass parameters (e.g. /local-ai/loras/<id>?baseModels=…, which
        # is how workflows the bridge cannot see in its own registry get resolved).
        query = str(request.url.query or "")[:2048]
        upstream_url = f"{studio_settings().network.bridge_url}/{path}" + (f"?{query}" if query else "")

        def forward() -> tuple[bytes, int, str]:
            # The bridge authenticates its callers now (canvas-gate, same two
            # credentials as the Canvas surface beside it). This hop has no
            # browser session of its own, so it presents the loopback gateway
            # token — the same secret the bridge reads off disk. It stays
            # server-side: it is set on the outbound request and never on the
            # response the browser gets back.
            headers = {"Content-Type": request.headers.get("content-type", "application/json")}
            token = local_gateway_token()
            if token:
                headers["Authorization"] = f"Bearer {token}"
            proxy_request = urllib.request.Request(
                upstream_url,
                data=body or None,
                method=request.method,
                headers=headers,
            )
            try:
                with urllib.request.urlopen(proxy_request, timeout=190) as upstream:
                    return upstream.read(), upstream.status, upstream.headers.get("content-type", "application/json")
            except urllib.error.HTTPError as exc:
                return exc.read(), exc.code, exc.headers.get("content-type", "application/json")
            except (OSError, urllib.error.URLError) as exc:
                timed_out = isinstance(exc, TimeoutError) or isinstance(getattr(exc, "reason", None), TimeoutError)
                if timed_out:
                    raise RuntimeError("The local inference bridge did not answer within 190 s") from exc
                raise RuntimeError("The local inference bridge is unavailable") from exc

        try:
            content, status, content_type = await asyncio.to_thread(forward)
        except RuntimeError as exc:
            # Both keys: the studio wrappers read ``detail``, the bridge shim
            # (hosted-local-ai.js) reads ``error`` — so the Models view used to
            # show a bare "HTTP 503" for this.
            #
            # ``message`` is the sentence a person is shown, and ``remedy``
            # says which repair belongs beside it. "The local inference bridge
            # is unavailable" is accurate and means nothing to the owner of a
            # studio that has simply not finished starting.
            return JSONResponse(
                {
                    "message": "Your local engine isn't running",
                    "remedy": "local-engine",
                    "provider": "local",
                    "detail": str(exc),
                    "error": str(exc),
                },
                status_code=503,
            )
        # The last hop before the browser. An upstream refusal arrives as the
        # gateway's own words — a traceback tail, an absolute path, a JSON body
        # — and this is the only place left to translate it, so a failed lane
        # reads as a sentence with the original kept beside it rather than
        # instead of it. 2xx bodies (images, job records) pass untouched.
        if status >= 400 and "json" in content_type.lower():
            try:
                payload = json.loads(content or b"{}")
            except (json.JSONDecodeError, TypeError, ValueError):
                payload = None
            if isinstance(payload, dict):
                raw = payload.get("error") or payload.get("detail") or payload.get("message") or ""
                said = sanitize_error_detail(raw if isinstance(raw, str) else json.dumps(raw))
                if said:
                    payload = {**payload, "error": said, "detail": said, "message": said}
                    return JSONResponse(payload, status_code=status)
        return Response(content=content, status_code=status, media_type=content_type.split(";", 1)[0])

    # --- posting a creation to Civitai -------------------------------------
    # See civitai_post.py for why this is shaped the way it is: Civitai has no
    # upload API, its post composer fetches the media from the BROWSER, and so
    # the studio's job is to hold one plaintext copy at a URL the browser can
    # read, for a few minutes, and then forget it.

    # NOT under /api/civitai/*: the tailnet HTTPS proxy routes that whole prefix
    # to the MEDIA GATEWAY (its Civitai model search and downloads live there),
    # so a staging route inside it would 404 for every session reached over the
    # ts.net URL — which is most of them.
    @router.post("/api/civitai-post/stage", dependencies=[Depends(require_owner)])
    async def civitai_post_stage(
        request: Request,
        file: UploadFile = File(...),
        title: Annotated[str, Form()] = "",
        description: Annotated[str, Form()] = "",
        tags: Annotated[str, Form()] = "",
        meta: Annotated[str, Form()] = "",
    ) -> dict:
        """Take the decrypted bytes, write the generation metadata into them,
        and answer with the Civitai URL to open.

        The media arrives already decrypted: the browser holds the vault key,
        so it is the only side that CAN unseal an output. What crosses here is
        plaintext by the time it is sent, which is the whole point of the
        feature and is why nothing on this route touches the seal.
        """
        data = await file.read()
        if not data:
            raise HTTPException(status_code=400, detail="That file is empty.")
        try:
            parsed_meta = json.loads(meta) if meta else {}
            if not isinstance(parsed_meta, dict):
                parsed_meta = {}
        except json.JSONDecodeError:
            parsed_meta = {}
        content_type = (file.content_type or "").split(";", 1)[0].strip().lower()
        if not content_type:
            content_type = mimetypes.guess_type(file.filename or "")[0] or ""
        try:
            staged, stamped = await asyncio.to_thread(
                civitai_post.stage,
                data=data,
                content_type=content_type,
                filename=file.filename or "",
                meta=parsed_meta,
            )
        except civitai_post.CivitaiPostError as exc:
            # Always a named limit ("this clip runs 300s, the limit is 245s"),
            # so it is shown to the owner as written.
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        # The media URL has to be absolute AND reachable from the browser that
        # is signed in to Civitai — which is this browser. Its own origin is
        # therefore the only correct answer: guessing a hostname here is how a
        # tailnet session ends up handed a localhost URL it cannot open.
        origin = str(request.headers.get("origin") or "").rstrip("/")
        if not origin:
            base = request.base_url
            origin = f"{base.scheme}://{base.netloc}".rstrip("/")
        media_url = f"{origin}/civitai/staged/{staged.token}/{staged.filename}"
        tag_list = [tag.strip() for tag in str(tags or "").split(",") if tag.strip()]
        return {
            "ok": True,
            "token": staged.token,
            "mediaUrl": media_url,
            "intentUrl": civitai_post.intent_url(
                media_url, title=title, description=description, tags=tag_list
            ),
            "expiresAt": staged.expires_at,
            "bytes": staged.path.stat().st_size,
            "kind": staged.kind,
            # Whether the prompt actually travelled INSIDE the file. False is a
            # normal outcome (no ffmpeg, an odd container), and the studio says
            # so rather than implying Civitai will find settings that are not
            # there.
            "metadataEmbedded": bool(stamped),
        }

    @router.api_route("/civitai/staged/{token}/{filename}", methods=["GET", "HEAD", "OPTIONS"])
    async def civitai_staged_media(token: str, filename: str, request: Request) -> Response:
        """Serve one staged file to Civitai's post composer.

        Deliberately outside the sign-in gate — see _civitai_staged_route. The
        response is readable only from Civitai's own origins, and only while the
        token lives.
        """
        origin = civitai_post.cors_origin(request.headers.get("origin"))
        headers = {
            "Cache-Control": "no-store",
            # The composer reads these bytes with fetch().blob(), so without a
            # matching CORS header the read fails and the media never attaches.
            **({"Access-Control-Allow-Origin": origin, "Vary": "Origin"} if origin else {}),
            # Chrome treats civitai.com -> this machine as a public-to-private
            # request and preflights it; without this the fetch is blocked
            # before it is ever made.
            **({"Access-Control-Allow-Private-Network": "true"} if origin else {}),
        }
        if request.method == "OPTIONS":
            return Response(
                status_code=204,
                headers={
                    **headers,
                    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
                    "Access-Control-Allow-Headers": "*",
                    "Access-Control-Max-Age": "600",
                },
            )
        staged = await asyncio.to_thread(civitai_post.read_staged, token)
        if staged is None:
            raise HTTPException(status_code=404, detail="That staged media has expired.")
        return FileResponse(
            staged.path,
            media_type=staged.content_type,
            filename=staged.filename,
            headers=headers,
        )

    @router.delete("/api/civitai-post/stage/{token}", dependencies=[Depends(require_owner)])
    async def civitai_post_unstage(token: str) -> dict:
        """Drop a staging as soon as the post is made or abandoned, rather than
        leaving plaintext to wait out its TTL."""
        return {"ok": True, "dropped": await asyncio.to_thread(civitai_post.drop_staged, token)}

    app.include_router(router)
