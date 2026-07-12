from __future__ import annotations

from hivemind_content_studio.studio_drafts import StudioRunDraft


def test_publish_platform_aliases_from_brains_are_normalized_not_fatal() -> None:
    draft = StudioRunDraft.model_validate(
        {
            "lane": "animation",
            "title": "Daily Task Completion",
            "publish": {
                "platforms": ["tiktok", "instagram_reels", "YouTube Shorts", "twitter", "made-up-network", "tiktok"],
                "caption": "Conquer your day",
            },
        }
    )

    assert draft.publish.platforms == ["tiktok", "instagram", "youtube", "x"]


def test_null_fields_from_brains_fall_back_to_defaults_not_fatal() -> None:
    draft = StudioRunDraft.model_validate(
        {
            "lane": "stickman-performance-ad",
            "title": "Make Someone Laugh Task Completion",
            "concept": None,
            "aspect_ratio": None,
            "scenes": [
                {"title": "Performing the Task", "beat": "He tells a joke", "overlay": None, "voice": None, "image_prompt": None},
            ],
            "voice": {"enabled": True, "delivery": None},
            "publish": {"platforms": None, "caption": None},
        }
    )

    assert draft.concept == ""
    assert draft.scenes[0].overlay == ""
    assert draft.scenes[0].voice == ""
    assert draft.voice.delivery == ""
    assert draft.publish.platforms == []


def test_publish_platforms_from_the_studio_ui_pass_through_unchanged() -> None:
    draft = StudioRunDraft.model_validate(
        {
            "lane": "animation",
            "title": "UI draft",
            "publish": {"platforms": ["instagram", "linkedin"]},
        }
    )

    assert draft.publish.platforms == ["instagram", "linkedin"]


def test_role_oriented_brain_provider_options_are_normalized_to_selected_providers() -> None:
    draft = StudioRunDraft.model_validate(
        {
            "lane": "first-frame-animation-ad",
            "title": "Reference-led animation",
            "providers": {"image": "openai-gpt-image-oauth", "motion": "muapi"},
            "provider_options": {
                "image_model": "gpt-image-2",
                "motion_model": "seedance-v2.0-t2v",
                "reference_image_usage": "Use the attached screenshot as the visual source of truth.",
            },
        }
    )

    assert draft.provider_options == {
        "openai-gpt-image-oauth": {"model": "gpt-image-2"},
        "muapi": {"model": "seedance-v2.0-t2v"},
        "_planning": {"reference_image_usage": "Use the attached screenshot as the visual source of truth."},
    }
