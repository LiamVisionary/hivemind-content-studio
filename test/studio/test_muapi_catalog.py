"""The one MUAPI catalog — the file, the merge rule, and who reads it.

There used to be two lists of the same provider's models: a vendored 12,779-line
copy in the browser and a hand-typed one here. These tests are what stops a
second one growing back, and what pins the narrow rule a live schema read must
obey so a refresh cannot quietly change what the studios offer.
"""

from __future__ import annotations

import json

import pytest

from hivemind_content_studio import media_catalog, muapi_catalog


# ---- the file ---------------------------------------------------------------


def test_catalog_ships_every_bucket_the_client_indexes():
    buckets = muapi_catalog.buckets()
    assert set(buckets) == set(muapi_catalog.BUCKETS)
    # The studios' cloud model universe. A catalog that lost a bucket would
    # empty a studio's picker.
    assert len(buckets["t2i"]) > 40
    assert len(buckets["t2v"]) > 40
    assert len(buckets["i2i"]) > 40
    assert len(buckets["i2v"]) > 40
    assert buckets["v2v"] and buckets["lipsync"] and buckets["audio"]


def test_every_row_has_an_id_a_name_and_a_resolvable_endpoint():
    for row in muapi_catalog.rows():
        assert row.get("id"), row
        assert row.get("name"), row
        # Most rows carry no explicit endpoint because it equals the id, and the
        # browser has resolved it that way since the first version.
        assert muapi_catalog.endpoint_for(row) == (row.get("endpoint") or row["id"])


def test_ids_are_unique_within_a_bucket():
    for name, rows in muapi_catalog.buckets().items():
        ids = [row["id"] for row in rows]
        assert len(set(ids)) == len(ids), f"{name} has a duplicate id"


def test_pinned_inputs_name_inputs_the_row_actually_declares():
    # A pin records that we hold an input away from upstream on purpose. One
    # naming an input that is not there records nothing.
    for row in muapi_catalog.rows():
        for key in row.get("pinned") or ():
            assert key in (row.get("inputs") or {}), f"{row['id']} pins unknown input {key}"


def test_label_and_knows_answer_off_the_catalog():
    assert muapi_catalog.knows("nano-banana")
    assert muapi_catalog.label_for("nano-banana") == "Nano Banana"
    assert not muapi_catalog.knows("no-such-model")
    # An unknown id is echoed back rather than blanked: a name is the only thing
    # a picker row has to show.
    assert muapi_catalog.label_for("no-such-model") == "no-such-model"


# ---- the merge rule ---------------------------------------------------------


def _catalog(inputs, pinned=None):
    row = {"id": "m", "name": "M", "inputs": inputs}
    if pinned:
        row["pinned"] = pinned
    return {"buckets": {"t2i": [row]}}


def _merged(inputs, live, pinned=None):
    merged = muapi_catalog.merge_schemas(_catalog(inputs, pinned), {"m": live})
    return merged["buckets"]["t2i"][0]["inputs"]


def test_a_live_read_refreshes_an_input_the_row_declares():
    inputs = _merged({"aspect_ratio": {"enum": ["1:1"]}}, {"aspect_ratio": {"enum": ["1:1", "16:9"]}})
    assert inputs["aspect_ratio"]["enum"] == ["1:1", "16:9"]


def test_a_live_read_never_adds_an_input():
    # The studio supplies uploads from its own uploader and records WHICH field
    # to fill on the row. Pasting the provider's upload inputs back would render
    # a URL box beside every upload button.
    inputs = _merged({"prompt": {"type": "string"}}, {"prompt": {"type": "string"}, "image_url": {"type": "string"}})
    assert set(inputs) == {"prompt"}


def test_a_live_read_never_removes_an_input():
    # Thirteen models the studios still offer are already absent from the
    # provider's listing; an input can go the same way, and dropping the control
    # is not the catalog's call to make.
    inputs = _merged({"prompt": {"type": "string"}, "seed": {"type": "int"}}, {"prompt": {"type": "string"}})
    assert set(inputs) == {"prompt", "seed"}
    assert inputs["seed"] == {"type": "int"}


def test_a_pinned_input_is_held_against_upstream():
    # Seedance 2.5's duration ladder is ours: upstream declares a 4-30 range,
    # which the picker would collapse to the default alone.
    inputs = _merged(
        {"duration": {"enum": [5, 10, 15, 20, 25, 30]}},
        {"duration": {"minValue": 4, "maxValue": 30, "step": 1}},
        pinned=["duration"],
    )
    assert inputs["duration"] == {"enum": [5, 10, 15, 20, 25, 30]}


