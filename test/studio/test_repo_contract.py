from __future__ import annotations

import json
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]

# Fonts that ship with Windows or macOS, or that arrived with no licence at all.
# They were tracked under resource/fonts until 2026-09-04 and one of them was the
# subtitle default, so every rendered short redistributed a font this project has
# no right to. See resource/FONTS.md.
UNSHIPPABLE_FONTS = (
    "MicrosoftYaHeiBold.ttc",
    "MicrosoftYaHeiNormal.ttc",
    "STHeitiLight.ttc",
    "STHeitiMedium.ttc",
    "UTM Kabel KT.ttf",
)


def _tracked_files() -> list[str]:
    result = subprocess.run(
        ["git", "ls-files"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    assert result.returncode == 0, "git ls-files failed; this test needs a checkout"
    return [line for line in result.stdout.splitlines() if line]


def test_no_duplicate_publisher_implementations_or_render_auto_upload() -> None:
    assert not (ROOT / "app" / "services" / "upload_post.py").exists()
    assert not (ROOT / "src" / "auto_clipper" / "postiz.py").exists()
    task = (ROOT / "app" / "services" / "task.py").read_text(encoding="utf-8")
    assert "auto_upload" not in task
    assert "cross_post_video" not in task


def test_shared_skill_bundle_is_complete_and_has_canonical_entry() -> None:
    snapshots = sorted((ROOT / "skills" / "shared").glob("*/SKILL.md"))
    assert len(snapshots) == 19
    assert (ROOT / "skills" / "shared" / "higgsfield-generate" / "SKILL.md").is_file()
    assert (ROOT / "skills" / "shared" / "higgsfield-api-quirks" / "SKILL.md").is_file()
    assert (ROOT / "skills" / "shared" / "ai-ugc-production-pipeline" / "SKILL.md").is_file()
    assert (ROOT / "skills" / "hivemind-content-studio" / "SKILL.md").is_file()


def test_mcp_surface_covers_the_two_complete_ad_lanes() -> None:
    source = (ROOT / "src" / "hivemind_content_studio" / "mcp_server.py").read_text(encoding="utf-8")
    for tool_name in (
        "run_agent_script_generation",
        "attach_agent_script",
        "render_stickman_ad_frames",
        "generate_higgsfield_consumer_media",
        "generate_higgsfield_cloud_media",
        "generate_muapi_media",
        "generate_elevenlabs_voice_lines",
        "assemble_content_run",
        "export_capcut_timeline_handoff",
        "get_generation_telemetry",
    ):
        assert f"def {tool_name}(" in source


def test_no_proprietary_font_or_unlicensed_track_is_tracked() -> None:
    tracked = _tracked_files()
    offenders = [
        path
        for path in tracked
        if path.startswith("resource/fonts/") and Path(path).name in UNSHIPPABLE_FONTS
    ]
    assert offenders == [], f"these may not be redistributed: {offenders}"

    # resource/songs held 29 MP3s with no artist, no source and no licence.
    songs = [path for path in tracked if path.startswith("resource/songs/")]
    assert songs == [], f"background music needs provenance in resource/SONGS.md: {songs}"


def test_every_bundled_font_has_a_licence_row_in_its_notices_file() -> None:
    fonts_md = (ROOT / "resource" / "FONTS.md").read_text(encoding="utf-8")
    tracked = [
        Path(path).name
        for path in _tracked_files()
        if path.startswith("resource/fonts/") and not path.endswith(".md")
    ]
    assert tracked, "resource/fonts is empty; the subtitle default has nowhere to resolve"
    missing = [name for name in tracked if f"`{name}`" not in fonts_md]
    assert missing == [], f"add a source and licence row to resource/FONTS.md for: {missing}"
    assert (ROOT / "resource" / "SONGS.md").is_file()


def test_the_notices_file_has_no_unresolved_distribution_gate() -> None:
    """`docs/RELEASE.md` §7 step 2 is a release gate; this is that check, in code.

    The notices file used to end three entries with "confirm before making this
    repository public" and "review before commercial redistribution". Those are
    decisions, not documentation, and a build must not be able to ship while one
    of them is still open.
    """
    notices = (ROOT / "THIRD_PARTY_NOTICES.md").read_text(encoding="utf-8")
    assert "**No open distribution gate remains.**" in notices
    lowered = notices.lower()
    for phrase in (
        "before making this repository public",
        "before commercial redistribution",
        "needs review before",
    ):
        assert phrase not in lowered, f"unresolved distribution gate: {phrase!r}"


def test_the_generated_dependency_notices_are_present_and_shaped() -> None:
    payload = json.loads((ROOT / "docs" / "notices.json").read_text(encoding="utf-8"))
    assert payload["project"]["license"] == "AGPL-3.0-or-later"
    assert payload["python"]["packages"], "regenerate with scripts/generate_notices.py"
    assert payload["npm"], "regenerate with scripts/generate_notices.py"


def test_the_donor_streamlit_shell_lives_under_archive() -> None:
    # Tracked, not present: `utils.public_dir()` and `utils.song_dir()` recreate
    # their directories on any run, so "the file is gone from the tree" is the
    # question, and an empty directory left by a render is not a failure.
    tracked = _tracked_files()
    moved = ("webui/", "webui.sh", "webui.bat", "main.py", "docs/upstream/", "docs/skill/", "resource/public/")
    offenders = [path for path in tracked if path.startswith(moved)]
    assert offenders == [], f"these belong under archive/moneyprinterturbo/: {offenders}"
    archive = ROOT / "archive" / "moneyprinterturbo"
    assert (archive / "README.md").is_file()
    assert (archive / "webui" / "Main.py").is_file()
    assert len(list((archive / "test").glob("test_webui_*.py"))) == 7
    # The engine and its own tests stay exactly where they are.
    assert (ROOT / "app" / "services" / "video.py").is_file()
    assert (ROOT / "test" / "services" / "test_video.py").is_file()
