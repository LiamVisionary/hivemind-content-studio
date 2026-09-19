"""The shared media-model catalog: the projection HivemindOS reads.

Every assertion here is about the CONTRACT — the document validates against
the bundled schema both apps carry, a row lands in the right place with the
right cost and route, nothing in it names a credential — and about the doors
it is served through: the machine-lane route, the MCP, and the snapshots on
disk in both directions. The inventory is a fixture in `media_catalog()`'s
own shape, so none of this runs a provider probe; the one test that projects
the real matrix pins every probe first.
"""

from __future__ import annotations

import asyncio
import json
import re
import stat
import time
from pathlib import Path

import jsonschema
import pytest
from test_route_gates import _locked_client

from hivemind_content_studio import media_models
from hivemind_content_studio.media_models import (
    APP_ID,
    FALLBACK_REASON,
    HOSTED_AUTOMATIC_REASON,
    PEER_DOWN_REASON,
    PEER_SOURCE_DETAIL,
    PEER_UNLINKED_REASON,
    STUDIO_ONLY_REASON,
    media_model_catalog,
    read_peer_snapshots,
    schema_document,
    snapshot_dir,
    snapshot_path,
    write_snapshot,
)

# The same rule the studio's own pickers use to tell developer copy from prose.
CREDENTIAL_NAME = re.compile(r"[A-Z]{2,}_[A-Z0-9_]+")


@pytest.fixture(autouse=True)
def _own_hive_home(tmp_path: Path, monkeypatch) -> None:
    """Every build reads the shared snapshot directory. Pointed into the test's
    own directory so the developer's real HivemindOS snapshot never joins a
    fixture's rows, and nothing here writes to the real ~/.hivemindos."""
    monkeypatch.setenv("HIVE_HOME", str(tmp_path / "hive"))


def _model(model_id: str, label: str, roles: tuple[str, ...] = (), limit: int | None = 0, **extra) -> dict:
    return {
        "id": model_id, "label": label, "reference_roles": list(roles), "max_reference_images": limit,
        "accepts": [], "family": "", "beta": False, "routing_only": False, "requires_image": False, **extra,
    }


def _provider(provider_id: str, label: str, *, available: bool, models: list[dict], detail: str = "",
              needs: str = "", keys: tuple[str, ...] = ()) -> dict:
    return {
        "id": provider_id, "label": label, "available": available, "detail": detail, "needs": needs,
        "keys": list(keys), "registry_live": True, "models": models,
    }


HOSTED_UP = "HivemindOS hosted media route answered; provider keys are not required"
HOSTED_DOWN = "HivemindOS hosted media route did not answer"


def _inventory(*, hosted_available: bool = True, hosted_detail: str = HOSTED_UP) -> dict[str, list[dict]]:
    """A slice of the real inventory: one provider of each place, the two
    non-model rows a picker must not offer, a routing-only graph."""
    return {
        "image": [
            _provider("stickman-renderer", "Stickman renderer", available=True, models=[_model("automatic", "Automatic")]),
            _provider(
                "comfyui", "ComfyUI", available=True,
                detail="This machine's ComfyUI workflows are reachable through the local Media Studio route.",
                models=[
                    _model("workflow-default", "Workflow default", ("reference",), None),
                    _model("comfy-krea2-turbo-identity-edit", "Krea 2 Turbo Identity Edit", ("reference",), 1,
                           accepts=["image_base64"]),
                ],
            ),
            _provider(
                "openai-gpt-image", "OpenAI · GPT Image API", available=False,
                detail="OPENAI_API_KEY is missing; use the separate GPT Image OAuth provider if ChatGPT/Codex is connected",
                needs="Needs an OpenAI API key.", keys=("OPENAI_API_KEY",),
                models=[_model("gpt-image-2", "GPT Image 2", ("reference",), 16)],
            ),
            _provider(
                "openai-gpt-image-oauth", "OpenAI · GPT Image OAuth", available=True,
                detail="OpenAI OAuth grant is usable",
                models=[_model("gpt-image-2", "GPT Image 2", ("reference",), 16)],
            ),
            _provider(
                "hivemindos-hosted-media", "HivemindOS hosted", available=hosted_available, detail=hosted_detail,
                models=[_model("automatic", "Automatic hosted model", ("reference",), None)],
            ),
        ],
        "video": [
            _provider(
                "media-studio-mcp", "HivemindOS · Media Studio MCP", available=True,
                detail="Media Studio MCP is reachable.",
                models=[
                    _model("workflow-default", "Workflow default", ("start", "reference"), None),
                    _model("ltx23-regular-fp8", "LTX 2.3 Regular FP8", ("start", "reference"), None,
                           family="ltx-2.3", accepts=["image_base64", "loras"]),
                    _model("minimax-h3", "MiniMax H3", ("start",), None, family="minimax", requires_image=True),
                    _model("minimax-h3-reference", "MiniMax H3 Reference", ("reference",), None,
                           family="minimax", routing_only=True),
                ],
            ),
            _provider(
                "higgsfield-consumer", "Higgsfield", available=False, detail="higgsfield CLI missing",
                models=[_model("seedance_2_0", "Seedance 2.0", ("start", "end", "reference"), None)],
            ),
            _provider(
                "hivemindos-hosted-media", "HivemindOS hosted", available=hosted_available, detail=hosted_detail,
                models=[_model("automatic", "Automatic hosted model", ("start", "end", "reference"), None)],
            ),
        ],
    }


