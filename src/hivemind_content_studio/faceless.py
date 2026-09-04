"""Adapter from the canonical manifest to the MoneyPrinterTurbo engine."""

from __future__ import annotations

import shutil
from pathlib import Path

from app.models.schema import VideoParams
from app.services import task

from .config import load_config
from .faceless_media import generate_faceless_materials, is_studio_media_source
from .manifest import add_artifact, load_manifest, write_manifest
from .private_access import encrypt_private_media, read_private_json


def render_faceless(manifest_path: str | Path) -> dict:
    path = Path(manifest_path).expanduser().resolve()
    manifest = load_manifest(path)
    if manifest.get("lane") != "faceless":
        raise ValueError("Manifest lane must be faceless")
    params_path = _artifact_path(manifest, "faceless-params")
    params = VideoParams(**read_private_json(params_path))

    # A generated source renders its own visuals first, then hands them to the
    # engine as owned local material. Everything else (stock search, a folder of
    # owned files) reaches the engine exactly as upstream expects.
    brief = manifest.get("brief") if isinstance(manifest.get("brief"), dict) else {}
    if is_studio_media_source(brief.get("media_source")):
        params.video_source = "local"
        params.video_materials = generate_faceless_materials(path)
    _point_local_tts_at_the_studio_server()
    _refresh_engine_credentials()

    result = task.start(manifest["run_id"], params, stop_at="video")
    if not isinstance(result, dict) or not result.get("videos"):
        raise RuntimeError(_engine_failure(manifest["run_id"]))
    companions = _engine_companions(result, manifest["run_id"])
    for video in result["videos"]:
        # The engine owns its own storage root, so a faceless final never lands
        # under the run directory — and while the seal was conditional on that,
        # this was the one lane whose output (plus its narration and subtitles)
        # stayed in plain sight while every other lane's was sealed. Move it
        # into the run first, then seal it like everything else.
        video_path = _adopt_into_run(Path(video).expanduser().resolve(), path.parent)
        add_artifact(manifest, role="final-video", path=video_path, provider="moneyprinterturbo")
        encrypt_private_media(video_path)
    for companion, role in companions:
        if not companion.is_file():
            continue
        adopted = _adopt_into_run(companion, path.parent)
        add_artifact(manifest, role=role, path=adopted, provider="moneyprinterturbo")
        encrypt_private_media(adopted)
    _clear_engine_directory(result, manifest["run_id"])
    manifest["status"] = "rendered"
    write_manifest(path, manifest)
    return {**result, "videos": [str(item) for item in _run_videos(manifest)]}


def _point_local_tts_at_the_studio_server() -> None:
    """Make the engine's `localtts:` backend the studio's own TTS server.

    Upstream defaults this to a hard-coded host that is not this machine, so a
    `localtts:` voice would be synthesized somewhere else or not at all. The
    studio already knows where its TTS lives; one assignment keeps both halves
    talking to the same server instead of adding a second setting to keep
    in sync.
    """
    from app.config import config

    config.app["localtts_base_url"] = load_config().universal_tts_url.rstrip("/")


def _refresh_engine_credentials() -> None:
    """Fill the engine's provider keys from the machine's shared store.

    The engine keeps its own `config.toml` with its own `pexels_api_keys` /
    `pixabay_api_keys` / LLM key fields, and it reads that file once, at import.
    So a stock-media key the owner saved into the shared credential store while
    the studio was running never reached this lane, and the render died on
    "pexels_api_keys is not set" pointing at a second store to fill in. One
    re-read at run start keeps the machine at ONE credential store.
    """
    from app.config import config

    config.refresh_hive_env()


def _adopt_into_run(source: Path, run_dir: Path) -> Path:
    """Bring an engine output inside the run directory, so run privacy covers it."""
    if source.is_relative_to(run_dir):
        return source
    destination = run_dir / source.name
    if destination.exists():
        destination.unlink()
    shutil.move(str(source), destination)
    return destination


def _engine_companions(result: dict, run_id: str) -> list[tuple[Path, str]]:
    """The narration and subtitles the engine wrote beside the video.

    They carry the script verbatim. Sealing the final and leaving these next to
    it in plaintext would only move the exposure.
    """
    found: list[tuple[Path, str]] = []
    roots = {Path(str(video)).expanduser().resolve().parent for video in result.get("videos") or []}
    for root in roots:
        if root.name != run_id:
            continue
        for name, role in (("audio.mp3", "narration-audio"), ("subtitle.srt", "subtitles")):
            candidate = root / name
            if candidate.is_file():
                found.append((candidate, role))
        # The pre-subtitle render carries the whole picture, so leaving it
        # behind would undo the sealing of everything beside it.
        for candidate in sorted(root.glob("combined-*.mp4")):
            found.append((candidate, "intermediate-video"))
    return found


def _clear_engine_directory(result: dict, run_id: str) -> None:
    """Remove the engine's working directory once its media is inside the run.

    Anything still there is a copy of media that has just been sealed, so it is
    the one place a faceless render could leave plaintext behind.
    """
    for video in result.get("videos") or []:
        root = Path(str(video)).expanduser().resolve().parent
        if root.name == run_id and root.is_dir():
            shutil.rmtree(root, ignore_errors=True)


def _run_videos(manifest: dict) -> list[Path]:
    return [
        Path(item["path"])
        for item in manifest.get("artifacts", [])
        if item.get("role") == "final-video"
    ]


def _engine_failure(run_id: str) -> str:
    """Why the engine stopped, in its own words where it recorded them.

    "did not return final video paths" is true and useless — the engine had
    already written "failed to synthesize audio; verify the selected voice and
    TTS connectivity", and that is the sentence someone can act on.
    """
    try:
        from app.services import state as task_state

        recorded = task_state.state.get_task(run_id) or {}
    except Exception:  # noqa: BLE001 — the reason is a bonus, never the failure
        recorded = {}
    reason = str(recorded.get("error") or recorded.get("message") or "").strip()
    stage = str(recorded.get("stage") or "").strip()
    if reason:
        return f"The faceless engine stopped{f' at the {stage} stage' if stage else ''}: {reason}"
    return "MoneyPrinterTurbo produced no final video and recorded no reason; check the engine log for this run"


def _artifact_path(manifest: dict, role: str) -> Path:
    for artifact in manifest.get("artifacts", []):
        if artifact.get("role") == role:
            return Path(artifact["path"])
    raise ValueError(f"Manifest is missing {role} artifact")
