"""OpenAI-compatible local or Tailnet TTS adapter."""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from .config import load_config
from .manifest import add_artifact, load_manifest, write_manifest


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


def generate_local_voice_lines(manifest_path: str | Path) -> dict[str, Any]:
    manifest_file = Path(manifest_path).expanduser().resolve()
    manifest = load_manifest(manifest_file)
    voice = manifest.get("brief", {}).get("voice") if isinstance(manifest.get("brief", {}).get("voice"), dict) else {}
    model_id = str(voice.get("model_id") or "default")
    voice_id = str(voice.get("voice_id") or voice.get("name") or "default")
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
            raise RuntimeError(f"Universal TTS generation failed with HTTP {exc.code}") from None
        if len(audio) < 16:
            raise RuntimeError(f"Universal TTS returned empty or invalid audio for scene {index}")
        path = output_dir / f"scene-{index:03d}.{response_format}"
        path.write_bytes(audio)
        files.append(str(path))
        add_artifact(manifest, role="voice-line", path=path, provider="universal-tts", scene=index, model=model_id)
    write_manifest(manifest_file, manifest)
    return {"provider": "universal-tts", "model": model_id, "voice": voice_id, "audio_files": files}