def _rows(document: dict) -> dict[str, dict]:
    return {row["key"]: row for row in document["models"]}


def _validate(document: dict) -> None:
    jsonschema.Draft202012Validator(schema_document()).validate(document)


# ── the contract ─────────────────────────────────────────────────────────────

def test_the_document_is_valid_against_the_shared_contract() -> None:
    document = media_model_catalog(inventory=_inventory())

    _validate(document)
    assert document["version"] == 1
    assert document["app"] == APP_ID
    assert document["machineName"] == ""
    assert {source["app"] for source in document["sources"]} == {APP_ID}
    assert len(_rows(document)) == len(document["models"]), "row keys must be unique"


def test_local_workflows_are_the_rows_that_run_from_chat() -> None:
    rows = _rows(media_model_catalog(inventory=_inventory()))

    still = rows["image:comfyui:comfyui:comfy-krea2-turbo-identity-edit"]
    assert still["place"] == "this-machine"
    # The SHARED words, not the studio's own "This Mac": this label sits in
    # one list beside HivemindOS's rows, which say machine.
    assert still["placeLabel"] == "This machine"
    assert still["cost"] == {"kind": "free", "label": "Free · stays on this machine"}
    assert still["credential"] == ""
    assert still["available"] is True and still["ready"] is True
    assert "reason" not in still
    # Both ids carry the workflow: HivemindOS dedupes its own MCP rows on either.
    assert still["execute"] == {
        "route": "media-studio-mcp",
        "workflowId": "comfy-krea2-turbo-identity-edit",
        "backend": "comfy-krea2-turbo-identity-edit",
    }
    assert still["capabilities"] == {
        "referenceImages": True, "maxReferenceImages": 1, "accepts": ["image_base64"], "requiresImage": False,
    }

    clip = rows["video:media-studio-mcp:media-studio-mcp:ltx23-regular-fp8"]
    assert clip["ready"] is True
    assert clip["execute"]["route"] == "media-studio-mcp"
    assert clip["capabilities"]["family"] == "ltx-2.3"
    assert clip["capabilities"]["requiresImage"] is False
    # The registry's requires.image travels through, so a text-only /video-gen
    # can keep a graph that needs a picture out of its list.
    assert rows["video:media-studio-mcp:media-studio-mcp:minimax-h3"]["capabilities"]["requiresImage"] is True


