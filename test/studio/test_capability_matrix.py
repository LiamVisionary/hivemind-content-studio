"""The matrix answers *should*, and never quietly re-answers *can*."""

from __future__ import annotations

import pytest

from hivemind_content_studio.capability_matrix import (
    RATING_ORDER,
    best_models,
    capability_matrix,
    feature_rows,
)


CATALOG = {
    "image": [
        {
            "id": "comfyui", "label": "ComfyUI", "available": True, "registry_live": True,
            "models": [
                {"id": "comfy-krea2-turbo-identity-edit", "label": "Krea 2 Identity Edit", "family": "krea-2",
                 "accepts": ["prompt", "image_base64"]},
                {"id": "comfy-bigloves-klein3-edit", "label": "Klein 3 Edit", "family": "flux-2-klein",
                 "accepts": ["prompt", "image_base64"]},
            ],
        },
        {
            "id": "muapi", "label": "MUAPI", "available": False, "registry_live": True,
            "models": [{"id": "flux-2-pro", "label": "Flux 2 Pro", "family": "", "accepts": []}],
        },
    ],
    "video": [
        {
            "id": "media-studio-mcp", "label": "Media Studio", "available": True, "registry_live": True,
            "models": [
                {"id": "minimax-h3", "label": "MiniMax H3", "family": "minimax",
                 "accepts": ["prompt", "image_base64", "steps"]},
                {"id": "minimax-h3-reference", "label": "H3 Reference", "family": "minimax",
                 "accepts": ["prompt", "reference_images"]},
                {"id": "ltx23-regular-fp8", "label": "LTX 2.3", "family": "ltx-2.3",
                 "accepts": ["prompt", "image_base64", "video_base64"]},
            ],
        },
    ],
}


def test_declared_verdict_carries_its_provenance() -> None:
    rows = {row["model"]: row for row in feature_rows("sprite_animation", CATALOG)}

    assert rows["minimax-h3"]["rating"] == "good"
    # The one lane with a real report behind it must not be dressed up as
    # measured, nor flattened to a guess.
    assert rows["minimax-h3"]["evidence"] == "reported"
    assert rows["ltx23-regular-fp8"]["evidence"] == "reasoned"


def test_a_model_with_no_rule_is_unmeasured_not_recommended_and_not_warned() -> None:
    catalog = {**CATALOG, "video": [{**CATALOG["video"][0], "models": [
        {"id": "brand-new-lane", "label": "Brand New", "family": "", "accepts": ["prompt", "image_base64"]},
    ]}]}

    row = feature_rows("sprite_animation", catalog)[0]

    assert row["rating"] == "unmeasured"
    assert row["evidence"] == "none"


def test_structural_refusal_is_derived_from_the_live_registry_not_declared() -> None:
    """A graph with no image input cannot animate YOUR sprite — it would draw a
    new character. That is read off `accepts`, so a workflow that gains the
    input stops being refused without anyone editing the matrix."""
    catalog = {**CATALOG, "video": [{**CATALOG["video"][0], "models": [
        {"id": "text-only-lane", "label": "Text only", "family": "", "accepts": ["prompt", "steps"]},
    ]}]}

    row = feature_rows("sprite_animation", catalog)[0]

    assert row["rating"] == "unsupported"
    assert "image_base64" in row["reason"]


def test_a_degraded_catalog_does_not_refuse_every_model() -> None:
    """An unread registry hands back an empty accepts list. Treating that as
    'no inputs' would tell the user their models cannot animate a sprite —
    the worst possible reading of a transient gateway miss."""
    catalog = {"image": [], "video": [{
        "id": "media-studio-mcp", "label": "Media Studio", "available": True, "registry_live": False,
        "models": [{"id": "minimax-h3", "label": "MiniMax H3", "family": "minimax", "accepts": []}],
    }]}

    row = feature_rows("sprite_animation", catalog)[0]

    assert row["rating"] == "good"
    assert row["registry_live"] is False


def test_rows_rank_best_first_and_sink_offline_providers_within_a_rating() -> None:
    ratings = [row["rating"] for row in feature_rows("sprite_source", CATALOG)]

    assert ratings == sorted(ratings, key=lambda value: RATING_ORDER[value])
    workable = [row for row in feature_rows("sprite_source", CATALOG) if row["rating"] == "workable"]
    assert [row["available"] for row in workable] == sorted((row["available"] for row in workable), reverse=True)


def test_model_rule_beats_family_rule_beats_provider_rule() -> None:
    catalog = {"image": [{
        "id": "muapi", "label": "MUAPI", "available": True, "registry_live": True,
        "models": [
            # provider:muapi says workable; the krea-2 family rule says poor.
            {"id": "some-edit", "label": "Some edit", "family": "krea-2", "accepts": ["prompt"]},
            {"id": "flux-2-pro", "label": "Flux 2 Pro", "family": "", "accepts": ["prompt"]},
        ],
    }], "video": []}
    rows = {row["model"]: row for row in feature_rows("sprite_source", catalog)}

    assert rows["some-edit"]["rating"] == "poor"
    assert rows["flux-2-pro"]["rating"] == "workable"


