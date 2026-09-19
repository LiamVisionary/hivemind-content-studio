"""OpenAI-compatible local or Tailnet TTS adapter."""

from __future__ import annotations

import contextlib
import json
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

from .config import load_config
from .manifest import add_artifact, load_manifest, write_manifest
from .private_access import encrypt_private_media


def _http_error_detail(exc: urllib.error.HTTPError) -> str:
    """Whatever the server said, trimmed to one readable sentence."""
    try:
        body = exc.read().decode("utf-8", "replace").strip()
    except Exception:  # noqa: BLE001 — a body is a bonus, never the failure
        return exc.reason or "no detail"
    try:
        parsed = json.loads(body)
    except json.JSONDecodeError:
        return (body[:300] or exc.reason or "no detail")
    if isinstance(parsed, dict):
        for key in ("detail", "error", "message"):
            if parsed.get(key):
                return str(parsed[key])[:300].strip("'\"")
    return body[:300]


def _json_get(path: str) -> dict[str, Any]:
    base = load_config().universal_tts_url
    request = urllib.request.Request(f"{base}{path}", method="GET", headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            value = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"Universal TTS discovery failed with HTTP {exc.code}") from None
    if not isinstance(value, dict):
        raise RuntimeError("Universal TTS returned an unexpected discovery response")
    return value


def list_local_voices() -> list[dict[str, Any]]:
    value = _json_get("/v1/voices")
    rows = value.get("data") if isinstance(value.get("data"), list) else value.get("voices")
    return [row for row in (rows or []) if isinstance(row, dict)]


def list_local_voice_models() -> list[dict[str, Any]]:
    value = _json_get("/v1/models")
    rows = value.get("data") if isinstance(value.get("data"), list) else value.get("models")
    return [row for row in (rows or []) if isinstance(row, dict)]


def list_provider_voices(provider_id: str) -> list[dict[str, Any]]:
    """The voices one engine actually offers, rather than the whole server's."""
    value = _json_get(f"/v1/audio/{urllib.parse.quote(provider_id)}/voices")
    rows = value.get("data") if isinstance(value.get("data"), list) else value.get("voices")
    return [row for row in (rows or []) if isinstance(row, dict)]


# The providers whose model/voice ids this server understands. Anything else
# names a cloud engine, and its ids are meaningless here.
LOCAL_VOICE_PROVIDERS = {"universal-tts", "localtts", "local"}


def _is_placeholder(value: str) -> bool:
    """A brief slot nobody filled in, e.g. `<set-per-run-voice-id>`."""
    text = value.strip()
    return text.startswith("<") and text.endswith(">")


def resolve_local_voice(voice: dict[str, Any]) -> tuple[str, str]:
    """The model and voice to synthesize with, both real ids on the server.

    "default" is not an id the TTS server knows. Sending it as the model got a
    404 ("unknown model/provider: default") and sending it as the voice got a
    500, so a brief that did not name both by hand could not produce a single
    line. The server publishes what it has; ask it rather than guessing a
    sentinel, and only fall back to the literal when discovery itself fails —
    at which point the server's own error is the honest answer.
    """
    model_id = str(voice.get("model_id") or "").strip()
    voice_id = str(voice.get("voice_id") or voice.get("name") or "").strip()
    # A brief writes ONE voice block, and the router may not pick the provider
    # it was written for: the shipped stickman brief names ElevenLabs, and on a
    # local-first, zero-budget policy the router selects universal-tts and was
    # then handed "eleven_v3" as a local model id. Ids only mean something to
    # the engine they were written for.
    provider = str(voice.get("provider") or "").strip().lower()
    if provider and provider not in LOCAL_VOICE_PROVIDERS:
        model_id, voice_id = "", ""
    # Template placeholders are not ids either — they are an instruction to the
    # operator that nobody carried out.
    model_id = "" if _is_placeholder(model_id) else model_id
    voice_id = "" if _is_placeholder(voice_id) else voice_id
    if model_id and voice_id:
        return model_id, voice_id
    models: list[dict[str, Any]] = []
    try:
        models = list_local_voice_models()
    except RuntimeError:
        models = []
    if not model_id:
        # A model already resident answers immediately; a cold one pays a load
        # the caller did not ask for.
        chosen = next((row for row in models if row.get("loaded") and row.get("id")), None)
        chosen = chosen or next((row for row in models if row.get("id")), None)
        model_id = str((chosen or {}).get("id") or "").strip()
    if not voice_id and model_id:
        # Voices belong to a PROVIDER, not to the whole server: the flat list
        # mixes every engine's names together, so picking off it can hand a
        # kitten model a qwen voice. Scope the lookup to the chosen model.
        provider = next(
            (str(row.get("provider") or "").strip() for row in models if row.get("id") == model_id),
            "",
        )
        if provider:
            with contextlib.suppress(RuntimeError):
                voice_id = next(
                    (str(row.get("id") or "").strip() for row in list_provider_voices(provider) if row.get("id")),
                    "",
                )
        if not voice_id:
            with contextlib.suppress(RuntimeError):
                voice_id = next(
                    (str(row.get("id") or "").strip() for row in list_local_voices() if row.get("id")),
                    "",
                )
    if not model_id or not voice_id:
        raise RuntimeError(
            "The local TTS server published no usable model/voice pair — name voice.model_id "
            f"and voice.voice_id in the brief, or check {load_config().universal_tts_url}/v1/models"
        )
    return model_id, voice_id