def test_account_rows_open_the_studio_and_say_so() -> None:
    rows = _rows(media_model_catalog(inventory=_inventory()))

    keyed = rows["image:openai-gpt-image:openai-gpt-image:gpt-image-2"]
    assert keyed["place"] == "your-accounts"
    assert keyed["placeLabel"] == "Your OpenAI account"
    assert keyed["credential"] == "api-key"
    assert keyed["cost"] == {"kind": "account", "label": "Billed to your OpenAI account"}
    assert keyed["available"] is False and keyed["ready"] is False
    assert keyed["reason"] == STUDIO_ONLY_REASON
    assert keyed["execute"] == {"route": "none", "openUrl": "/?page=image"}
    assert "requiresImage" not in keyed["capabilities"], "only a workflow row has the field"

    signed_in = rows["image:openai-gpt-image-oauth:openai-gpt-image-oauth:gpt-image-2"]
    assert signed_in["credential"] == "sign-in"
    # Reachable, and still not something chat can run: availability is the
    # provider's state, readiness is the route's.
    assert signed_in["available"] is True and signed_in["ready"] is False
    assert signed_in["reason"] == STUDIO_ONLY_REASON

    clip = rows["video:higgsfield-consumer:higgsfield-consumer:seedance_2_0"]
    assert clip["credential"] == "sign-in"
    assert clip["execute"] == {"route": "none", "openUrl": "/?page=video"}
    assert clip["ready"] is False


def test_the_hosted_row_is_left_for_hivemindos_to_decide() -> None:
    rows = _rows(media_model_catalog(inventory=_inventory()))

    hosted = rows["image:hivemindos-hosted-media:hivemindos-hosted-media:automatic"]
    assert hosted["place"] == "hivemindos-credits"
    assert hosted["placeLabel"] == "HivemindOS credits"
    assert hosted["cost"] == {"kind": "credits", "label": "HivemindOS credits"}
    assert hosted["execute"] == {"route": "hosted-media", "model": "automatic"}
    assert hosted["available"] is True
    assert hosted["ready"] is False
    assert hosted["reason"] == HOSTED_AUTOMATIC_REASON
    assert rows["video:hivemindos-hosted-media:hivemindos-hosted-media:automatic"]["ready"] is False


def test_placeholder_routing_only_and_non_generative_rows_are_left_out() -> None:
    document = media_model_catalog(inventory=_inventory())

    ids = {(row["provider"], row["id"]) for row in document["models"]}
    assert not any(model_id == "workflow-default" for _, model_id in ids)
    assert not any(provider == "stickman-renderer" for provider, _ in ids)
    assert ("media-studio-mcp", "minimax-h3-reference") not in ids
    assert ("media-studio-mcp", "minimax-h3") in ids
    assert "stickman-renderer" not in {source["id"] for source in document["sources"]}


def test_sources_carry_readiness_and_credential_names_only() -> None:
    sources = {source["id"]: source for source in media_model_catalog(inventory=_inventory())["sources"]}

    assert sources["comfyui"]["kind"] == "this-machine"
    assert sources["hivemindos-hosted-media"]["kind"] == "hivemindos-credits"
    openai = sources["openai-gpt-image"]
    assert openai["kind"] == "your-accounts"
    assert openai["available"] is False
    assert openai["needs"] == "Needs an OpenAI API key."
    assert openai["keys"] == ["OPENAI_API_KEY"]
    # The studio's detail names the variable; that sentence is for the
    # studio's own card, not for a document another machine reads.
    assert openai["detail"] == ""
    assert len({source["id"] for source in sources.values()}) == len(sources), "one source per provider"


def test_no_row_is_ready_without_a_route_and_no_reason_names_a_credential() -> None:
    inventory = _inventory()
    # A local provider whose readiness sentence is developer copy.
    inventory["video"].append(_provider(
        "comfyui", "ComfyUI", available=False, detail="MEDIA_STUDIO_TOKEN is not set for the local gateway",
        models=[_model("ltx23-eros-v14-dmd", "LTX 2.3 Eros v1.4 DMD", ("start",), None)],
    ))
    document = media_model_catalog(inventory=inventory)

    _validate(document)
    for row in document["models"]:
        assert not (row["ready"] and row["execute"]["route"] == "none"), row["key"]
        if not row["ready"]:
            assert row.get("reason"), f"{row['key']} is not ready and does not say why"
        assert not CREDENTIAL_NAME.search(row.get("reason", "")), row["key"]
    for source in document["sources"]:
        assert not CREDENTIAL_NAME.search(source["detail"]), source["id"]
        assert not CREDENTIAL_NAME.search(source["needs"]), source["id"]
    rows = _rows(document)
    assert rows["video:comfyui:comfyui:ltx23-eros-v14-dmd"]["reason"] == FALLBACK_REASON


