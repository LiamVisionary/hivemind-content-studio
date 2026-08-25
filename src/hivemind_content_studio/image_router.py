"""One place that knows which generator runs which image provider.

The studios pick a model out of the media catalog, which lists eleven image
providers across five different credentials — an OpenAI API key, an OpenAI OAuth
grant, an xAI key, an xAI OAuth grant, Higgsfield, MUAPI, the HivemindOS
dashboard token, and the local Media Studio MCP. A caller that dispatches on
anything less than the provider id gets one of them right and silently sends the
rest somewhere else. That is exactly what happened on 2026-08-24: the Story and
Sprite studios treated "not local" as "MUAPI", so choosing GPT Image 2 under the
OAuth provider asked for a MUAPI API key and would have billed a MUAPI endpoint
of the same name.

So there is one table, keyed by the catalog's own provider id, and one function.
Adding a provider to the catalog without adding it here is a KeyError at the
route, not a wrong charge on someone else's account.

`provider_execution.py` dispatches the same providers for the agent pipeline,
but against a run manifest — scenes, artifacts, approval. This is the one-shot
studio press. They share the generators, not the plumbing.
"""

from __future__ import annotations

import json
import tempfile
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from . import generation
from .hivemindos_hosted_media import generate_hosted_media_asset
from .hivemindos_oauth import needs_reauthorization
from .media_studio import generate_image as generate_media_studio_image


class ImageRouterError(RuntimeError):
    """The request cannot be routed.

    `remedy` is what the owner should DO about it — the studio turns it into a
    button rather than printing the provider's sentence. `provider` says which
    account that button acts on. Showing a raw "Invalid refresh token." and
    leaving someone to work out that it means "reconnect ChatGPT" is the
    failure this carries the fix for.
    """

    def __init__(self, message: str, *, remedy: str = "", provider: str = "") -> None:
        super().__init__(message)
        self.remedy = remedy
        self.provider = provider


@dataclass(frozen=True)
class Route:
    """How one catalog provider renders a still.

    `label` is what the owner is told when the credential is missing, so the
    message names the account they have to connect rather than "the provider".
    `oauth` is the connection a Reconnect button would act on, when the route's
    credential is a grant rather than a key.
    """

    provider: str
    label: str
    run: Callable[..., dict[str, Any]]
    oauth: str = ""


def _openai_api(*, model: str, prompt: str, aspect_ratio: str, output: Path, quality: str, **_: Any) -> dict[str, Any]:
    return generation.generate_openai_image_asset(
        prompt=prompt, model=model, aspect_ratio=aspect_ratio, output=output,
        confirm=generation.PAID_GENERATION_CONFIRMATION, quality=quality or "medium",
    )


def _openai_oauth(*, model: str, prompt: str, aspect_ratio: str, output: Path, quality: str, **_: Any) -> dict[str, Any]:
    # A different credential AND a different endpoint from the API-key path.
    # They share a model id, which is the whole reason the two were confusable.
    return generation.generate_openai_oauth_image_asset(
        prompt=prompt, model=model, aspect_ratio=aspect_ratio, output=output,
        confirm=generation.PAID_GENERATION_CONFIRMATION, quality=quality or "medium",
    )


def _xai(auth_mode: str) -> Callable[..., dict[str, Any]]:
    """xAI Imagine under one of its two credentials — a key or a grant.

    The mode is checked HERE, at build time, rather than inside the generator on
    the first render. Passing "api" where the generator wanted "api-key" made
    every API-key render fail on its own argument while the provider went on
    advertising itself as ready; a table that cannot be built with a bad mode
    cannot ship that again.
    """
    if auth_mode not in generation.AUTH_MODES:
        raise ValueError(
            f"xAI route auth mode must be one of {', '.join(sorted(generation.AUTH_MODES))}, got {auth_mode!r}"
        )

    def run(*, model: str, prompt: str, aspect_ratio: str, output: Path, **_: Any) -> dict[str, Any]:
        return generation.generate_xai_imagine_asset(
            kind="keyframe", auth_mode=auth_mode, prompt=prompt, aspect_ratio=aspect_ratio,
            output=output, confirm=generation.PAID_GENERATION_CONFIRMATION, model=model or None,
        )
    return run


def _higgsfield_consumer(*, model: str, prompt: str, aspect_ratio: str, output: Path, **_: Any) -> dict[str, Any]:
    return generation.generate_higgsfield_consumer_asset(
        kind="keyframe", model=model, prompt=prompt, aspect_ratio=aspect_ratio,
        output=output, confirm=generation.PAID_GENERATION_CONFIRMATION,
    )


def _write_payload(directory: Path, name: str, data: dict[str, Any]) -> Path:
    path = directory / name
    path.write_text(json.dumps(data), encoding="utf-8")
    return path


