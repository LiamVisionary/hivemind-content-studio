"""Manifest-driven provider executors behind the intent/approval boundary."""

from __future__ import annotations

import json
import tempfile
import os
from pathlib import Path
from typing import Any, Callable

from .generation import (
    PAID_GENERATION_CONFIRMATION,
    generate_higgsfield_cloud_asset,
    generate_higgsfield_consumer_asset,
    generate_muapi_asset,
    generate_openai_image_asset,
    generate_openai_oauth_image_asset,
    generate_xai_imagine_asset,
    record_generated_asset,
)
from .manifest import load_manifest
from .media_studio import generate_video as generate_media_studio_video
from .private_access import (
    private_media_exists,
    read_private_json,
    read_private_media,
    write_private_json,
)
from .hivemindos_hosted_media import generate_hosted_media_asset


Generator = Callable[..., dict[str, Any]]


class ProviderExecutors:
    """Execute planned scene requests without leaking provider details into agents."""

    def __init__(
        self,
        *,
        higgsfield_consumer: Generator = generate_higgsfield_consumer_asset,
        higgsfield_cloud: Generator = generate_higgsfield_cloud_asset,
        muapi: Generator = generate_muapi_asset,
        hivemindos_hosted: Generator = generate_hosted_media_asset,
        media_studio: Generator = generate_media_studio_video,
        openai_image: Generator = generate_openai_image_asset,
        openai_oauth_image: Generator = generate_openai_oauth_image_asset,
        xai_imagine: Generator = generate_xai_imagine_asset,
    ):
        self.higgsfield_consumer = higgsfield_consumer
        self.higgsfield_cloud = higgsfield_cloud
        self.muapi = muapi
        self.hivemindos_hosted = hivemindos_hosted
        self.media_studio = media_studio
        self.openai_image = openai_image
        self.openai_oauth_image = openai_oauth_image
        self.xai_imagine = xai_imagine

    def as_intent_executors(self) -> dict[tuple[str, str], Callable[[str], dict[str, Any]]]:
        providers = (
            "higgsfield-consumer",
            "higgsfield-cloud",
            "hivemindos-hosted-media",
            "muapi",
            "openai-gpt-image",
            "openai-gpt-image-oauth",
            "xai-imagine-api",
            "xai-imagine-oauth",
        )
        executors = {
            ("generate_keyframes", provider): lambda manifest, authorization=None, selected=provider: self.generate_keyframes(manifest, selected, authorization=authorization)
            for provider in providers
        }
        for provider in (*providers, "media-studio-mcp"):
            executors[("animate_scenes", provider)] = lambda manifest, authorization=None, selected=provider: self.animate_scenes(manifest, selected, authorization=authorization)
        return executors

    def generate_keyframes(self, manifest_path: str | Path, provider: str, *, authorization: dict[str, Any] | None = None) -> dict[str, Any]:
        return self._execute_requests(manifest_path, provider, request_role="keyframe-requests", output_role="keyframe", kind="keyframe", authorization=authorization)

    def animate_scenes(self, manifest_path: str | Path, provider: str, *, authorization: dict[str, Any] | None = None) -> dict[str, Any]:
        return self._execute_requests(manifest_path, provider, request_role="motion-requests", output_role="scene-video", kind="motion", authorization=authorization)

    def _execute_requests(self, manifest_path: str | Path, provider: str, *, request_role: str, output_role: str, kind: str, authorization: dict[str, Any] | None = None) -> dict[str, Any]:
        manifest_file = Path(manifest_path).expanduser().resolve()
        manifest = load_manifest(manifest_file)
        request_artifact = next((item for item in manifest["artifacts"] if item["role"] == request_role), None)
        if not request_artifact:
            raise ValueError(f"Run has no {request_role} contract")
        requests = read_private_json(Path(request_artifact["path"]))
        if not isinstance(requests, list):
            raise ValueError(f"{request_role} must contain a JSON list")
        existing = {
            int(item["scene"])
            for item in manifest["artifacts"]
            if item.get("role") == output_role and item.get("scene") is not None
        }
        outputs: list[str] = []
        for raw in requests:
            if not isinstance(raw, dict):
                continue
            scene = int(raw.get("scene") or 0)
            if scene <= 0 or scene in existing:
                continue
            staged: list[Path] = []
            try:
                result = self._execute_scene(manifest_file, manifest, raw, provider, kind=kind, authorization=authorization or {}, staged=staged)
            finally:
                for item in staged:
                    item.unlink(missing_ok=True)
            record_generated_asset(manifest_file, result, role=output_role, scene=scene)
            outputs.append(str(result["output"]))
        return {"provider": provider, "artifacts": outputs}

    def _execute_scene(self, manifest_file: Path, manifest: dict[str, Any], request: dict[str, Any], provider: str, *, kind: str, authorization: dict[str, Any], staged: list[Path]) -> dict[str, Any]:
        scene = int(request["scene"])
        extension = ".png" if kind == "keyframe" else ".mp4"
        output_dir = manifest_file.parent / ("keyframes" if kind == "keyframe" else "scene-videos")
        output_dir.mkdir(parents=True, exist_ok=True)
        output = output_dir / f"{provider}-{scene:03d}{extension}"
        prompt = str(request.get("prompt") or "").strip()
        aspect_ratio = str(request.get("aspect_ratio") or manifest["brief"].get("aspect_ratio") or "9:16")
        options = _provider_options(manifest, provider)
        generation_options = _studio_generation_options(manifest)
        if provider == "higgsfield-consumer":
            model = _selected_model(options, kind, "gpt_image_2" if kind == "keyframe" else "seedance_2_0")
            source = self._source_path(manifest, scene, staged) if kind == "motion" else None
            return self.higgsfield_consumer(
                kind=kind,
                model=model,
                prompt=prompt,
                aspect_ratio=aspect_ratio,
                output=output,
                source=source,
                duration_seconds=float(request.get("duration_seconds") or 4) if kind == "motion" else None,
                confirm=PAID_GENERATION_CONFIRMATION,
            )
        if provider in {"openai-gpt-image", "openai-gpt-image-oauth"}:
            if kind != "keyframe":
                raise ValueError("OpenAI GPT Image does not provide scene motion")
            model = _selected_model(options, kind, "gpt-image-2")
            generator = self.openai_oauth_image if provider.endswith("oauth") else self.openai_image
            return generator(
                prompt=prompt,
                model=model,
                aspect_ratio=aspect_ratio,
                quality=str(options.get("quality") or "medium"),
                output=output,
                confirm=PAID_GENERATION_CONFIRMATION,
            )
        if provider in {"xai-imagine-api", "xai-imagine-oauth"}:
            model = _selected_model(options, kind, "grok-imagine-image-quality" if kind == "keyframe" else "grok-imagine-video")
            return self.xai_imagine(
                kind=kind,
                auth_mode="oauth" if provider.endswith("oauth") else "api-key",
                prompt=prompt,
                model=model,
                aspect_ratio=aspect_ratio,
                output=output,
                source=self._source_path(manifest, scene, staged) if kind == "motion" else None,
                duration_seconds=float(request.get("duration_seconds") or 5) if kind == "motion" else None,
                resolution=str(options.get(f"{kind}_resolution") or ("1k" if kind == "keyframe" else "720p")),
                confirm=PAID_GENERATION_CONFIRMATION,
            )
        if provider == "higgsfield-cloud":
            model = _selected_model(options, kind, "higgsfield-ai/soul/standard" if kind == "keyframe" else "higgsfield-ai/dop/standard")
            payload: dict[str, Any] = {"prompt": prompt, "aspect_ratio": aspect_ratio}
            if kind == "motion":
                source_url = self._source_url(manifest, scene)
                if not source_url:
                    raise ValueError("Higgsfield Cloud motion requires a public source_url artifact or an explicit upload integration")
                payload.update({"image_url": source_url, "duration": float(request.get("duration_seconds") or 4)})
            payload.update(options.get(f"{kind}_payload") if isinstance(options.get(f"{kind}_payload"), dict) else {})
            payload_path = output.with_suffix(".payload.json")
            write_private_json(payload_path, payload)
            return self.higgsfield_cloud(model_id=model, payload=payload_path, output=output, confirm=PAID_GENERATION_CONFIRMATION)
        if provider == "muapi":
            contract = options.get(kind) if isinstance(options.get(kind), dict) else {}
            endpoint = str(contract.get("endpoint") or "").strip()
            template = contract.get("payload") if isinstance(contract.get("payload"), dict) else None
            if not endpoint or template is None:
                raise ValueError(f"MUAPI {kind} requires explicit provider_options.muapi.{kind}.endpoint and payload after live schema discovery")
            values = {
                "prompt": prompt,
                "aspect_ratio": aspect_ratio,
                "duration_seconds": request.get("duration_seconds") or 4,
                "source_url": self._source_url(manifest, scene) or "",
                "seed": generation_options.get("seed"),
                "seed_mode": generation_options.get("seed_mode", "randomize"),
            }
            payload = _format_template(template, values)
            payload_path = output.with_suffix(".payload.json")
            state_path = manifest_file.parent / "muapi-state.json"
            write_private_json(payload_path, payload)
            return self.muapi(endpoint=endpoint, payload=payload_path, output=output, state=state_path, confirm=PAID_GENERATION_CONFIRMATION)
        if provider == "hivemindos-hosted-media":
            contract = options.get(kind) if isinstance(options.get(kind), dict) else {}
            model = str(contract.get("model") or "").strip()
            template = contract.get("payload") if isinstance(contract.get("payload"), dict) else None
            if not model or template is None:
                raise ValueError(f"HivemindOS hosted media {kind} requires explicit provider_options.hivemindos-hosted-media.{kind}.model and payload after catalog/schema discovery")
            maximum_debit_usd = float(authorization.get("maximum_debit_usd") or 0)
            if maximum_debit_usd <= 0:
                raise ValueError("HivemindOS hosted media requires a positive quoted maximum debit bound to the intent execution")
            values = {
                "prompt": prompt,
                "aspect_ratio": aspect_ratio,
                "duration_seconds": request.get("duration_seconds") or 4,
                "source_url": self._source_url(manifest, scene) or "",
                "seed": generation_options.get("seed"),
                "seed_mode": generation_options.get("seed_mode", "randomize"),
            }
            payload = _format_template(template, values)
            agent_id = str(
                options.get("agent_id")
                or authorization.get("agent_id")
                or os.environ.get("HIVEMINDOS_CONTENT_STUDIO_AGENT_ID")
                or "content-studio"
            ).strip()
            run_id = str(manifest.get("run_id") or manifest_file.parent.name)
            return self.hivemindos_hosted(
                model=model,
                payload=payload,
                output=output,
                agent_id=agent_id,
                maximum_debit_usd=maximum_debit_usd,
                idempotency_key=f"{run_id}:{kind}:{scene}:{model}",
            )
        if provider == "media-studio-mcp" and kind == "motion":
            workflow_id = str(
                _role_options(options, kind).get("workflow_id")
                or options.get("workflow_id")
                or _role_options(options, kind).get("model")
                or options.get("model")
                or ""
            ).strip()
            return self.media_studio(
                image_path=self._source_path(manifest, scene, staged),
                prompt=prompt,
                duration_seconds=float(request.get("duration_seconds") or 4),
                workflow_id=workflow_id or None,
                output_dir=output_dir,
            )
        raise ValueError(f"No manifest executor exists for {provider!r} and {kind!r}")

    @staticmethod
    def _source_path(manifest: dict[str, Any], scene: int, staged: list[Path]) -> str:
        artifact = next(
            (item for item in reversed(manifest["artifacts"]) if item.get("role") == "keyframe" and int(item.get("scene") or 0) == scene),
            None,
        )
        source = Path(str(artifact.get("path") or "")) if artifact else None
        if source is None or not private_media_exists(source):
            raise ValueError(f"Scene {scene} requires a recorded local keyframe")
        if source.is_file():
            return str(source)
        # Encrypted at rest: stage a plaintext copy for the generator; the
        # caller unlinks everything in `staged` once the scene completes.
        body = read_private_media(source)
        descriptor, name = tempfile.mkstemp(prefix=f".staged-{source.stem}-", suffix=source.suffix, dir=source.parent)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(body)
        staged.append(Path(name))
        return name

    @staticmethod
    def _source_url(manifest: dict[str, Any], scene: int) -> str | None:
        artifact = next(
            (item for item in reversed(manifest["artifacts"]) if item.get("role") == "keyframe" and int(item.get("scene") or 0) == scene),
            None,
        )
        return str(artifact.get("source_url")) if artifact and artifact.get("source_url") else None