def test_an_unreachable_local_workflow_keeps_the_studios_own_sentence() -> None:
    inventory = {"image": [], "video": [_provider(
        "media-studio-mcp", "HivemindOS · Media Studio MCP", available=False,
        detail="Media Studio is configured but its MCP endpoint did not answer.",
        models=[_model("minimax-h3", "MiniMax H3", ("start",), None)],
    )]}

    row = media_model_catalog(inventory=inventory)["models"][0]

    assert row["available"] is False and row["ready"] is False
    assert row["reason"] == "Media Studio is configured but its MCP endpoint did not answer."


def test_kind_narrows_the_models_and_refuses_anything_else() -> None:
    whole = media_model_catalog(inventory=_inventory())
    video = media_model_catalog("video", inventory=_inventory())

    assert {row["kind"] for row in video["models"]} == {"video"}
    assert len(video["models"]) == sum(row["kind"] == "video" for row in whole["models"])
    _validate(video)
    with pytest.raises(ValueError, match="image or video"):
        media_model_catalog("audio", inventory=_inventory())


# ── HivemindOS's snapshot, read back ─────────────────────────────────────────

def _peer_row(key: str, kind: str, model_id: str, label: str, *, place: str, place_label: str, provider: str,
              execute: dict, cost: dict, **extra) -> dict:
    return {
        "key": key, "kind": kind, "id": model_id, "label": label, "provider": provider,
        "providerLabel": provider, "sourceId": "some-hivemindos-source", "place": place,
        "placeLabel": place_label, "available": True, "ready": True, "cost": cost,
        "capabilities": {"referenceImages": False}, "execute": execute, **extra,
    }


def _peer_snapshot() -> dict:
    """What HivemindOS publishes: two priced hosted models, a fleet app, its
    own MCP listing of a lane this studio already has, and two rows nothing
    should ever read."""
    return {
        "version": 1, "app": "hivemindos", "generatedAt": "2026-09-06T10:00:00.000Z", "machineName": "Studio Mac",
        "sources": [{"id": "some-hivemindos-source", "label": "x", "kind": "fleet", "app": "hivemindos",
                     "available": True, "detail": ""}],
        "models": [
            _peer_row("image:hosted:hivemindos-hosted-media:flux-dev", "image", "flux-dev", "FLUX dev",
                      place="hivemindos-credits", place_label="HivemindOS credits", provider="hivemindos-hosted-media",
                      execute={"route": "hosted-media", "model": "flux-dev"},
                      cost={"kind": "credits", "credits": 25, "usd": 0.05, "label": "25 credits"}),
            _peer_row("video:hosted:hivemindos-hosted-media:seedance", "video", "seedance", "Seedance",
                      place="hivemindos-credits", place_label="HivemindOS credits", provider="hivemindos-hosted-media",
                      execute={"route": "hosted-media", "model": "seedance"},
                      cost={"kind": "quoted", "label": "Quoted before each run"}, ready=False,
                      reason="Top up credits in HivemindOS."),
            _peer_row("image:fleet:comfy-mini:sdxl", "image", "sdxl", "SDXL on the Mini",
                      place="fleet", place_label="Studio Mini", provider="comfyui",
                      execute={"route": "connected-app", "appId": "comfy-mini", "model": "sdxl"},
                      cost={"kind": "free", "label": "Free · stays on this machine"}, machineName="Studio Mini"),
            # HivemindOS's own listing of this machine's LTX lane: a different
            # key and a different provider name, the same graph.
            _peer_row("video:media-studio-mcp-local:media-studio:ltx23-regular-fp8", "video", "ltx23-regular-fp8",
                      "LTX 2.3 Regular FP8", place="this-machine", place_label="This machine",
                      provider="media-studio",
                      execute={"route": "media-studio-mcp", "workflowId": "ltx23-regular-fp8"},
                      cost={"kind": "free", "label": "Free · stays on this machine"}),
            # A lane on this machine the studio does NOT list (a connected app).
            _peer_row("image:app:draw-things:sd15", "image", "sd15", "SD 1.5 in Draw Things",
                      place="this-machine", place_label="This machine", provider="draw-things",
                      execute={"route": "connected-app", "appId": "draw-things", "model": "sd15"},
                      cost={"kind": "free", "label": "Free · stays on this machine"}),
            # Malformed: no cost. Unknown place. Neither may reach the document.
            {"key": "image:x:y:z", "kind": "image", "id": "z", "label": "z", "provider": "y", "providerLabel": "y",
             "sourceId": "s", "place": "fleet", "placeLabel": "p", "available": True, "ready": True,
             "capabilities": {}, "execute": {"route": "none"}},
            _peer_row("image:moon:x:y", "image", "y", "y", place="the-moon", place_label="Moon", provider="x",
                      execute={"route": "none"}, cost={"kind": "free", "label": ""}),
        ],
    }


