"""Exact-line voice generation adapters."""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from .generation import require_paid_generation
from .manifest import add_artifact, load_manifest, write_manifest


def generate_elevenlabs_lines(manifest_path: str | Path, *, confirm: str) -> dict[str, Any]:
    require_paid_generation(confirm)
    api_key = os.environ.get("ELEVENLABS_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("ELEVENLABS_API_KEY is missing")
    manifest_file = Path(manifest_path).expanduser().resolve()
    manifest = load_manifest(manifest_file)
    voice = manifest["brief"].get("voice") if isinstance(manifest["brief"].get("voice"), dict) else {}
    voice_id = str(voice.get("voice_id") or "").strip()
    if not voice_id:
        raise ValueError("Brief voice.voice_id is required for ElevenLabs")
    model_id = str(voice.get("model_id") or "eleven_v3")
    delivery = str(voice.get("delivery") or "natural, clear, platform-ready delivery")
    base_url = os.environ.get("ELEVENLABS_API_BASE_URL", "https://api.elevenlabs.io/v1").rstrip("/")
    output_dir = manifest_file.parent / "voice" / "elevenlabs"
    output_dir.mkdir(parents=True, exist_ok=True)
    manifest["artifacts"] = [item for item in manifest["artifacts"] if not (item["role"] == "voice-line" and item.get("provider") == "elevenlabs")]
    generated: list[str] = []
    scenes = manifest["brief"].get("scenes") if isinstance(manifest["brief"].get("scenes"), list) else []
    for index, raw_scene in enumerate(scenes, start=1):
        scene = raw_scene if isinstance(raw_scene, dict) else {"beat": str(raw_scene)}
        text = str(scene.get("voice") or scene.get("beat") or "").strip()
        if not text:
            continue
        payload = {
            "text": text,
            "model_id": model_id,
            "voice_settings": {
                "stability": float(voice.get("stability", 0.55)),
                "similarity_boost": float(voice.get("similarity_boost", 0.85)),
                "style": float(voice.get("style", 0.2)),
                "use_speaker_boost": bool(voice.get("use_speaker_boost", True)),
            },
            "voice_prompt": str(scene.get("delivery") or delivery),
        }
        request = urllib.request.Request(
            f"{base_url}/text-to-speech/{voice_id}",
            data=json.dumps(payload).encode("utf-8"),
            headers={"xi-api-key": api_key, "Content-Type": "application/json", "Accept": "audio/mpeg"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=180) as response:
                audio = response.read()
        except urllib.error.HTTPError as exc:
            raise RuntimeError(f"ElevenLabs generation failed with HTTP {exc.code}") from None
        if not audio:
            raise RuntimeError(f"ElevenLabs returned empty audio for scene {index}")
        output = output_dir / f"scene-{index:03d}.mp3"
        output.write_bytes(audio)
        generated.append(str(output))
        add_artifact(manifest, role="voice-line", path=output, provider="elevenlabs")
    write_manifest(manifest_file, manifest)
    return {"provider": "elevenlabs", "model": model_id, "audio_files": generated}
