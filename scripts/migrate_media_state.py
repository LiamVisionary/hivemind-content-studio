#!/usr/bin/env python3
"""Copy local media-studio state into the canonical HivemindOS data root."""

from __future__ import annotations

import argparse
import json
import secrets
import shutil
from datetime import datetime, timezone
from pathlib import Path


GATEWAY_STATE_FILES = (
    "history.jsonl",
    "download_jobs.json",
    "equipped_models.json",
    "selected_loras.json",
    "last_mobile_prompt_loras.json",
)


def copy_file(source: Path, destination: Path, records: list[dict]) -> None:
    if not source.is_file():
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        records.append({"source": str(source), "destination": str(destination), "status": "kept-existing"})
        return
    shutil.copy2(source, destination)
    records.append(
        {
            "source": str(source),
            "destination": str(destination),
            "status": "copied",
            "bytes": destination.stat().st_size,
        }
    )


def copy_tree(source: Path, destination: Path, records: list[dict]) -> None:
    if not source.is_dir():
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        records.append({"source": str(source), "destination": str(destination), "status": "kept-existing"})
        return
    shutil.copytree(source, destination, symlinks=True)
    records.append({"source": str(source), "destination": str(destination), "status": "copied-tree"})


def ensure_gateway_token(path: Path, records: list[dict]) -> None:
    if path.exists():
        records.append({"destination": str(path), "status": "kept-existing-secret"})
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(secrets.token_urlsafe(48) + "\n", encoding="utf-8")
    path.chmod(0o600)
    records.append({"destination": str(path), "status": "generated-secret"})


def migrate(args: argparse.Namespace) -> dict:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    root = args.state_root.expanduser().resolve()
    gateway_source = args.gateway_source.expanduser().resolve()
    opengen_source = args.opengen_source.expanduser().resolve()
    records: list[dict] = []

    gateway_state = root / "state" / "media-gateway"
    for name in GATEWAY_STATE_FILES:
        copy_file(gateway_source / name, gateway_state / name, records)

    copy_file(
        gateway_source / "history.jsonl.private-redacted-backup",
        root / "archives" / "media-gateway" / "history.jsonl.private-redacted-backup",
        records,
    )
    copy_tree(
        opengen_source / "backups",
        root / "archives" / "open-generative-ai" / f"backups-{timestamp}",
        records,
    )
    copy_file(
        opengen_source / "localInference.js",
        root / "archives" / "open-generative-ai" / f"localInference-{timestamp}.js",
        records,
    )
    for source in sorted(opengen_source.glob("index-*.js")):
        copy_file(
            source,
            root / "archives" / "open-generative-ai" / f"{source.stem}-{timestamp}{source.suffix}",
            records,
        )
    ensure_gateway_token(root / "secure" / "zimg-token", records)

    manifest = {
        "version": 1,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "state_root": str(root),
        "records": records,
        "credential_gates": [
            {
                "name": "CIVITAI_TOKEN",
                "status": "must-be-provided-via-environment",
                "note": "Legacy plaintext credential files are intentionally not copied.",
            }
        ],
    }
    manifest_dir = root / "migration-manifests"
    manifest_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = manifest_dir / f"migration-{timestamp}.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    manifest["manifest_path"] = str(manifest_path)
    return manifest


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument(
        "--state-root",
        type=Path,
        default=Path("~/.hivemindos/media-studio"),
        help="Canonical private state directory.",
    )
    result.add_argument(
        "--gateway-source",
        type=Path,
        default=Path("~/comfy/z-image-api"),
        help="Existing media gateway checkout.",
    )
    result.add_argument(
        "--opengen-source",
        type=Path,
        default=Path("~/.openclaw/companions/Open-Generative-AI"),
        help="Existing Open Generative AI checkout.",
    )
    return result


if __name__ == "__main__":
    print(json.dumps(migrate(parser().parse_args()), indent=2))