def _write_peer(document: dict | None = None) -> Path:
    directory = snapshot_dir()
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / "hivemindos.json"
    path.write_text(json.dumps(document or _peer_snapshot()), encoding="utf-8")
    return path


def test_hivemindos_rows_join_the_document_when_the_studio_does_not_list_them() -> None:
    _write_peer()

    document = media_model_catalog(inventory=_inventory())

    _validate(document)
    rows = _rows(document)
    assert len(rows) == len(document["models"]), "row keys must stay unique after the merge"

    # The app answered the studio's readiness sweep, so a priced hosted model
    # is ready from here too: the studio's hosted client runs a model by id.
    flux = rows["image:hosted:hivemindos-hosted-media:flux-dev"]
    assert flux["sourceId"] == "hivemindos"
    assert flux["available"] is True and flux["ready"] is True
    assert flux["execute"] == {"route": "hosted-media", "model": "flux-dev"}
    assert flux["cost"] == {"kind": "credits", "credits": 25, "usd": 0.05, "label": "25 credits"}
    assert "reason" not in flux
    assert rows["video:hosted:hivemindos-hosted-media:seedance"]["ready"] is True
    # The studio's own Automatic row stays: HivemindOS drops it in favour of
    # these; an agent reading this document still sees the hosted place.
    assert "image:hivemindos-hosted-media:hivemindos-hosted-media:automatic" in rows

    fleet = rows["image:fleet:comfy-mini:sdxl"]
    assert fleet["place"] == "fleet" and fleet["machineName"] == "Studio Mini"
    assert fleet["execute"] == {"route": "connected-app", "appId": "comfy-mini", "model": "sdxl"}
    assert rows["image:app:draw-things:sd15"]["place"] == "this-machine"

    # The lane HivemindOS lists through its own MCP source is the studio's
    # own LTX graph: once, under the studio's key.
    ltx = [row for row in rows.values() if row["execute"].get("workflowId") == "ltx23-regular-fp8"]
    assert [row["key"] for row in ltx] == ["video:media-studio-mcp:media-studio-mcp:ltx23-regular-fp8"]
    assert "video:media-studio-mcp-local:media-studio:ltx23-regular-fp8" not in rows

    assert "image:x:y:z" not in rows and "image:moon:x:y" not in rows

    peer = next(source for source in document["sources"] if source["id"] == "hivemindos")
    assert peer == {
        "id": "hivemindos", "label": "HivemindOS", "kind": "hivemindos-credits", "app": "hivemindos",
        "available": True, "detail": PEER_SOURCE_DETAIL, "machineName": "Studio Mac",
    }
    assert "some-hivemindos-source" not in {source["id"] for source in document["sources"]}