def _higgsfield_cloud(*, model: str, prompt: str, aspect_ratio: str, output: Path, **_: Any) -> dict[str, Any]:
    with tempfile.TemporaryDirectory() as scratch:
        payload = _write_payload(Path(scratch), "payload.json", {"prompt": prompt, "aspect_ratio": aspect_ratio})
        return generation.generate_higgsfield_cloud_asset(
            model_id=model, payload=payload, output=output,
            confirm=generation.PAID_GENERATION_CONFIRMATION,
        )


def _muapi(*, model: str, prompt: str, aspect_ratio: str, output: Path, seed: int | None, **_: Any) -> dict[str, Any]:
    with tempfile.TemporaryDirectory() as scratch:
        body: dict[str, Any] = {"prompt": prompt, "aspect_ratio": aspect_ratio}
        if seed is not None and seed >= 0:
            body["seed"] = seed
        payload = _write_payload(Path(scratch), "payload.json", body)
        state = Path(scratch) / "state.json"
        return generation.generate_muapi_asset(
            endpoint=model, payload=payload, output=output, state=state,
            confirm=generation.PAID_GENERATION_CONFIRMATION,
        )


def _hosted(*, model: str, prompt: str, aspect_ratio: str, output: Path, **_: Any) -> dict[str, Any]:
    return generate_hosted_media_asset(
        model=model, payload={"prompt": prompt, "aspect_ratio": aspect_ratio}, output=output,
        agent_id="hivemind-content-studio", maximum_debit_usd=1.0,
        idempotency_key=uuid.uuid4().hex,
    )


def _media_studio(*, model: str, prompt: str, aspect_ratio: str, output: Path, seed: int | None, **_: Any) -> dict[str, Any]:
    # The MCP names its own output; the caller's `output` is only the directory
    # it should land in, which is why this one is shaped differently.
    result = generate_media_studio_image(
        prompt=prompt, workflow_id=model or None, aspect_ratio=aspect_ratio,
        seed=seed if seed is not None and seed >= 0 else None,
        output_dir=output.parent,
    )
    return {"provider": "media-studio-mcp", "model": model, "output": str(result.get("output") or result.get("path") or "")}


ROUTES: dict[str, Route] = {
    "openai-gpt-image": Route("openai-gpt-image", "OpenAI GPT Image (API key)", _openai_api),
    "openai-gpt-image-oauth": Route("openai-gpt-image-oauth", "OpenAI GPT Image (ChatGPT sign-in)", _openai_oauth, oauth="openai"),
    "xai-imagine-api": Route("xai-imagine-api", "xAI Imagine (API key)", _xai(generation.AUTH_MODE_API_KEY)),
    "xai-imagine-oauth": Route("xai-imagine-oauth", "xAI Imagine (sign-in)", _xai(generation.AUTH_MODE_OAUTH), oauth="xai"),
    "higgsfield-consumer": Route("higgsfield-consumer", "Higgsfield", _higgsfield_consumer),
    "higgsfield-cloud": Route("higgsfield-cloud", "Higgsfield Cloud", _higgsfield_cloud),
    "muapi": Route("muapi", "MUAPI", _muapi),
    "hivemindos-hosted-media": Route("hivemindos-hosted-media", "HivemindOS hosted", _hosted),
    "media-studio-mcp": Route("media-studio-mcp", "this machine’s Media Studio", _media_studio),
    # The catalog's name for the same route the MCP fronts.
    "comfyui": Route("comfyui", "this machine’s Media Studio", _media_studio),
}


def provider_ids() -> list[str]:
    return sorted(ROUTES)


def render_image(
    *,
    provider: str,
    model: str,
    prompt: str,
    aspect_ratio: str = "1:1",
    output: str | Path,
    quality: str = "",
    seed: int | None = None,
    routes: dict[str, Route] | None = None,
) -> dict[str, Any]:
    """Render one still with the generator that belongs to `provider`.

    Refuses an unknown provider rather than falling back to a default: a
    fallback here is a charge on the wrong account, and it is invisible until
    the bill arrives.
    """
    table = routes if routes is not None else ROUTES
    route = table.get(str(provider or "").strip())
    if route is None:
        raise ImageRouterError(
            f"No image route for provider '{provider}'. Known providers: {', '.join(sorted(table))}."
        )
    if not str(prompt or "").strip():
        raise ImageRouterError("Image generation requires a prompt")
    destination = Path(output).expanduser().resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        result = route.run(
            model=str(model or ""), prompt=prompt, aspect_ratio=aspect_ratio or "1:1",
            output=destination, quality=quality, seed=seed,
        )
    except ImageRouterError:
        raise
    except Exception as exc:  # noqa: BLE001 — every provider raises its own type
        # The provider's own words, with the account named AND the remedy
        # attached. "401" on its own does not say which of five credentials to
        # fix, and "Invalid refresh token." does not say to reconnect.
        remedy = "reconnect" if (route.oauth and needs_reauthorization(str(exc))) else ""
        raise ImageRouterError(
            f"{route.label}: {exc}", remedy=remedy, provider=route.oauth if remedy else "",
        ) from exc
    return {"provider": route.provider, "model": model, **(result if isinstance(result, dict) else {})}