def test_best_models_only_offers_what_is_ready_to_run() -> None:
    picks = best_models("sprite_source", limit=5, catalog=CATALOG)

    assert picks, "an available, rated model should be offered"
    assert all(pick["available"] for pick in picks)
    assert all(pick["rating"] in {"good", "workable"} for pick in picks)
    # MUAPI is offline in the fixture, so none of its models may be suggested.
    assert not any(pick["provider"] == "muapi" for pick in picks)


def test_matrix_ships_its_rules_so_the_client_catalog_gets_the_same_verdicts() -> None:
    """Half the image models are a browser-side catalog (sd.cpp checkpoints, a
    Wan2GP server). The verdicts have to travel, or the studio grows a second
    opinion about which model draws a good sprite."""
    matrix = capability_matrix(CATALOG)
    source = next(feature for feature in matrix["features"] if feature["id"] == "sprite_source")

    matches = {rule["match"] for rule in source["rules"]}
    assert "model:z-image-turbo" in matches
    assert "provider:sdcpp" in matches
    assert matrix["unmatched"]["rating"] == "unmeasured"
    # The structural inputs travel too, so the browser applies the same check.
    animation = next(feature for feature in matrix["features"] if feature["id"] == "sprite_animation")
    assert ["image_base64", "image_path", "image_url"] in animation["requires_any"]


def test_unknown_feature_is_an_error_not_an_empty_list() -> None:
    with pytest.raises(ValueError, match="sprite_teleport"):
        feature_rows("sprite_teleport", CATALOG)


# ── Story pipeline ──────────────────────────────────────────────────────────
#
# Three image stages, three different jobs. The tests below pin the parts that
# are easy to break by editing one rule and forgetting the other two.

STORY_CATALOG = {
    "image": [
        {
            "id": "openai-gpt-image", "label": "OpenAI", "available": True, "registry_live": True,
            "models": [{"id": "gpt-image-2", "label": "GPT Image 2", "family": "", "accepts": []}],
        },
        {
            "id": "comfyui", "label": "ComfyUI", "available": True, "registry_live": True,
            "models": [
                {"id": "anything-v5", "label": "Anything V5", "family": "", "accepts": ["prompt"]},
                {"id": "comfy-krea2-turbo-identity-edit", "label": "Krea 2", "family": "krea-2",
                 "accepts": ["prompt", "image_base64"]},
            ],
        },
    ],
    "video": [],
}


@pytest.mark.parametrize("feature", ["story_character_sheet", "story_location", "story_board"])
def test_every_story_stage_rates_the_whole_image_catalog(feature: str) -> None:
    rows = feature_rows(feature, STORY_CATALOG)

    # Three models in, three verdicts out. A stage that silently drops a model
    # is a picker that is missing the one the owner wanted.
    assert len(rows) == 3
    assert all(row["rating"] in RATING_ORDER for row in rows)


def test_the_three_story_stages_do_not_share_one_verdict() -> None:
    """A character finetune draws a good sheet and a bad empty street."""
    def verdict(feature: str, model: str) -> str:
        return {row["model"]: row["rating"] for row in feature_rows(feature, STORY_CATALOG)}[model]

    # Asked for an empty location it puts a character in it — which then argues
    # with the character sheets in every later render.
    assert verdict("story_location", "anything-v5") == "poor"
    assert verdict("story_location", "anything-v5") != verdict("story_board", "anything-v5")


def test_a_text_only_model_is_poor_at_boards_rather_than_refused() -> None:
    """It CAN draw a storyboard. It just draws four strangers."""
    rows = {row["model"]: row for row in feature_rows("story_board", STORY_CATALOG)}

    # `unsupported` would be a lie: nothing structurally stops the draw.
    assert rows["anything-v5"]["rating"] != "unsupported"


def test_an_edit_only_graph_cannot_start_a_sheet_from_nothing() -> None:
    rows = {row["model"]: row for row in feature_rows("story_character_sheet", STORY_CATALOG)}

    assert rows["comfy-krea2-turbo-identity-edit"]["rating"] == "poor"
    assert rows["comfy-krea2-turbo-identity-edit"]["evidence"] == "contract"


def test_the_unmatched_reason_does_not_claim_to_be_about_sprites() -> None:
    """One matrix, five features. The fallback line has to fit all of them."""
    matrix = capability_matrix(STORY_CATALOG)

    assert "sprite" not in matrix["unmatched"]["reason"].lower()
    assert {"sprite_source", "sprite_animation", "story_character_sheet",
            "story_location", "story_board"} <= {f["id"] for f in matrix["features"]}