def test_when_the_snapshot_is_the_only_evidence_hivemindos_rows_are_not_ready() -> None:
    _write_peer()

    document = media_model_catalog(inventory=_inventory(hosted_available=False, hosted_detail=HOSTED_DOWN))

    _validate(document)
    rows = _rows(document)
    for key in ("image:hosted:hivemindos-hosted-media:flux-dev", "image:fleet:comfy-mini:sdxl",
                "image:app:draw-things:sd15"):
        assert rows[key]["available"] is False and rows[key]["ready"] is False, key
        assert rows[key]["reason"] == HOSTED_DOWN, key
    peer = next(source for source in document["sources"] if source["id"] == "hivemindos")
    assert peer["available"] is False

    # A detail that names the token is not shown; the link is what is missing.
    unlinked = media_model_catalog(inventory=_inventory(
        hosted_available=False, hosted_detail="HIVEMINDOS_DASHBOARD_DEVICE_TOKEN is missing"))
    assert _rows(unlinked)["image:fleet:comfy-mini:sdxl"]["reason"] == PEER_UNLINKED_REASON
    # And a hosted row with no sentence at all still says why.
    bare = media_model_catalog(inventory=_inventory(hosted_available=False, hosted_detail=""))
    assert _rows(bare)["image:fleet:comfy-mini:sdxl"]["reason"] == PEER_DOWN_REASON
    for row in [*unlinked["models"], *bare["models"]]:
        assert not CREDENTIAL_NAME.search(row.get("reason", "")), row["key"]


def test_without_a_hivemindos_snapshot_the_document_is_the_studios_alone() -> None:
    alone = media_model_catalog(inventory=_inventory())
    _write_peer()
    merged = media_model_catalog(inventory=_inventory())

    assert "hivemindos" not in {source["id"] for source in alone["sources"]}
    assert not any(row["sourceId"] == "hivemindos" for row in alone["models"])
    # The merge only ADDS: the studio's own rows and sources are untouched.
    assert merged["models"][: len(alone["models"])] == alone["models"]
    assert merged["sources"][: len(alone["sources"])] == alone["sources"]
    assert len(merged["models"]) == len(alone["models"]) + 4
    # Narrowing applies to the merged rows too.
    assert {row["kind"] for row in media_model_catalog("image", inventory=_inventory())["models"]} == {"image"}


def test_a_snapshot_from_a_newer_version_or_another_app_is_ignored() -> None:
    _write_peer({**_peer_snapshot(), "version": 2})
    assert not any(row["sourceId"] == "hivemindos" for row in media_model_catalog(inventory=_inventory())["models"])
    _write_peer({**_peer_snapshot(), "app": "someone-else"})
    assert not any(row["sourceId"] == "hivemindos" for row in media_model_catalog(inventory=_inventory())["models"])


# ── the snapshot ─────────────────────────────────────────────────────────────

def test_the_snapshot_round_trips_and_only_peers_are_read(tmp_path: Path) -> None:
    document = media_model_catalog(inventory=_inventory())

    written = write_snapshot(document)

    assert written == tmp_path / "hive" / "media-catalog" / "hivemind-content-studio.json"
    assert written == snapshot_path()
    assert stat.S_IMODE(written.stat().st_mode) == 0o600
    # The directory too: another account on this machine may not even list
    # which apps publish here.
    assert stat.S_IMODE(written.parent.stat().st_mode) == 0o700
    assert json.loads(written.read_text(encoding="utf-8")) == document
    # Nothing left behind from the atomic write.
    assert sorted(path.name for path in written.parent.iterdir()) == [written.name]

    peer = {"version": 1, "app": "hivemindos", "generatedAt": "2026-09-06T00:00:00.000Z", "sources": [], "models": []}
    (written.parent / "hivemindos.json").write_text(json.dumps(peer), encoding="utf-8")
    (written.parent / "broken.json").write_text("{not json", encoding="utf-8")
    (written.parent / "wrong-version.json").write_text(json.dumps({**peer, "version": 2}), encoding="utf-8")
    (written.parent / "no-models.json").write_text(json.dumps({"version": 1, "app": "hivemindos"}), encoding="utf-8")
    (written.parent / ".hivemind-content-studio-partial.json").write_text(json.dumps(peer), encoding="utf-8")

    assert read_peer_snapshots() == [peer]


def test_a_directory_that_already_existed_too_open_is_closed(tmp_path: Path) -> None:
    directory = tmp_path / "hive" / "media-catalog"
    directory.mkdir(parents=True)
    directory.chmod(0o755)

    assert write_snapshot(media_model_catalog(inventory=_inventory())) is not None
    assert stat.S_IMODE(directory.stat().st_mode) == 0o700


