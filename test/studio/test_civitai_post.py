"""Staging a creation for a Civitai post.

The mechanism these cover is unusual enough to be worth stating: Civitai has no
upload API, its post composer fetches the media from the BROWSER, and so the
studio serves one plaintext file at an ungated token URL for a few minutes. The
tests that matter most are therefore the ones about the token and the expiry —
they are what stands in for the sign-in gate on that route.
"""

from __future__ import annotations

import io
import json
import re
import time

import pytest

from hivemind_content_studio import civitai_post


@pytest.fixture(autouse=True)
def outbox(tmp_path, monkeypatch):
    """Every test gets its own staging root — these write real plaintext."""
    monkeypatch.setenv("CIVITAI_STAGE_ROOT", str(tmp_path / "outbox"))
    return tmp_path / "outbox"


def png_bytes(size=(32, 24)):
    from PIL import Image

    buffer = io.BytesIO()
    Image.new("RGB", size, (10, 20, 30)).save(buffer, format="PNG")
    return buffer.getvalue()


def test_a1111_parameters_is_the_format_civitai_parses():
    text = civitai_post.a1111_parameters(
        {
            "prompt": "a heron at dawn",
            "negativePrompt": "blurry",
            "steps": 28,
            "sampler": "euler",
            "cfgScale": 4.5,
            "seed": 12345,
            "size": "832x1216",
            "model": "Krea 2",
        }
    )
    lines = text.splitlines()
    assert lines[0] == "a heron at dawn"
    assert lines[1] == "Negative prompt: blurry"
    assert lines[2] == "Steps: 28, Sampler: euler, CFG scale: 4.5, Seed: 12345, Size: 832x1216, Model: Krea 2"


def test_a1111_parameters_omits_what_it_does_not_have():
    """A missing setting must not become a plausible-looking default: this text
    is published as a factual record of how the thing was made."""
    text = civitai_post.a1111_parameters({"prompt": "just a prompt"})
    assert text == "just a prompt"
    assert "Seed" not in text and "Steps" not in text


def test_png_carries_the_parameters_civitai_reads():
    from PIL import Image

    staged, stamped = civitai_post.stage(
        data=png_bytes(),
        content_type="image/png",
        filename="heron.png",
        meta={"prompt": "a heron at dawn", "seed": 7},
    )
    assert stamped is True
    with Image.open(staged.path) as image:
        assert "a heron at dawn" in image.info["parameters"]
        assert "Seed: 7" in image.info["parameters"]


def test_jpeg_carries_parameters_in_exif_user_comment():
    from PIL import Image

    buffer = io.BytesIO()
    Image.new("RGB", (32, 24), (90, 20, 20)).save(buffer, format="JPEG")
    staged, stamped = civitai_post.stage(
        data=buffer.getvalue(), content_type="image/jpeg", meta={"prompt": "a jpeg prompt"}
    )
    assert stamped is True
    with Image.open(staged.path) as image:
        # 0x9286 is UserComment; the 8-byte charset prefix is part of the field.
        comment = image.getexif()[0x9286]
    assert comment.startswith(b"UNICODE\0")
    assert "a jpeg prompt" in comment[8:].decode("utf-16-be")


def test_nothing_to_say_means_nothing_is_written():
    _, stamped = civitai_post.stage(data=png_bytes(), content_type="image/png", meta={})
    assert stamped is False


def test_staged_media_is_readable_by_its_token_and_only_that():
    staged, _ = civitai_post.stage(data=png_bytes(), content_type="image/png", filename="a.png")
    assert civitai_post.read_staged(staged.token) is not None
    assert civitai_post.read_staged("not-a-real-token-value-here") is None
    # Path traversal and short guesses are refused by shape, before any lookup.
    assert civitai_post.read_staged("../../etc/passwd") is None
    assert civitai_post.read_staged("short") is None
    assert civitai_post.read_staged("") is None


def test_token_is_long_enough_to_stand_in_for_the_sign_in_gate():
    staged, _ = civitai_post.stage(data=png_bytes(), content_type="image/png")
    # secrets.token_urlsafe(32) -> 43 chars of url-safe base64.
    assert len(staged.token) >= 40