def _provider_options(manifest: dict[str, Any], provider: str) -> dict[str, Any]:
    all_options = manifest.get("brief", {}).get("provider_options")
    if not isinstance(all_options, dict):
        return {}
    value = all_options.get(provider)
    return value if isinstance(value, dict) else {}


def _studio_generation_options(manifest: dict[str, Any]) -> dict[str, Any]:
    all_options = manifest.get("brief", {}).get("provider_options")
    if not isinstance(all_options, dict):
        return {}
    value = all_options.get("_studio_generation")
    return value if isinstance(value, dict) else {}


def _role_options(options: dict[str, Any], kind: str) -> dict[str, Any]:
    value = options.get(kind)
    return value if isinstance(value, dict) else {}


def _selected_model(options: dict[str, Any], kind: str, fallback: str) -> str:
    role_options = _role_options(options, kind)
    for value in (
        role_options.get("model"),
        options.get(f"{kind}_model"),
        options.get("model"),
    ):
        if isinstance(value, (str, int, float)) and str(value).strip():
            return str(value).strip()
    return fallback


def _format_template(value: Any, variables: dict[str, Any]) -> Any:
    if isinstance(value, str):
        if value in {"{prompt}", "{aspect_ratio}", "{duration_seconds}", "{source_url}", "{seed}", "{seed_mode}"}:
            return variables[value[1:-1]]
        return value.format_map({key: str(item) for key, item in variables.items()})
    if isinstance(value, list):
        return [_format_template(item, variables) for item in value]
    if isinstance(value, dict):
        return {str(key): _format_template(item, variables) for key, item in value.items()}
    return value