def test_write_snapshot_never_raises(tmp_path: Path, monkeypatch) -> None:
    blocker = tmp_path / "not-a-directory"
    blocker.write_text("", encoding="utf-8")
    monkeypatch.setenv("HIVE_HOME", str(blocker))

    assert write_snapshot(media_model_catalog(inventory=_inventory())) is None
    assert read_peer_snapshots() == []


# ── the route ────────────────────────────────────────────────────────────────

def _settled(client, deadline_seconds: float = 20.0) -> dict:
    """The catalog once the shared refresh thread has built the inventory."""
    deadline = time.monotonic() + deadline_seconds
    while time.monotonic() < deadline:
        payload = client.get("/api/media-models").json()
        if not payload.get("pending"):
            return payload
        time.sleep(0.05)
    raise AssertionError("the media-model catalog stayed pending")


def _pin_simple_catalog_build(monkeypatch, inventory) -> list[int]:
    """The simple catalog's build, with its two probes replaced: the media
    sweep by the fixture (counted), the brains call by an empty answer."""
    from hivemind_content_studio import control_api

    sweeps: list[int] = []

    def counted() -> dict:
        sweeps.append(1)
        return inventory()

    monkeypatch.setattr(control_api, "media_catalog", counted)
    monkeypatch.setattr(control_api, "brain_catalog", lambda: {"providers": []})
    return sweeps


def test_the_route_projects_the_cached_inventory_and_says_pending_until_there_is_one(tmp_path: Path, monkeypatch) -> None:
    sweeps = _pin_simple_catalog_build(monkeypatch, _inventory)
    client, _ = _locked_client(tmp_path, monkeypatch)

    # Cold: no inventory yet. The answer is "come back", not a sweep run
    # inside this request, and the empty document is still a valid one.
    first = client.get("/api/media-models")
    assert first.status_code == 200
    assert first.json()["pending"] is True
    assert first.headers["retry-after"] == "2"
    assert first.json()["catalog"]["models"] == []
    _validate(first.json()["catalog"])

    payload = _settled(client)
    assert payload["ok"] is True and "pending" not in payload
    _validate(payload["catalog"])
    assert payload["catalog"]["app"] == APP_ID
    assert {row["provider"] for row in payload["catalog"]["models"]} >= {"comfyui", "media-studio-mcp"}
    assert (tmp_path / "hive" / "media-catalog" / "hivemind-content-studio.json").is_file()

    video = client.get("/api/media-models", params={"kind": "video"}).json()["catalog"]
    assert {row["kind"] for row in video["models"]} == {"video"}
    assert len(video["sources"]) == len(payload["catalog"]["sources"]), "the sources stay whole"
    _validate(video)
    # One sweep, by the shared refresh thread — never one per request.
    assert sweeps == [1]

    assert client.get("/api/media-models", params={"kind": "audio"}).status_code == 400


def test_the_route_lists_hivemindos_rows_from_its_snapshot(tmp_path: Path, monkeypatch) -> None:
    _pin_simple_catalog_build(monkeypatch, _inventory)
    _write_peer()
    client, _ = _locked_client(tmp_path, monkeypatch)

    rows = _rows(_settled(client)["catalog"])

    assert rows["image:hosted:hivemindos-hosted-media:flux-dev"]["sourceId"] == "hivemindos"
    assert "video:media-studio-mcp-local:media-studio:ltx23-regular-fp8" not in rows


def test_a_projection_that_fails_answers_a_sentence_not_a_traceback(tmp_path: Path, monkeypatch) -> None:
    from hivemind_content_studio.api import media_models as media_models_routes

    _pin_simple_catalog_build(monkeypatch, _inventory)

    def broken(*_args, **_kwargs) -> dict:
        raise RuntimeError("registry exploded at /Users/someone/private/path")

    monkeypatch.setattr(media_models_routes, "media_model_catalog", broken)
    client, _ = _locked_client(tmp_path, monkeypatch)
    assert client.get("/api/media-models").json()["pending"] is True

    deadline = time.monotonic() + 20.0
    while time.monotonic() < deadline:
        response = client.get("/api/media-models")
        if response.status_code != 200:
            break
        assert response.json().get("pending") is True, "a broken projection answered a catalog"
        time.sleep(0.05)
    assert response.status_code == 503
    assert "could not be built" in response.json()["detail"]
    assert "/Users/someone" not in response.text


