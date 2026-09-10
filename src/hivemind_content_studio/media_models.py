"""Every image and video model this machine can reach, in the shape HivemindOS reads.

HivemindOS chat is growing a runtime-and-model picker for ``/image-gen`` and
``/video-gen``, and it wants to offer everything the owner can actually run:
the apps on their fleet, their HivemindOS credits, and everything this studio
knows — the local ComfyUI and Media Studio workflows, the provider accounts,
the hosted route. The studio already has that inventory (:mod:`media_catalog`)
but in its own dialect: provider rows with ``needs``/``keys``, model rows with
reference roles, readiness sentences written for the studio's own cards. This
module says the same thing in the ONE vocabulary both apps agreed on
(``catalog/media-model-catalog.v1.schema.json``, byte-identical in the
HivemindOS repository), so either app can read the other's discovery — and,
through the snapshots under ``~/.hivemindos/media-catalog/``, can still read it
when the other app is not running: this document also carries the rows from
HivemindOS's last snapshot that the studio does not list itself.

It is a PROJECTION, not a new probe. The document is built from the same
inventory ``/api/catalog`` and ``/api/providers`` already publish on the
machine lane; nothing here calls out to HivemindOS, a provider, or a
credential store, so serving it to a caller with no session adds no reach
that lane did not already have.

What a row says: where it runs (``place`` — this machine, HivemindOS credits,
or one of the owner's own accounts), what it costs in that place's terms,
whether it can be reached right now (``available``), whether picking it from
HivemindOS chat will actually run something (``ready``, with a ``reason`` in
prose when not), and how to run it (``execute``). What a row never carries: a
prompt, a media name, a private absolute path, a Tailnet address, or a
credential VALUE. The credential NAMES a source is waiting for ride in
``keys`` — the same class of data ``/api/providers`` already publishes.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .capability_matrix import is_selectable
from .media_catalog import media_catalog
from .providers import PROVIDER_MATRIX

APP_ID = "hivemind-content-studio"
CATALOG_VERSION = 1
KINDS = ("image", "video")
SCHEMA_PATH = Path(__file__).resolve().parent / "catalog" / "media-model-catalog.v1.schema.json"

PLACE_THIS_MACHINE = "this-machine"
PLACE_CREDITS = "hivemindos-credits"
PLACE_ACCOUNTS = "your-accounts"

HOSTED_PROVIDER = "hivemindos-hosted-media"
# The providers whose model ids are Media Studio workflow ids. HivemindOS runs
# them through the same Media Studio MCP this studio does, so these are the
# rows that are ready from chat.
LOCAL_WORKFLOW_PROVIDERS = frozenset({"comfyui", "media-studio-mcp"})

# What a caller is told when a provider is not ready and none of the studio's
# own sentences can be shown (they name the credential).
FALLBACK_REASON = "Needs a credential in the studio's Providers view"
# A provider-account row has no HivemindOS route yet: the row opens the studio.
STUDIO_ONLY_REASON = "Runs only inside Hivemind Content Studio for now."
# HivemindOS is authoritative for hosted rows and drops this one when it has
# its own; it exists so a studio-only reader still sees the hosted place.
HOSTED_AUTOMATIC_REASON = "HivemindOS chooses the hosted model."

# The other publisher of this contract, and how its rows are labelled here.
PEER_APP = "hivemindos"
PEER_SOURCE_ID = "hivemindos"
PEER_SOURCE_DETAIL = "Listed from HivemindOS's last snapshot."
PEER_DOWN_REASON = "HivemindOS is not running."
PEER_UNLINKED_REASON = "HivemindOS is not linked to this studio."
_MODEL_PLACES = frozenset({PLACE_THIS_MACHINE, "fleet", PLACE_CREDITS, PLACE_ACCOUNTS})
_EXECUTE_ROUTES = frozenset({"connected-app", "media-studio-mcp", "hosted-media", "content-studio", "none"})
_COST_KINDS = frozenset({"free", "credits", "account", "rental", "quoted"})


@dataclass(frozen=True)
class ProviderPlace:
    """Where one of the studio's providers runs, in HivemindOS's three-place
    vocabulary.

    Mirrors ``PROVIDER_TRANSPORTS`` in
    ``packages/open-generative-ai/src/lib/modelRunner.js``: the studio's own
    pickers already file rows by that table, and two tables that disagree would
    put the same model under two different bills. ``credential`` is set only
    where the same account is reachable two ways (an API key and a sign-in), so
    a picker can tell the siblings apart; ``account`` is whose bill a
    your-accounts row lands on, for the cost sentence.
    """

    place: str
    place_label: str
    credential: str = ""
    account: str = ""


PROVIDER_PLACES: dict[str, ProviderPlace] = {
    # "This machine", not the studio's own "This Mac": the label is read
    # beside HivemindOS's rows, which say machine, and one list must not
    # spell the same place two ways.
    "comfyui": ProviderPlace(PLACE_THIS_MACHINE, "This machine"),
    "media-studio-mcp": ProviderPlace(PLACE_THIS_MACHINE, "This machine"),
    HOSTED_PROVIDER: ProviderPlace(PLACE_CREDITS, "HivemindOS credits"),
    "openai-gpt-image": ProviderPlace(PLACE_ACCOUNTS, "Your OpenAI account", "api-key", "OpenAI"),
    "openai-gpt-image-oauth": ProviderPlace(PLACE_ACCOUNTS, "Your OpenAI account", "sign-in", "OpenAI"),
    "xai-imagine-api": ProviderPlace(PLACE_ACCOUNTS, "Your xAI account", "api-key", "xAI"),
    "xai-imagine-oauth": ProviderPlace(PLACE_ACCOUNTS, "Your xAI account", "sign-in", "xAI"),
    "higgsfield-consumer": ProviderPlace(PLACE_ACCOUNTS, "Your Higgsfield account", "sign-in", "Higgsfield"),
    "higgsfield-cloud": ProviderPlace(PLACE_ACCOUNTS, "Your Higgsfield account", "api-key", "Higgsfield"),
    "muapi": ProviderPlace(PLACE_ACCOUNTS, "MUAPI account", "", "MUAPI"),
}

_SOURCE_KIND_BY_PLACE = {
    PLACE_THIS_MACHINE: "this-machine",
    PLACE_CREDITS: "hivemindos-credits",
    PLACE_ACCOUNTS: "your-accounts",
}
_PROVIDER_MODES = {provider.id: provider.mode for provider in PROVIDER_MATRIX}

# A credential name: SCREAMING_SNAKE with an underscore, which is what every
# key in the registry looks like and what no English sentence does (the same
# rule as CREDENTIAL_NAME in runTargets.js).
_CREDENTIAL_NAME = re.compile(r"[A-Z]{2,}_[A-Z0-9_]+")
# An address. A readiness sentence may quote the endpoint it probed, and that
# endpoint can be a tailnet name or a path under the owner's home; neither
# belongs in a document another machine reads.
_ADDRESS = re.compile(r"(?:https?://\S+|\b\d{1,3}(?:\.\d{1,3}){3}\b|\[[0-9a-fA-F:]+\]|/(?:Users|home)/\S+)")


def schema_document() -> dict[str, Any]:
    """The bundled contract, for validation."""
    return json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))


def media_model_catalog(kind: str | None = None, *, inventory: dict[str, list[dict]] | None = None) -> dict[str, Any]:
    """The catalog document, valid against the shared schema.

    ``inventory`` is the studio's typed media inventory in
    :func:`media_catalog.media_catalog`'s shape — one readiness sweep, the
    live Media Studio workflow registry when it answers. A caller that already
    holds one (the control API's cache) passes it in; otherwise one is read.
    ``kind`` narrows the models to ``"image"`` or ``"video"``; the sources
    stay whole.

    After the studio's own rows come the ones HivemindOS published in its last
    snapshot that the studio does not list itself (see :func:`merge_peer`), so
    an agent reading this document sees what HivemindOS can reach — its fleet,
    its priced hosted models — and not only what this studio can.
    """
    wanted = _wanted_kinds(kind)
    inventory = inventory if inventory is not None else media_catalog()
    sources: dict[str, dict[str, Any]] = {}
    models: list[dict[str, Any]] = []
    for media_kind in KINDS:
        if media_kind not in wanted:
            continue
        for provider in inventory.get(media_kind, []):
            provider_id = str(provider.get("id") or "").strip()
            where = _place_for(provider_id, provider)
            if not provider_id or where is None:
                continue
            rows = [
                _model_row(media_kind, provider, where, model)
                for model in provider.get("models", [])
                if _pickable(provider_id, model)
            ]
            if not rows:
                # A provider with nothing a person can pick (the stick-figure
                # renderer, a registry that answered only the routing
                # sentinel) is not a source the picker can show either.
                continue
            sources.setdefault(provider_id, _source(provider_id, provider, where))
            models.extend(rows)
    peer = next((document for document in read_peer_snapshots() if document.get("app") == PEER_APP), None)
    if peer is not None:
        merge_peer(peer, sources, models, wanted=wanted, hosted=_hosted_readiness(inventory))
    return {**empty_catalog(), "sources": list(sources.values()), "models": models}


def empty_catalog() -> dict[str, Any]:
    """A valid document with nothing in it — what a caller gets while the
    inventory behind the real one is still being built."""
    return {
        "version": CATALOG_VERSION,
        "app": APP_ID,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
        # The studio has no display name for the machine that is not a
        # hostname, and a hostname is not something to publish. HivemindOS
        # fills this in from its own fleet identity where it has one.
        "machineName": "",
        "sources": [],
        "models": [],
    }


def _wanted_kinds(kind: str | None) -> tuple[str, ...]:
    value = str(kind or "").strip().lower()
    if not value:
        return KINDS
    if value not in KINDS:
        raise ValueError("kind must be image or video")
    return (value,)


def _place_for(provider_id: str, provider: dict[str, Any]) -> ProviderPlace | None:
    """Where a provider's rows go, or None for one that has no place at all.

    A provider missing from the table is filed by its readiness mode — local
    and tailnet providers run on this machine, cloud ones on the owner's
    account — so a new provider is not invisible to HivemindOS on the day it
    is added. A manual-mode provider is nothing a picker can run and is left
    out.
    """
    known = PROVIDER_PLACES.get(provider_id)
    if known is not None:
        return known
    mode = _PROVIDER_MODES.get(provider_id, "")
    label = str(provider.get("label") or provider_id).strip()
    if mode in {"local", "tailnet"}:
        return ProviderPlace(PLACE_THIS_MACHINE, "This machine")
    if mode == "cloud":
        return ProviderPlace(PLACE_ACCOUNTS, f"Your {label} account", "", label)
    return None


def _source(provider_id: str, provider: dict[str, Any], where: ProviderPlace) -> dict[str, Any]:
    return {
        "id": provider_id,
        "label": str(provider.get("label") or provider_id).strip() or provider_id,
        "kind": _SOURCE_KIND_BY_PLACE.get(where.place, "content-studio"),
        "app": APP_ID,
        "available": bool(provider.get("available")),
        "detail": _prose(provider.get("detail")),
        "needs": _prose(provider.get("needs")),
        # Names only, never values — what the Providers view would ask for.
        "keys": [str(key) for key in provider.get("keys") or [] if str(key).strip()],
    }


def _pickable(provider_id: str, model: dict[str, Any]) -> bool:
    """A row a person could choose: not the ``workflow-default`` routing
    sentinel, not a renderer of stick figures or text cards, and not a graph
    the studio only reaches by routing (offering it by hand strands the run on
    a graph with no inputs)."""
    model_id = str(model.get("id") or "").strip()
    return bool(model_id) and is_selectable(provider_id, model_id) and not bool(model.get("routing_only"))


def _model_row(kind: str, provider: dict[str, Any], where: ProviderPlace, model: dict[str, Any]) -> dict[str, Any]:
    provider_id = str(provider.get("id") or "").strip()
    model_id = str(model.get("id") or "").strip()
    available = bool(provider.get("available"))
    execute = _execute(kind, provider_id, model_id)
    ready, reason = _readiness(provider, where, execute, available)
    row: dict[str, Any] = {
        "key": f"{kind}:{provider_id}:{provider_id}:{model_id}",
        "kind": kind,
        "id": model_id,
        "label": str(model.get("label") or model_id).strip() or model_id,
        "provider": provider_id,
        "providerLabel": str(provider.get("label") or provider_id).strip() or provider_id,
        "sourceId": provider_id,
        "place": where.place,
        "placeLabel": where.place_label,
        "available": available,
        "ready": ready,
        "credential": where.credential,
        "cost": _cost_for(where, provider_id),
        "capabilities": _capabilities(provider_id, model),
        "execute": execute,
    }
    if reason:
        row["reason"] = reason
    return row


def _execute(kind: str, provider_id: str, model_id: str) -> dict[str, Any]:
    """How HivemindOS runs the row.

    Local workflows (image or video) go through the Media Studio MCP that
    HivemindOS already speaks; ``workflowId`` and ``backend`` both carry the
    id because HivemindOS dedupes its own MCP rows against these on either.
    The hosted place is HivemindOS's own route. A provider-account row has no
    HivemindOS route yet, so it opens the studio's page for that kind.
    """
    if provider_id in LOCAL_WORKFLOW_PROVIDERS:
        return {"route": "media-studio-mcp", "workflowId": model_id, "backend": model_id}
    if provider_id == HOSTED_PROVIDER:
        return {"route": "hosted-media", "model": model_id}
    return {"route": "none", "openUrl": f"/?page={kind}"}


def _readiness(
    provider: dict[str, Any], where: ProviderPlace, execute: dict[str, Any], available: bool
) -> tuple[bool, str]:
    """Whether picking the row from HivemindOS chat runs something, and if
    not, one sentence a person can act on. Only a reachable local workflow is
    ready; every other row says why in words that never name a credential."""
    if execute["route"] == "none":
        return False, STUDIO_ONLY_REASON
    if where.place == PLACE_CREDITS:
        return False, HOSTED_AUTOMATIC_REASON
    if not available:
        return False, _prose(provider.get("needs"), provider.get("detail")) or FALLBACK_REASON
    return True, ""


def _capabilities(provider_id: str, model: dict[str, Any]) -> dict[str, Any]:
    roles = [str(role) for role in model.get("reference_roles") or []]
    limit = model.get("max_reference_images", 0)
    # 0 means the model takes no reference at all; None means it takes them
    # without a declared ceiling.
    takes_references = bool(roles) and limit != 0
    capabilities: dict[str, Any] = {"referenceImages": takes_references}
    if takes_references:
        capabilities["maxReferenceImages"] = limit if isinstance(limit, int) and limit >= 0 else None
    family = str(model.get("family") or "").strip()
    if family:
        capabilities["family"] = family
    accepts = [str(value) for value in model.get("accepts") or [] if str(value).strip()]
    if accepts:
        capabilities["accepts"] = accepts
    if model.get("beta"):
        capabilities["beta"] = True
    if provider_id in LOCAL_WORKFLOW_PROVIDERS:
        # Read off the live registry row (requires.image) when the inventory
        # had one; a built-in fallback row does not know and says False. Only
        # a workflow has the field: HivemindOS reads it to keep a graph that
        # needs a picture out of a text-only /video-gen.
        capabilities["requiresImage"] = bool(model.get("requires_image"))
    return capabilities


def _cost_for(where: ProviderPlace, provider_id: str) -> dict[str, Any]:
    if where.place == PLACE_THIS_MACHINE:
        return {"kind": "free", "label": "Free · stays on this machine"}
    if where.place == PLACE_CREDITS:
        return {"kind": "credits", "label": "HivemindOS credits"}
    # The account by name, never the variable that holds its key.
    return {"kind": "account", "label": f"Billed to your {where.account or provider_id} account"}


def _prose(*candidates: Any) -> str:
    """The first candidate that reads as a sentence for a person: no credential
    name, no address. "" when none does — a caller then says something of its
    own rather than showing developer copy."""
    for candidate in candidates:
        text = " ".join(str(candidate or "").split())
        if text and not _CREDENTIAL_NAME.search(text) and not _ADDRESS.search(text):
            return text
    return ""


# ── HivemindOS's rows, from its snapshot ─────────────────────────────────────

def merge_peer(
    peer: dict[str, Any],
    sources: dict[str, dict[str, Any]],
    models: list[dict[str, Any]],
    *,
    wanted: tuple[str, ...],
    hosted: dict[str, Any],
) -> None:
    """Add the rows from HivemindOS's snapshot that the studio does not list.

    Deduplicated twice: by row ``key``, and — for rows that run on this
    machine — by lane, the kind plus the workflow or model id, whatever
    provider name each app gives it. HivemindOS lists this machine's Media
    Studio workflows through its own MCP source under its own provider id, and
    the studio already lists the same lanes; a picker must not show one graph
    twice.

    ``hosted`` is the studio's own readiness for the hosted route, and it is
    the studio's evidence of whether HivemindOS is running at all. When the
    route answered, HivemindOS's priced hosted rows are ready here as well:
    the studio's hosted client (``generate_hosted_media_asset``) runs a
    specific model id, so the row runs from this studio exactly as it does
    from chat. When the snapshot is the only evidence, every merged row is
    marked unavailable and not ready, with the reason in words.
    """
    live = bool(hosted.get("available"))
    offline_reason = _peer_offline_reason(hosted)
    own_keys = {row["key"] for row in models}
    own_lanes = {(row["kind"], _lane_id(row)) for row in models if row["place"] == PLACE_THIS_MACHINE}
    merged: list[dict[str, Any]] = []
    for raw in peer.get("models") or []:
        row = _peer_row(raw)
        if row is None or row["kind"] not in wanted or row["key"] in own_keys:
            continue
        lane = (row["kind"], _lane_id(row))
        if row["place"] == PLACE_THIS_MACHINE and lane in own_lanes:
            continue
        own_keys.add(row["key"])
        if row["place"] == PLACE_THIS_MACHINE:
            own_lanes.add(lane)
        merged.append(_project_peer_row(row, live=live, offline_reason=offline_reason))
    if not merged:
        return
    source: dict[str, Any] = {
        "id": PEER_SOURCE_ID,
        "label": "HivemindOS",
        "kind": "hivemindos-credits",
        "app": PEER_APP,
        "available": live,
        "detail": PEER_SOURCE_DETAIL,
    }
    machine = peer.get("machineName")
    if isinstance(machine, str) and machine.strip() and not _ADDRESS.search(machine):
        source["machineName"] = machine.strip()
    sources.setdefault(PEER_SOURCE_ID, source)
    models.extend(merged)


def _hosted_readiness(inventory: dict[str, list[dict]]) -> dict[str, Any]:
    """The studio's own hosted-route row: reachable when the HivemindOS app
    answered the readiness sweep with the studio's device token."""
    for media_kind in KINDS:
        for provider in inventory.get(media_kind, []):
            if str(provider.get("id") or "") == HOSTED_PROVIDER:
                return provider
    return {}


def _peer_offline_reason(hosted: dict[str, Any]) -> str:
    detail = str(hosted.get("detail") or "")
    if _CREDENTIAL_NAME.search(detail):
        # "…_DEVICE_TOKEN is missing": the app may well be running; it is the
        # link that is missing.
        return PEER_UNLINKED_REASON
    return _prose(detail) or PEER_DOWN_REASON


def _lane_id(row: dict[str, Any]) -> str:
    execute = row.get("execute") or {}
    return str(execute.get("workflowId") or execute.get("backend") or execute.get("model") or row.get("id") or "")


def _project_peer_row(row: dict[str, Any], *, live: bool, offline_reason: str) -> dict[str, Any]:
    if not live:
        row["available"] = False
        row["ready"] = False
        row["reason"] = offline_reason
        return row
    if row["place"] == PLACE_CREDITS and row["execute"].get("route") == "hosted-media":
        model_id = str(row["execute"].get("model") or row["id"])
        row["execute"] = {"route": "hosted-media", "model": model_id}
        row["available"] = True
        row["ready"] = True
        row.pop("reason", None)
    return row


def _peer_row(raw: Any) -> dict[str, Any] | None:
    """One of HivemindOS's rows, rebuilt from the fields this contract knows.

    HivemindOS validated its document before writing it, but the file is read
    from a shared directory and the document the studio emits has to stay
    valid whatever is in that file — so a row is rebuilt from known fields
    with their types checked, and anything that does not fit is left out.
    """
    if not isinstance(raw, dict):
        return None
    row: dict[str, Any] = {}
    for field in ("key", "kind", "id", "label", "provider", "providerLabel", "place", "placeLabel"):
        value = raw.get(field)
        if not isinstance(value, str) or not value.strip():
            return None
        row[field] = value.strip()
    if row["kind"] not in KINDS or row["place"] not in _MODEL_PLACES:
        return None
    cost, execute = raw.get("cost"), raw.get("execute")
    if not isinstance(cost, dict) or cost.get("kind") not in _COST_KINDS or not isinstance(cost.get("label"), str):
        return None
    if not isinstance(execute, dict) or execute.get("route") not in _EXECUTE_ROUTES:
        return None
    # Every merged row points at the one source this document has for
    # HivemindOS, not at a source id from a document a reader never sees.
    row["sourceId"] = PEER_SOURCE_ID
    row["available"] = bool(raw.get("available"))
    row["ready"] = bool(raw.get("ready"))
    row["cost"] = {"kind": cost["kind"], "label": cost["label"]}
    for field in ("credits", "usd"):
        if isinstance(cost.get(field), (int, float)) and not isinstance(cost.get(field), bool) and cost[field] >= 0:
            row["cost"][field] = cost[field]
    row["execute"] = {"route": execute["route"]}
    for field in ("appId", "workflowId", "backend", "model", "openUrl"):
        if isinstance(execute.get(field), str) and execute[field].strip():
            row["execute"][field] = execute[field].strip()
    capabilities = raw.get("capabilities") if isinstance(raw.get("capabilities"), dict) else {}
    row["capabilities"] = {}
    for field in ("referenceImages", "beta", "default", "requiresImage"):
        if isinstance(capabilities.get(field), bool):
            row["capabilities"][field] = capabilities[field]
    limit = capabilities.get("maxReferenceImages")
    if limit is None and "maxReferenceImages" in capabilities or (isinstance(limit, int) and not isinstance(limit, bool) and limit >= 0):
        row["capabilities"]["maxReferenceImages"] = limit
    if isinstance(capabilities.get("family"), str):
        row["capabilities"]["family"] = capabilities["family"]
    if isinstance(capabilities.get("accepts"), list):
        row["capabilities"]["accepts"] = [str(value) for value in capabilities["accepts"] if isinstance(value, str)]
    machine = raw.get("machineName")
    if isinstance(machine, str) and machine.strip() and not _ADDRESS.search(machine):
        row["machineName"] = machine.strip()
    if raw.get("credential") in ("api-key", "sign-in", ""):
        row["credential"] = raw["credential"]
    reason = _prose(raw.get("reason"))
    if reason:
        row["reason"] = reason
    return row


# ── the snapshot the other app reads when this one is closed ─────────────────

SNAPSHOT_DIR_NAME = "media-catalog"
# A peer snapshot is read whole; anything past this is not a catalog.
_MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024


def snapshot_dir() -> Path:
    """``$HIVE_HOME/media-catalog``, else ``~/.hivemindos/media-catalog`` — the
    directory both apps share, so each finds the other's file by name."""
    home = os.environ.get("HIVE_HOME", "").strip()
    return (Path(home).expanduser() if home else Path.home() / ".hivemindos") / SNAPSHOT_DIR_NAME


def snapshot_path() -> Path:
    return snapshot_dir() / f"{APP_ID}.json"


def write_snapshot(document: dict[str, Any]) -> Path | None:
    """Publish the catalog for HivemindOS to read while the studio is closed.

    Written to a temporary file and renamed into place, owner-only, so a
    reader never sees half a document and nobody else on the machine sees any
    of it. Never raises: the snapshot is a courtesy to the other app, and a
    full disk or a read-only home must not fail the catalog that was just
    built. Returns the path written, or None.
    """
    path = snapshot_path()
    try:
        # Owner-only directory as well as file: a directory created with the
        # umask's default lets another account on the machine list which
        # apps publish here. The chmod covers a directory that already
        # existed with a wider mode. HivemindOS does the same on its side.
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(path.parent, 0o700)
        descriptor, temp_name = tempfile.mkstemp(prefix=f".{APP_ID}-", suffix=".json", dir=path.parent)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                json.dump(document, handle, indent=1, sort_keys=True)
            os.chmod(temp_name, 0o600)
            os.replace(temp_name, path)
        except BaseException:
            try:
                os.unlink(temp_name)
            except OSError:
                pass
            raise
    except (OSError, TypeError, ValueError):
        return None
    return path


def read_peer_snapshots() -> list[dict[str, Any]]:
    """Every other app's snapshot in the shared directory, by file name.

    The studio's own file is skipped, and so is anything that is not a
    catalog: a partial write, another program's JSON, a document from a
    version this code does not know. A bad file is a file to ignore, never a
    reason to fail the caller.
    """
    try:
        entries = sorted(snapshot_dir().glob("*.json"))
    except OSError:
        return []
    own = snapshot_path().name
    documents: list[dict[str, Any]] = []
    for entry in entries:
        if entry.name == own or entry.name.startswith("."):
            continue
        try:
            if entry.stat().st_size > _MAX_SNAPSHOT_BYTES:
                continue
            value = json.loads(entry.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            continue
        if _looks_like_catalog(value):
            documents.append(value)
    return documents


def _looks_like_catalog(value: Any) -> bool:
    return (
        isinstance(value, dict)
        and value.get("version") == CATALOG_VERSION
        and isinstance(value.get("app"), str)
        and bool(value.get("app").strip())
        and isinstance(value.get("models"), list)
    )
