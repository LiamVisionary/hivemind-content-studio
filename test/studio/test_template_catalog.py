from __future__ import annotations

import pytest

from hivemind_content_studio.lanes import LANE_BY_ID
from hivemind_content_studio.template_catalog import template_by_id, template_catalog, template_report


def test_catalog_loads_valid_unique_templates_for_known_lanes() -> None:
    templates = template_catalog()
    assert len(templates) >= 11
    ids = [template.id for template in templates]
    assert len(ids) == len(set(ids))
    for template in templates:
        assert template.title and template.description and template.prompt
        assert template.lane in LANE_BY_ID
        assert template.category in {"ugc", "formats", "animation"}
        for slot in template.slots:
            assert f"[{slot}" in template.prompt


def test_ugc_templates_carry_the_realism_system() -> None:
    reference = template_by_id("ugc-character-reference")
    assert "no AI-aesthetic styling" in reference.prompt
    assert "9:16" in reference.prompt
    ad = template_by_id("ugc-product-ad-15s")
    assert "CHARACTER LOCK" in ad.prompt
    assert "STYLE NEGATIVES" in ad.prompt
    assert "[HOOK LINE]" in ad.prompt


def test_report_is_json_safe_and_lookup_rejects_unknown_ids() -> None:
    rows = template_report()
    assert all(isinstance(row["slots"], list) and isinstance(row["tags"], list) for row in rows)
    with pytest.raises(KeyError):
        template_by_id("does-not-exist")