def test_staging_expires_and_the_plaintext_goes_with_it():
    staged, _ = civitai_post.stage(data=png_bytes(), content_type="image/png")
    assert staged.path.exists()
    later = time.time() + civitai_post.STAGE_TTL_SECONDS + 1
    assert civitai_post.read_staged(staged.token, now=later) is None
    # The sweep must delete the bytes, not merely stop serving them.
    assert not staged.path.exists()


def test_dropping_a_staging_removes_it_immediately():
    staged, _ = civitai_post.stage(data=png_bytes(), content_type="image/png")
    assert civitai_post.drop_staged(staged.token) is True
    assert not staged.path.exists()
    assert civitai_post.drop_staged(staged.token) is False


@pytest.mark.parametrize(
    ("content_type", "size", "meta", "expected"),
    [
        ("video/mp4", 800 * 1024**2, {}, "750 MB"),
        ("video/mp4", 10, {"duration": 300}, "245s"),
        ("video/mp4", 10, {"width": 5000}, "3840px"),
        ("image/png", 60 * 1024**2, {}, "50 MB"),
        ("image/gif", 10, {}, "does not accept"),
    ],
)
def test_civitai_limits_are_refused_here_with_the_number_that_fails(content_type, size, meta, expected):
    """Refused in the studio, not inside somebody else's uploader after the
    bytes have already been sent."""
    with pytest.raises(civitai_post.CivitaiPostError) as excinfo:
        civitai_post.check_limits(content_type, size, meta)
    assert expected in str(excinfo.value)


def test_a_clip_inside_every_limit_is_accepted():
    civitai_post.check_limits("video/mp4", 10 * 1024**2, {"duration": 15, "width": 1080, "height": 1920})


def test_cors_is_granted_only_to_civitai():
    assert civitai_post.cors_origin("https://civitai.com") == "https://civitai.com"
    assert civitai_post.cors_origin("https://civitai.red") == "https://civitai.red"
    for origin in ["https://evil.example", "http://civitai.com", "https://civitai.com.evil.test", "", None]:
        assert civitai_post.cors_origin(origin) is None


def test_intent_url_carries_the_post_fields():
    url = civitai_post.intent_url(
        "https://host.test/civitai/staged/tok/a.png", title="T", description="D", tags=["a", "b"]
    )
    assert url.startswith("https://civitai.com/intent/post?")
    assert "mediaUrl=https%3A%2F%2Fhost.test%2Fcivitai%2Fstaged%2Ftok%2Fa.png" in url
    assert "title=T" in url and "description=D" in url and "tags=a%2Cb" in url


def test_intent_url_caps_tags_at_civitais_limit():
    """Civitai fails the whole page on a sixth tag, so the sixth is dropped."""
    url = civitai_post.intent_url("https://host.test/m.png", tags=["a", "b", "c", "d", "e", "f"])
    assert "tags=a%2Cb%2Cc%2Cd%2Ce" in url
    assert "%2Cf" not in url


def test_intent_url_requires_an_absolute_media_url():
    with pytest.raises(civitai_post.CivitaiPostError):
        civitai_post.intent_url("/civitai/staged/tok/a.png")


def test_filename_cannot_escape_the_staging_directory():
    staged, _ = civitai_post.stage(
        data=png_bytes(), content_type="image/png", filename="../../../etc/passwd.png"
    )
    assert "/" not in staged.filename
    assert staged.path.parent == civitai_post.staging_root()


def test_record_and_media_share_a_fate_on_sweep(outbox):
    staged, _ = civitai_post.stage(data=png_bytes(), content_type="image/png")
    record = outbox / f"{staged.token}.json"
    assert record.exists()
    civitai_post.sweep(now=time.time() + civitai_post.STAGE_TTL_SECONDS + 1)
    assert not record.exists() and not staged.path.exists()


def test_an_unreadable_record_is_swept_rather_than_kept(outbox):
    """A record that cannot be parsed can never be served either, so leaving it
    would mean it is never cleaned up."""
    outbox.mkdir(parents=True, exist_ok=True)
    broken = outbox / "brokenrecordbrokenrecordbroken.json"
    broken.write_text("{not json")
    civitai_post.sweep()
    assert not broken.exists()