# ── Inventory is not a menu ─────────────────────────────────────────────────

RENDERER_CATALOG = {
    "image": [
        {"id": "stickman-renderer", "label": "Stickman renderer", "available": True, "registry_live": True,
         "models": [{"id": "automatic", "label": "Automatic", "family": "", "accepts": []}]},
        {"id": "static-text-renderer", "label": "Static text renderer", "available": True, "registry_live": True,
         "models": [{"id": "automatic", "label": "Automatic", "family": "", "accepts": []}]},
        {"id": "comfyui", "label": "ComfyUI", "available": True, "registry_live": True,
         "models": [
             {"id": "workflow-default", "label": "Workflow default", "family": "", "accepts": []},
             {"id": "comfy-krea2-turbo-identity-edit", "label": "Krea 2", "family": "krea-2", "accepts": ["prompt"]},
         ]},
    ],
    "video": [],
}


@pytest.mark.parametrize("feature", ["sprite_source", "story_character_sheet", "story_location", "story_board"])
def test_a_picker_is_never_offered_a_routing_sentinel(feature: str) -> None:
    """`workflow-default` is not a registered id — media_studio strips it before
    the MCP sees it, because the MCP answers it with "unknown workflow_id"."""
    rows = feature_rows(feature, RENDERER_CATALOG)

    assert "workflow-default" not in {row["model"] for row in rows}


@pytest.mark.parametrize("feature", ["sprite_source", "story_character_sheet", "story_location", "story_board"])
def test_a_picker_is_never_offered_a_renderer(feature: str) -> None:
    """They draw stick figures and text cards. Both showed up as a row called
    "Automatic" with nothing to say what it was."""
    rows = feature_rows(feature, RENDERER_CATALOG)

    assert {row["provider"] for row in rows} == {"comfyui"}
    assert [row["model"] for row in rows] == ["comfy-krea2-turbo-identity-edit"]


def test_the_catalog_still_lists_what_the_picker_hides() -> None:
    """The renderers are real routes the agent pipeline uses on purpose. They are
    filtered out of studio pickers, not removed from the inventory."""
    from hivemind_content_studio.media_catalog import media_catalog

    catalogued = {provider["id"] for provider in media_catalog()["image"]}

    assert {"stickman-renderer", "static-text-renderer"} <= catalogued


def test_selectability_is_declared_in_one_place() -> None:
    from hivemind_content_studio.capability_matrix import is_selectable

    assert is_selectable("muapi", "flux-2-pro") is True
    assert is_selectable("comfyui", "workflow-default") is False
    assert is_selectable("stickman-renderer", "automatic") is False
    # The hosted "automatic" is a real route whose model is chosen at run time —
    # confusing, but not a sentinel, so it stays and carries an explanation.
    assert is_selectable("hivemindos-hosted-media", "automatic") is True


HOSTED_CATALOG = {
    "image": [{"id": "hivemindos-hosted-media", "label": "HivemindOS hosted",
               "available": True, "registry_live": True,
               "models": [{"id": "automatic", "label": "Automatic hosted model",
                           "family": "", "accepts": []}]}],
    "video": [],
}


@pytest.mark.parametrize("feature", ["sprite_source", "story_character_sheet", "story_location", "story_board"])
def test_the_hosted_row_says_what_it_is_in_every_feature(feature: str) -> None:
    """A provider-level truth stated once. The first version of this rule was
    pasted into ONE of four features, and the other three went on rendering
    "Nobody has run this model through this feature here" — which was wrong
    twice over: there is nothing fixed to run."""
    row = feature_rows(feature, HOSTED_CATALOG)[0]

    assert row["rating"] == "workable"
    assert "picks a current model for you" in row["reason"]


def test_a_feature_can_still_overrule_a_common_verdict() -> None:
    """Common rules are appended, so a feature that declares the same match key
    keeps the last word."""
    from hivemind_content_studio.capability_matrix import COMMON_RULES, SPRITE_SOURCE

    common_keys = {rule.match for rule in COMMON_RULES}
    for rule in SPRITE_SOURCE.rules:
        if rule.match in common_keys:
            assert feature_rows("sprite_source", HOSTED_CATALOG)[0]["reason"] == rule.reason


def test_the_browser_is_shipped_the_same_rules_the_server_applies() -> None:
    """Half the studio's image models are a browser-side catalog the server has
    never heard of; the browser rates them with these rules. A common rule that
    did not travel would make the two disagree about the same model."""
    matrix = capability_matrix(HOSTED_CATALOG)
    from hivemind_content_studio.capability_matrix import COMMON_RULES

    for feature in matrix["features"]:
        shipped = {rule["match"] for rule in feature["rules"]}
        assert {rule.match for rule in COMMON_RULES} <= shipped
