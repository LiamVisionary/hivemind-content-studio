from __future__ import annotations

import hashlib
import json
from pathlib import Path

from hivemind_content_studio.manifest import MANIFEST_VERSION, ManifestConflictError, add_artifact, create_manifest, load_manifest, write_manifest


def test_artifacts_have_identity_hash_provenance_and_dependencies(tmp_path: Path) -> None:
    manifest_path, manifest = create_manifest(lane="animation", brief={"id": "provenance"}, runs_dir=tmp_path / "runs", providers={})
    artifact_path = manifest_path.parent / "frame.png"
    artifact_path.write_bytes(b"frame-content")

    artifact = add_artifact(
        manifest,
        role="keyframe",
        path=artifact_path,
        provider="comfyui",
        scene=1,
        model="z-image",
        job_id="job-1",
        source_url="https://provider.example/frame.png",
        depends_on=["brief-1"],
    )
    write_manifest(manifest_path, manifest)

    assert MANIFEST_VERSION == 2
    assert artifact["id"].startswith("art_")
    assert artifact["sha256"] == hashlib.sha256(b"frame-content").hexdigest()
    assert artifact["size_bytes"] == len(b"frame-content")
    assert artifact["scene"] == 1
    assert artifact["model"] == "z-image"
    assert artifact["job_id"] == "job-1"
    assert artifact["depends_on"] == ["brief-1"]
    assert load_manifest(manifest_path)["revision"] >= 2


def test_version_one_manifests_are_migrated_without_losing_artifacts(tmp_path: Path) -> None:
    artifact = tmp_path / "legacy.txt"
    artifact.write_text("legacy", encoding="utf-8")
    manifest_path = tmp_path / "manifest.json"
    manifest_path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "run_id": "legacy-run",
                "lane": "animation",
                "status": "planned",
                "brief": {},
                "providers": {},
                "artifacts": [{"role": "script", "path": str(artifact), "provider": "agent-runtime"}],
                "approval": {"status": "pending"},
                "publish": {"drafts": [], "receipts": []},
            }
        ),
        encoding="utf-8",
    )

    migrated = load_manifest(manifest_path)

    assert migrated["schema_version"] == 2
    assert migrated["revision"] == 1
    assert migrated["artifacts"][0]["id"].startswith("art_")
    assert migrated["artifacts"][0]["sha256"] == hashlib.sha256(b"legacy").hexdigest()


def test_stale_manifest_writer_cannot_clobber_a_newer_revision(tmp_path: Path) -> None:
    manifest_path, _ = create_manifest(lane="animation", brief={"id": "concurrency"}, runs_dir=tmp_path / "runs", providers={})
    writer_a = load_manifest(manifest_path)
    writer_b = load_manifest(manifest_path)
    writer_a["status"] = "from-a"
    write_manifest(manifest_path, writer_a)

    writer_b["status"] = "from-b"
    try:
        write_manifest(manifest_path, writer_b)
    except ManifestConflictError:
        pass
    else:
        raise AssertionError("stale writer should not replace the newer manifest")
    assert load_manifest(manifest_path)["status"] == "from-a"
