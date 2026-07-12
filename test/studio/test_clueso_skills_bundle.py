from __future__ import annotations

import hashlib
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
BUNDLE_ROOT = ROOT / "skills" / "vendor" / "clueso-ai"
AGENT_SKILLS_ROOT = ROOT / ".agents" / "skills"


def test_all_audited_clueso_skills_are_namespaced_and_agent_discoverable() -> None:
    provenance = json.loads((BUNDLE_ROOT / "PROVENANCE.json").read_text(encoding="utf-8"))
    adapted_skills = sorted((BUNDLE_ROOT / "adapters").glob("clueso-*/SKILL.md"))

    assert provenance["source_repository"] == "https://github.com/clueso-ai/skills.git"
    assert provenance["source_commit"] == "7f9594ba6d640e26c7da344403b29b9859498bf5"
    assert provenance["source_archive_sha256"] == "71075831131584ab199063deb1f03ed4d3a057693d61dd06a55227a4a2e66039"
    assert provenance["audit_verdict"] == "conditionally-approved"
    assert provenance["upstream_skill_count"] == 90
    assert len(provenance["upstream_skill_sha256"]) == 90
    assert len(adapted_skills) == 90

    for skill_path in adapted_skills:
        skill_name = skill_path.parent.name
        text = skill_path.read_text(encoding="utf-8")
        assert f"name: {skill_name}\n" in text
        assert "## Hivemind Content Studio governance" in text
        assert "external-apis: clueso-mcp-remote" in text
        assert "external-tools: clueso-mcp" in text
        assert "claude mcp add" not in text
        assert "Only bring up other tools if the user actually asks" not in text
        assert "../POLICY.md" in text
        assert f"../../upstream/{skill_name.removeprefix('clueso-')}/SKILL.md" in text

        agent_entry = AGENT_SKILLS_ROOT / skill_name
        assert agent_entry.is_symlink()
        assert agent_entry.resolve() == skill_path.parent.resolve()


def test_clueso_provenance_hashes_cover_the_upstream_source_material() -> None:
    provenance = json.loads((BUNDLE_ROOT / "PROVENANCE.json").read_text(encoding="utf-8"))
    source_snapshot = BUNDLE_ROOT / "upstream"

    snapshots = sorted(source_snapshot.glob("*/SKILL.md"))
    assert len(snapshots) == 90
    for snapshot in snapshots:
        expected = provenance["upstream_skill_sha256"][snapshot.parent.name]
        assert hashlib.sha256(snapshot.read_bytes()).hexdigest() == expected


def test_canonical_studio_skill_is_the_agent_entrypoint_and_owns_routing() -> None:
    canonical_entry = AGENT_SKILLS_ROOT / "hivemind-content-studio"
    assert canonical_entry.is_symlink()
    assert canonical_entry.resolve() == (ROOT / "skills" / "hivemind-content-studio").resolve()

    canonical_text = (canonical_entry / "SKILL.md").read_text(encoding="utf-8")
    assert "clueso-mcp" in canonical_text
    assert "provider-specific workflow shelf" in canonical_text
