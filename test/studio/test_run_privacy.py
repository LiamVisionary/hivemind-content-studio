"""Prompts, prompt metadata, and run history stay encrypted and token-gated."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from fastapi.testclient import TestClient

from hivemind_content_studio.control_api import build_control_app
from hivemind_content_studio.manifest import load_manifest
from hivemind_content_studio.orchestrator import ContentOrchestrator
from hivemind_content_studio.planner import plan
from hivemind_content_studio.private_access import (
    ENCRYPTED_PREFIX,
    OwnerAccess,
    PrivateFieldCipher,
    read_private_media,
    read_private_text,
)
from hivemind_content_studio.prompt_history import PromptHistoryStore
from hivemind_content_studio.run_privacy import migrate_private_runs
from hivemind_content_studio.run_store import RunStore


SECRET_TITLE = "A very private concept nobody else may read"
LEGACY_MEDIA_BYTES = b"\x89PNG\r\n\x1a\nnot-a-real-frame-but-private-bytes"


def _plan_run(tmp_path: Path, monkeypatch) -> Path:
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))
    brief = tmp_path / "brief.yaml"
    brief.write_text(
        f"id: private-brief\nlane: first-frame-animation-ad\ntitle: {SECRET_TITLE}\n"
        "scenes:\n  - beat: Secret scene beat text.\n    voice: Secret voice line.\n",
        encoding="utf-8",
    )
    return plan(brief)


def test_run_ids_and_directories_never_contain_prompt_text(tmp_path: Path, monkeypatch) -> None:
    manifest_path = _plan_run(tmp_path, monkeypatch)
    run_dir_name = manifest_path.parent.name
    assert "private" not in run_dir_name.lower()
    assert "concept" not in run_dir_name.lower()
    assert run_dir_name.split("Z-", 1)[1].startswith("first-frame-animation-ad-")


def test_manifest_private_sections_are_encrypted_at_rest(tmp_path: Path, monkeypatch) -> None:
    manifest_path = _plan_run(tmp_path, monkeypatch)
    raw = json.loads(manifest_path.read_text(encoding="utf-8"))
    for key in ("brief", "publish"):
        assert isinstance(raw[key], str) and raw[key].startswith(ENCRYPTED_PREFIX), key
    assert SECRET_TITLE not in manifest_path.read_text(encoding="utf-8")
    decrypted = load_manifest(manifest_path)
    assert decrypted["brief"]["title"] == SECRET_TITLE


def test_planned_prompt_sidecar_files_are_encrypted_at_rest(tmp_path: Path, monkeypatch) -> None:
    manifest_path = _plan_run(tmp_path, monkeypatch)
    run_dir = manifest_path.parent
    for name in (
        "brief.yaml",
        "scene_manifest.csv",
        "image-prompts.md",
        "motion-prompts.md",
        "voice-lines.md",
        "music-brief.md",
        "script-request.json",
        "keyframe-requests.json",
        "motion-requests.json",
        "publish-metadata.json",
    ):
        body = (run_dir / name).read_text(encoding="utf-8")
        assert body.startswith(ENCRYPTED_PREFIX), name
        assert "Secret" not in body, name
    assert "Secret scene beat text." in read_private_text(run_dir / "image-prompts.md")


def _legacy_run(tmp_path: Path) -> tuple[Path, Path, str]:
    runs_dir = tmp_path / "runs"
    old_run_id = "20260101T000000000000Z-a-very-private-concept-nobody-else-may-read"
    run_dir = runs_dir / old_run_id
    run_dir.mkdir(parents=True)
    brief = {"title": SECRET_TITLE, "scenes": [{"beat": "Secret scene beat text."}]}
    (run_dir / "brief.yaml").write_text(f"title: {SECRET_TITLE}\n", encoding="utf-8")
    (run_dir / "image-prompts.md").write_text("## Scene 1\n\nSecret scene beat text.\n", encoding="utf-8")
    (run_dir / "keyframes").mkdir()
    (run_dir / "keyframes" / "scene-001.png").write_bytes(LEGACY_MEDIA_BYTES)
    manifest = {
        "schema_version": 2,
        "revision": 3,
        "run_id": old_run_id,
        "lane": "animation",
        "status": "completed",
        "created_at": "2026-01-01T00:00:00+00:00",
        "updated_at": "2026-01-01T00:00:00+00:00",
        "brief": brief,
        "studio": {"user_prompt": "Secret user prompt"},
        "providers": {"image": "comfyui"},
        "artifacts": [
            {
                "id": "art_1",
                "role": "brief",
                "path": str(run_dir / "brief.yaml"),
                "provider": None,
                "sha256": "",
                "size_bytes": 1,
                "mime_type": "text/yaml",
                "created_at": "2026-01-01T00:00:00+00:00",
                "depends_on": [],
            },
            {
                "id": "art_2",
                "role": "keyframe",
                "path": str(run_dir / "keyframes" / "scene-001.png"),
                "provider": "stickman-renderer",
                "sha256": "",
                "size_bytes": len(LEGACY_MEDIA_BYTES),
                "mime_type": "image/png",
                "created_at": "2026-01-01T00:00:00+00:00",
                "depends_on": [],
            },
        ],
        "approval": {"status": "pending", "reviewer": None, "rights_note": None, "approved_at": None},
        "publish": {"drafts": [], "receipts": []},
    }
    manifest_path = run_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    store = RunStore(tmp_path / "state.sqlite3")
    store.create_run(run_id=old_run_id, manifest_path=manifest_path, lane="animation", steps=["script"], policy={}, budget={})
    store.append_event(old_run_id, "step.blocked", {"manifest_path": str(manifest_path)})
    history = PromptHistoryStore(tmp_path / "prompt-history.sqlite3", cipher=PrivateFieldCipher.from_secret(b"test-private-state-secret"))
    history.record(prompt="Secret user prompt", run_id=old_run_id)
    return runs_dir, manifest_path, old_run_id


def test_migration_renames_encrypts_and_rewires_legacy_runs(tmp_path: Path, monkeypatch) -> None:
    runs_dir, _, old_run_id = _legacy_run(tmp_path)

    counts = migrate_private_runs(runs_dir=runs_dir, store_path=tmp_path / "state.sqlite3")

    assert counts["renamed"] == 1
    assert counts["manifests_sealed"] == 1
    assert counts["files_encrypted"] >= 2
    remaining = [item.name for item in runs_dir.iterdir() if item.is_dir()]
    assert len(remaining) == 1
    new_run_id = remaining[0]
    assert "private" not in new_run_id and new_run_id.split("Z-", 1)[1].startswith("animation-")

    new_dir = runs_dir / new_run_id
    raw_manifest = (new_dir / "manifest.json").read_text(encoding="utf-8")
    assert SECRET_TITLE not in raw_manifest and old_run_id not in raw_manifest
    manifest = load_manifest(new_dir / "manifest.json")
    assert manifest["run_id"] == new_run_id
    assert manifest["brief"]["title"] == SECRET_TITLE
    assert Path(manifest["artifacts"][0]["path"]) == new_dir / "brief.yaml"
    for name in ("brief.yaml", "image-prompts.md"):
        assert (new_dir / name).read_text(encoding="utf-8").startswith(ENCRYPTED_PREFIX)

    assert counts["media_encrypted"] == 1
    keyframe = new_dir / "keyframes" / "scene-001.png"
    assert not keyframe.is_file()
    assert (new_dir / "keyframes" / "scene-001.png.zenc").is_file()
    assert read_private_media(keyframe) == LEGACY_MEDIA_BYTES

    store = RunStore(tmp_path / "state.sqlite3")
    run = store.get_run(new_run_id)
    assert Path(run["manifest_path"]) == new_dir / "manifest.json"
    assert all(old_run_id not in json.dumps(event) for event in store.list_events())

    with sqlite3.connect(tmp_path / "prompt-history.sqlite3") as connection:
        run_ids = [row[0] for row in connection.execute("SELECT run_id FROM prompts")]
    assert run_ids == [new_run_id]

    # Idempotent: a second sweep changes nothing.
    assert migrate_private_runs(runs_dir=runs_dir, store_path=tmp_path / "state.sqlite3") == {
        "renamed": 0,
        "files_encrypted": 0,
        "manifests_sealed": 0,
        "media_encrypted": 0,
    }


def test_control_app_startup_migrates_legacy_runs_and_serves_decrypted_artifacts(tmp_path: Path, monkeypatch) -> None:
    runs_dir, _, old_run_id = _legacy_run(tmp_path)
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(runs_dir))
    monkeypatch.setenv("CONTENT_STUDIO_DATA_DIR", str(tmp_path))
    cipher = PrivateFieldCipher.from_secret(b"test-private-state-secret")
    app = build_control_app(
        orchestrator=ContentOrchestrator(RunStore(tmp_path / "state.sqlite3")),
        control_token="control-secret",
        operator_token="operator-secret",
        owner_access=OwnerAccess.for_testing(password="test-owner-password", cipher=cipher),
        private_cipher=cipher,
    )
    client = TestClient(app)
    assert client.post("/api/owner/unlock", json={"password": "test-owner-password"}).status_code == 200

    runs = client.get("/api/runs").json()["runs"]
    assert len(runs) == 1
    new_run_id = runs[0]["run_id"]
    assert new_run_id != old_run_id and "private" not in new_run_id

    run = client.get(f"/api/runs/{new_run_id}").json()
    assert run["brief"]["title"] == SECRET_TITLE
    artifact = next(item for item in run["artifact_records"] if item["role"] == "brief")
    served = client.get(f"/api/runs/{new_run_id}/artifacts/{artifact['id']}")
    assert served.status_code == 200
    assert SECRET_TITLE in served.text
    assert not served.text.startswith(ENCRYPTED_PREFIX)

    media = next(item for item in run["artifact_records"] if item["role"] == "keyframe")
    served_media = client.get(f"/api/runs/{new_run_id}/artifacts/{media['id']}")
    assert served_media.status_code == 200
    assert served_media.content == LEGACY_MEDIA_BYTES
    ranged = client.get(f"/api/runs/{new_run_id}/artifacts/{media['id']}", headers={"Range": "bytes=0-3"})
    assert ranged.status_code == 206
    assert ranged.content == LEGACY_MEDIA_BYTES[:4]

    # Without the owner session the run receipt is redacted and prompt-free.
    assert client.post("/api/owner/lock").status_code == 200
    receipt = client.get(f"/api/runs/{new_run_id}").json()
    assert receipt["privacy"] == "machine-redacted"
    assert SECRET_TITLE.split()[2] not in json.dumps(receipt)
    assert client.get(f"/api/runs/{new_run_id}/artifacts/{artifact['id']}").status_code == 401