def test_a_row_with_no_live_schema_is_returned_untouched():
    catalog = _catalog({"prompt": {"type": "string"}})
    assert muapi_catalog.merge_schemas(catalog, {}) == catalog


def test_seedance_25_keeps_its_thirty_second_ladder_through_a_merge():
    catalog = muapi_catalog.shipped_catalog()
    row = next(r for r in catalog["buckets"]["t2v"] if r["id"] == "seedance-2.5-text-to-video")
    assert row["inputs"]["duration"]["enum"] == [5, 10, 15, 20, 25, 30]
    merged = muapi_catalog.merge_schemas(
        catalog, {"seedance-2.5-text-to-video": {"duration": {"minValue": 4, "maxValue": 30, "step": 1}}},
    )
    after = next(r for r in merged["buckets"]["t2v"] if r["id"] == "seedance-2.5-text-to-video")
    assert after["inputs"]["duration"]["enum"] == [5, 10, 15, 20, 25, 30]


# ---- the live read ----------------------------------------------------------


def _forward(answers):
    def forward(*, method, path, **_):
        assert method == "GET"
        endpoint = path.rsplit("/", 1)[-1]
        if endpoint not in answers:
            return 404, b"{}", {}
        body = {"input_schema": {"schemas": {"input_data": {"properties": answers[endpoint]}}}}
        return 200, json.dumps(body).encode(), {}
    return forward


def test_fetch_schemas_skips_what_the_provider_no_longer_serves():
    found = muapi_catalog.fetch_schemas(
        ["here", "gone"], forward=_forward({"here": {"prompt": {"type": "string"}}}), workers=2,
    )
    assert found == {"here": {"prompt": {"type": "string"}}}


def test_fetch_schemas_survives_a_transport_failure():
    def forward(**_):
        raise OSError("provider did not answer")
    assert muapi_catalog.fetch_schemas(["a", "b"], forward=forward, workers=2) == {}


def test_the_schema_cache_keeps_the_last_answer_when_a_read_comes_back_empty():
    cache = muapi_catalog.SchemaCache(ttl=0.0)
    cache._schemas = {"here": {"prompt": {"type": "string"}}}
    cache.refresh(forward=_forward({}))
    assert cache.schemas == {"here": {"prompt": {"type": "string"}}}
    # Stamped even so, or a provider that keeps failing would rebuild inside
    # every request instead of backing off.
    assert cache.fetched_at > 0


def test_the_payload_answers_from_the_shipped_rows_before_any_live_read():
    cache = muapi_catalog.SchemaCache()
    payload = muapi_catalog.catalog_payload(cache=cache)
    assert payload["ok"] is True
    assert set(payload["buckets"]) == set(muapi_catalog.BUCKETS)
    # 0 says "these are the shipped rows", so nothing can claim they are live.
    assert payload["schemas_fetched_at"] == 0
    assert payload["generated_at"]


def test_the_payload_folds_in_a_live_read_once_one_has_landed():
    cache = muapi_catalog.SchemaCache(ttl=1e9)
    cache._schemas = {"nano-banana": {"aspect_ratio": {"enum": ["1:1", "32:9"]}}}
    cache._at = 1.0
    payload = muapi_catalog.catalog_payload(cache=cache)
    row = next(r for r in payload["buckets"]["t2i"] if r["id"] == "nano-banana")
    assert row["inputs"]["aspect_ratio"]["enum"] == ["1:1", "32:9"]
    assert payload["schemas_fetched_at"] == 1.0


def test_a_machine_with_no_provider_key_never_starts_a_schema_read(monkeypatch):
    monkeypatch.setattr(muapi_catalog.muapi_proxy, "has_server_key", lambda: False)
    assert muapi_catalog.SchemaCache(ttl=0.0).kick() is False


# ---- the server's own rows come from the same catalog ------------------------


def test_the_producers_muapi_rows_are_named_by_the_catalog():
    catalog = media_catalog.media_catalog()
    rows = [
        model
        for kind in ("image", "video")
        for provider in catalog[kind]
        if provider["id"] == "muapi"
        for model in provider["models"]
    ]
    assert rows, "the producer offers MUAPI models"
    for model in rows:
        assert muapi_catalog.knows(model["id"]), f"{model['id']} is not in the MUAPI catalog"
        assert model["label"] == muapi_catalog.label_for(model["id"])


def test_the_producer_cannot_offer_a_model_the_catalog_does_not_carry():
    with pytest.raises(ValueError, match="no model 'not-a-model'"):
        media_catalog._muapi_models(("not-a-model", ("reference",)))
