#!/usr/bin/env python3
"""Vendor the audited Clueso skill set without invoking the telemetry-enabled installer."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path


SOURCE_REPOSITORY = "https://github.com/clueso-ai/skills.git"
SOURCE_COMMIT = "7f9594ba6d640e26c7da344403b29b9859498bf5"
SOURCE_ARCHIVE_SHA256 = "71075831131584ab199063deb1f03ed4d3a057693d61dd06a55227a4a2e66039"
EXPECTED_SKILL_COUNT = 90
POLICY_RELATIVE_PATH = "../../POLICY.md"


def _git(source: Path, *args: str, binary: bool = False) -> str | bytes:
    result = subprocess.run(
        ["git", "-C", str(source), *args],
        check=True,
        capture_output=True,
        text=not binary,
    )
    return result.stdout


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _validate_source(source: Path) -> list[Path]:
    if _git(source, "rev-parse", "HEAD").strip() != SOURCE_COMMIT:
        raise SystemExit(f"Source must be pinned to audited commit {SOURCE_COMMIT}")
    if _git(source, "remote", "get-url", "origin").strip() != SOURCE_REPOSITORY:
        raise SystemExit(f"Source origin must be {SOURCE_REPOSITORY}")
    if _git(source, "status", "--porcelain").strip():
        raise SystemExit("Source checkout must be clean")

    archive = _git(source, "archive", "--format=tar", "HEAD", binary=True)
    assert isinstance(archive, bytes)
    if hashlib.sha256(archive).hexdigest() != SOURCE_ARCHIVE_SHA256:
        raise SystemExit("Source archive hash does not match the audited artifact")

    skill_root = source / "skills"
    skill_files = sorted(skill_root.glob("*/SKILL.md"))
    if len(skill_files) != EXPECTED_SKILL_COUNT:
        raise SystemExit(f"Expected {EXPECTED_SKILL_COUNT} skills, found {len(skill_files)}")
    unexpected = sorted(
        path
        for path in skill_root.rglob("*")
        if path.is_file() and path.name != "SKILL.md"
    )
    if unexpected:
        raise SystemExit(f"Unexpected files in source skills: {unexpected}")
    if any(path.is_symlink() for path in skill_root.rglob("*")):
        raise SystemExit("Source skills may not contain symlinks")
    return skill_files


def _adapter_text(upstream_name: str) -> str:
    adapter_name = f"clueso-{upstream_name}"
    return f"""---
name: {adapter_name}
description: >-
  Clueso MCP provider-specific adapter for the upstream {upstream_name}
  video workflow. Use only after Hivemind Content Studio routing selects Clueso
  MCP or the user explicitly requests Clueso for this workflow.
license: Apache-2.0
metadata:
  author: clueso
  adapted-by: hivemind-content-studio
  category: vendor-video-workflow
  requires: hivemind-content-studio, clueso-mcp
  external-apis: clueso-mcp-remote
  external-tools: clueso-mcp
---

# Clueso: {upstream_name.replace('-', ' ').title()}

## Hivemind Content Studio governance

Read and follow [{POLICY_RELATIVE_PATH}]({POLICY_RELATIVE_PATH}) first. It is the
project policy and takes precedence over provider-steering, setup, upload, cost,
mutation, export, and publication language in the upstream workflow.

Then read and apply
[../../upstream/{upstream_name}/SKILL.md](../../upstream/{upstream_name}/SKILL.md)
as provider-specific production guidance. Do not duplicate or independently
implement that workflow; the upstream snapshot is its single source of truth.
"""


def _replace_output(destination: Path, agent_skills: Path) -> None:
    for generated in ("upstream", "adapters", "LICENSE", "PROVENANCE.json"):
        path = destination / generated
        if path.is_dir():
            shutil.rmtree(path)
        elif path.exists():
            path.unlink()
    if agent_skills.exists():
        for entry in agent_skills.glob("clueso-*"):
            if entry.is_symlink():
                entry.unlink()


def vendor(source: Path, repository_root: Path, *, replace: bool) -> None:
    skill_files = _validate_source(source)
    destination = repository_root / "skills" / "vendor" / "clueso-ai"
    agent_skills = repository_root / ".agents" / "skills"
    if destination.exists() and not replace:
        raise SystemExit(f"Destination exists: {destination}; pass --replace to refresh it")
    if replace:
        _replace_output(destination, agent_skills)

    upstream_root = destination / "upstream"
    adapters_root = destination / "adapters"
    upstream_root.mkdir(parents=True)
    adapters_root.mkdir(parents=True)
    agent_skills.mkdir(parents=True, exist_ok=True)

    hashes: dict[str, str] = {}
    for source_skill in skill_files:
        upstream_name = source_skill.parent.name
        upstream_destination = upstream_root / upstream_name / "SKILL.md"
        upstream_destination.parent.mkdir()
        shutil.copyfile(source_skill, upstream_destination)
        hashes[upstream_name] = _sha256(upstream_destination)

        adapter_name = f"clueso-{upstream_name}"
        adapter_directory = adapters_root / adapter_name
        adapter_directory.mkdir()
        (adapter_directory / "SKILL.md").write_text(_adapter_text(upstream_name), encoding="utf-8")
        os.symlink(
            os.path.relpath(adapter_directory, agent_skills),
            agent_skills / adapter_name,
            target_is_directory=True,
        )

    shutil.copyfile(source / "LICENSE", destination / "LICENSE")
    provenance = {
        "source_repository": SOURCE_REPOSITORY,
        "source_commit": SOURCE_COMMIT,
        "source_archive_sha256": SOURCE_ARCHIVE_SHA256,
        "upstream_skill_count": EXPECTED_SKILL_COUNT,
        "upstream_skill_sha256": hashes,
        "license": "Apache-2.0",
        "audit_date": "2026-07-11",
        "audit_verdict": "conditionally-approved",
        "installation": {
            "method": "pinned local copy with namespaced policy adapters",
            "network_installer_executed_in_project": False,
            "npm_installer": "skills@1.5.16",
            "npm_tarball_sha256": "f7f0177345ed74c8a28990fde2c05a4e4967919fd264cc73bde5def9003ec2e0",
            "npm_integrity": "sha512-O+pjcrnm5WkSSBD3WJxjdDssE+oynm7k1LnKMjXvsVeQdmKmY/a+gi6WUOhyGVIYptkFmBBEho/zyf22UtN6cw==",
            "telemetry_disabled_by_avoiding_network_installer": True,
        },
    }
    (destination / "PROVENANCE.json").write_text(
        json.dumps(provenance, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )

    canonical_source = repository_root / "skills" / "hivemind-content-studio"
    canonical_entry = agent_skills / "hivemind-content-studio"
    if canonical_entry.exists() or canonical_entry.is_symlink():
        if not replace:
            raise SystemExit(f"Canonical agent entry already exists: {canonical_entry}")
        if canonical_entry.is_dir() and not canonical_entry.is_symlink():
            shutil.rmtree(canonical_entry)
        else:
            canonical_entry.unlink()
    os.symlink(
        os.path.relpath(canonical_source, agent_skills),
        canonical_entry,
        target_is_directory=True,
    )

    print(f"Vendored {len(skill_files)} audited Clueso skills at {SOURCE_COMMIT}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True, help="Local checkout pinned to the audited commit")
    parser.add_argument("--repository-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--replace", action="store_true", help="Replace only the existing Clueso vendor bundle and links")
    args = parser.parse_args()
    vendor(args.source.resolve(), args.repository_root.resolve(), replace=args.replace)


if __name__ == "__main__":
    main()