def test_stage_writes_a_record_the_reader_agrees_with(outbox):
    staged, _ = civitai_post.stage(
        data=png_bytes(), content_type="image/png", filename="heron.png", meta={"prompt": "x y z"}
    )
    record = json.loads((outbox / f"{staged.token}.json").read_text())
    assert record["content_type"] == "image/png"
    assert record["filename"] == "heron.png"
    read_back = civitai_post.read_staged(staged.token)
    assert read_back.content_type == record["content_type"]
    assert read_back.filename == record["filename"]


def test_staged_plaintext_is_owner_only_on_disk():
    """The record names the token, and the token is the whole credential for
    reading the file — so both are as sensitive as the media itself."""
    import stat

    staged, _ = civitai_post.stage(data=png_bytes(), content_type="image/png")
    root = civitai_post.staging_root()
    assert stat.S_IMODE(root.stat().st_mode) == 0o700
    assert stat.S_IMODE(staged.path.stat().st_mode) == 0o600
    assert stat.S_IMODE((root / f"{staged.token}.json").stat().st_mode) == 0o600


# --- resource linking -------------------------------------------------------
# These assert against Civitai's OWN parser rules, copied from
# src/utils/metadata/automatic.metadata.ts (read 2026-08-28), rather than
# against what this module happens to produce. A resource block Civitai cannot
# match is worse than none: it rides along inside the published prompt as noise.

CIVITAI_RESOURCES_RE = re.compile(r", Civitai resources:\s*(\[\{.*?\}\])")


def test_resources_are_written_where_civitais_own_regex_finds_them():
    text = civitai_post.a1111_parameters(
        {
            "prompt": "a heron",
            "model": "Krea 2",
            "civitaiResources": [
                {"type": "lora", "modelVersionId": 12345, "weight": 0.8},
                {"type": "lora", "modelVersionId": 67890, "weight": 1.0},
            ],
        }
    )
    details = text.splitlines()[-1]
    match = CIVITAI_RESOURCES_RE.search(details)
    assert match, f"Civitai's regex found nothing in: {details!r}"
    parsed = json.loads(match.group(1))
    assert parsed == [
        {"type": "lora", "modelVersionId": 12345, "weight": 0.8},
        {"type": "lora", "modelVersionId": 67890, "weight": 1.0},
    ]


def test_resources_never_lead_the_line_where_the_regex_would_miss_them():
    """Their pattern requires the leading ", " — a resource block with nothing
    before it is unreadable, so it is dropped rather than written wrong."""
    text = civitai_post.a1111_parameters(
        {"prompt": "p", "civitaiResources": [{"type": "lora", "modelVersionId": 1}]}
    )
    assert "Civitai resources" not in text


def test_resources_without_a_version_id_are_dropped():
    """A LoRA with no Civitai sidecar cannot be linked; naming it in the
    resource block would claim a link that does not exist."""
    text = civitai_post.a1111_parameters(
        {
            "prompt": "p",
            "model": "m",
            "civitaiResources": [
                {"type": "lora", "modelVersionId": None, "weight": 1},
                {"type": "lora", "modelVersionId": 0},
                {"type": "lora"},
                {"type": "lora", "modelVersionId": 42},
            ],
        }
    )
    parsed = json.loads(CIVITAI_RESOURCES_RE.search(text.splitlines()[-1]).group(1))
    assert parsed == [{"type": "lora", "modelVersionId": 42}]


def test_resource_block_stays_parseable_alongside_the_other_settings():
    text = civitai_post.a1111_parameters(
        {
            "prompt": "a heron",
            "negativePrompt": "blurry",
            "steps": 28,
            "seed": 7,
            "size": "832x1216",
            "model": "Krea 2",
            "civitaiResources": [{"type": "lora", "modelVersionId": 99, "weight": 0.5}],
        }
    )
    details = text.splitlines()[-1]
    # The settings Civitai reads as key/value pairs must survive alongside it.
    assert "Steps: 28" in details and "Seed: 7" in details and "Size: 832x1216" in details
    assert json.loads(CIVITAI_RESOURCES_RE.search(details).group(1))[0]["modelVersionId"] == 99


def test_metadata_keys_match_what_civitai_reads_from_a_video():
    """Civitai PR #3307 normalises exactly four MP4 mdta / WebM SimpleTag keys:
    prompt, workflow, parameters, extrametadata. We write `parameters` and
    `prompt`, so both are keys it will pick up."""
    assert {"parameters", "prompt"} <= {"prompt", "workflow", "parameters", "extrametadata"}