# ── the MCP ──────────────────────────────────────────────────────────────────

def _tool_payload(result) -> dict:
    """`call_tool` answers structured output as a dict, else as content
    blocks whose text is the JSON — accept either shape."""
    if isinstance(result, dict):
        return result.get("result", result) if set(result) == {"result"} else result
    blocks = list(result)
    return json.loads(blocks[0].text)


def test_the_mcp_tool_and_resource_carry_the_same_document(monkeypatch) -> None:
    from hivemind_content_studio.mcp_server import build_mcp_server

    monkeypatch.setattr(media_models, "media_catalog", _inventory)
    _write_peer()
    server = build_mcp_server()

    payload = _tool_payload(asyncio.run(server.call_tool("list_media_models", {"kind": "video"})))
    assert payload["ok"] is True
    assert payload["privacy"] == "machine-redacted"
    _validate(payload["catalog"])
    assert {row["kind"] for row in payload["catalog"]["models"]} == {"video"}
    assert "video:hosted:hivemindos-hosted-media:seedance" in _rows(payload["catalog"])

    contents = list(asyncio.run(server.read_resource("studio://media-models")))
    resource = json.loads(contents[0].content)
    assert resource["privacy"] == "machine-redacted"
    _validate(resource["catalog"])
    assert {row["kind"] for row in resource["catalog"]["models"]} == {"image", "video"}


# ── the real inventory ───────────────────────────────────────────────────────

def test_the_real_inventory_projects_into_a_valid_document(monkeypatch) -> None:
    """Not a fixture: `media_catalog()` itself. Every dataclass field the
    inventory grows has to survive the projection, and the schema is the
    judge. Hermetic by construction: the workflow registry answers with the
    built-in list, every readiness probe is pinned offline and every key
    variable is cleared, so the same document comes out whatever happens to
    be listening on this machine."""
    from hivemind_content_studio import hivemindos_hosted_media, hivemindos_oauth, media_catalog, media_studio, providers

    monkeypatch.setattr(
        media_catalog, "_media_studio_registry",
        lambda status=None: (media_catalog.BUILT_IN_MEDIA_STUDIO_VIDEO_MODELS, False),
    )
    monkeypatch.setattr(media_studio, "media_studio_status", lambda: {
        "configured": False, "auth_present": False, "reachable": False,
        "detail": "No Media Studio mcpVideo preference or environment override was found.",
    })
    monkeypatch.setattr(hivemindos_hosted_media, "hosted_media_status", lambda: {
        "configured": False, "reachable": False, "detail": "HIVEMINDOS_DASHBOARD_DEVICE_TOKEN is missing",
    })
    monkeypatch.setattr(hivemindos_oauth, "oauth_provider_status",
                        lambda provider: {"usable": False, "detail": f"{provider} OAuth is unavailable"})
    monkeypatch.setattr(providers, "_http_reachable", lambda *_args, **_kwargs: False)
    monkeypatch.setattr(providers.shutil, "which", lambda _name: None)
    for key in {key for provider in providers.PROVIDER_MATRIX for key in provider.keys} | {
        "MUAPI_KEY", "PEXELS_API_KEYS", "PIXABAY_API_KEYS",
    }:
        monkeypatch.delenv(key, raising=False)

    document = media_model_catalog()

    _validate(document)
    rows = _rows(document)
    assert rows, "the real matrix projects to no rows at all"
    assert all(row["available"] is False for row in rows.values()), "every probe was pinned offline"
    assert any(row["provider"] == "media-studio-mcp" and row["kind"] == "video" for row in rows.values())
    assert all(
        row["capabilities"].get("requiresImage") is False
        for row in rows.values() if row["provider"] in {"media-studio-mcp", "comfyui"}
    ), "the built-in list does not know, and says so"
    assert not any(row["id"] == "workflow-default" for row in rows.values())
    for row in rows.values():
        assert not (row["ready"] and row["execute"]["route"] == "none"), row["key"]
        assert not CREDENTIAL_NAME.search(row.get("reason", "")), row["key"]
    assert media_model_catalog()["models"] == document["models"], "deterministic"