def generate_local_voice_lines(manifest_path: str | Path) -> dict[str, Any]:
    manifest_file = Path(manifest_path).expanduser().resolve()
    manifest = load_manifest(manifest_file)
    voice = manifest.get("brief", {}).get("voice") if isinstance(manifest.get("brief", {}).get("voice"), dict) else {}
    model_id, voice_id = resolve_local_voice(voice)
    response_format = str(voice.get("response_format") or "wav").lower()
    if response_format not in {"wav", "mp3", "ogg", "flac"}:
        raise ValueError("Unsupported local TTS response format")
    output_dir = manifest_file.parent / "voice" / "universal-tts"
    output_dir.mkdir(parents=True, exist_ok=True)
    manifest["artifacts"] = [item for item in manifest["artifacts"] if not (item["role"] == "voice-line" and item.get("provider") == "universal-tts")]
    files: list[str] = []
    scenes = manifest.get("brief", {}).get("scenes") or []
    for index, raw in enumerate(scenes, start=1):
        scene = raw if isinstance(raw, dict) else {"beat": str(raw)}
        text = str(scene.get("voice") or scene.get("beat") or "").strip()
        if not text:
            continue
        payload = {
            "model": model_id,
            "input": text,
            "voice": voice_id,
            "response_format": response_format,
            **({"language": voice["language"]} if voice.get("language") else {}),
            **({"instruct": scene.get("delivery") or voice["delivery"]} if scene.get("delivery") or voice.get("delivery") else {}),
        }
        request = urllib.request.Request(
            f"{load_config().universal_tts_url}/v1/audio/speech",
            data=json.dumps(payload).encode("utf-8"),
            method="POST",
            headers={"Content-Type": "application/json", "Accept": f"audio/{response_format}"},
        )
        try:
            with urllib.request.urlopen(request, timeout=300) as response:
                audio = response.read()
        except urllib.error.HTTPError as exc:
            # The server says exactly what it refused ("unknown model/provider:
            # default"); a bare status code makes the caller guess which of the
            # model, the voice, or the format was wrong.
            raise RuntimeError(
                f"Universal TTS refused scene {index} (HTTP {exc.code}) for model {model_id!r} "
                f"voice {voice_id!r}: {_http_error_detail(exc)}"
            ) from None
        if len(audio) < 16:
            raise RuntimeError(f"Universal TTS returned empty or invalid audio for scene {index}")
        path = output_dir / f"scene-{index:03d}.{response_format}"
        path.write_bytes(audio)
        files.append(str(path))
        add_artifact(manifest, role="voice-line", path=path, provider="universal-tts", scene=index, model=model_id)
        encrypt_private_media(path)
    write_manifest(manifest_file, manifest)
    return {"provider": "universal-tts", "model": model_id, "voice": voice_id, "audio_files": files}
