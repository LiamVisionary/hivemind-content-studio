"""The one MUAPI catalog: which cloud models the studios offer, and what each accepts.

Until 2026-09-04 there were two. The browser carried a 12,779-line vendored copy
of the provider's model list (``src/lib/modelsData.js``), generated once from a
dump nothing regenerated, and it WAS the entire cloud model universe of the
Image, Video and Lip sync studios. Meanwhile this package hand-typed a second,
much shorter MUAPI list for the producer's picker. The two could name different
models for the same provider and nothing noticed.

Now there is one file — ``catalog/muapi_models.json`` — and it lives here, on
the side that already holds the key. The browser reads it over
``/api/muapi/catalog``; the producer's rows are built from it; and
``scripts/regenerate_muapi_catalog.py`` refreshes it from the provider's own
``/api/v1/models`` schemas.

What the catalog is NOT is a raw provider dump, and that distinction is the
whole reason a refresh has rules:

  - The provider lists 654 models. The studios offer 157 of them, in a chosen
    order, under names a person can read ("Nano Banana", not "nano-banana").
  - Rows are stripped of the provider's upload inputs (``image_url``,
    ``images_list``, ``last_image``, ``audio_url`` …). The studio supplies those
    itself from its own uploader, and it records WHICH field to fill in the
    ``imageField`` / ``lastImageField`` / ``videoField`` flags on the row. A
    refresh that pasted those inputs back would render a URL box beside every
    upload button.
  - Some inputs are deliberately pinned away from upstream and say so in the
    row's ``pinned`` list — a duration ladder we chose where upstream declares
    an open range, a resolution list the preview build does not actually serve.
  - Thirteen rows the studios still offer are no longer in the provider's
    listing at all. A live-only catalog would delete them out from under
    anyone whose saved preference names one.

So the merge rule here is narrow on purpose: a live read may only UPDATE inputs
a row already declares and has not pinned. It never adds an input, never removes
one, and never adds or removes a row. Everything else is a curation decision,
which the regeneration script reports for a person to make.
"""

from __future__ import annotations

import json
import threading
import time
from functools import lru_cache
from pathlib import Path
from typing import Any, Callable, Iterable

from . import muapi_proxy

CATALOG_PATH = Path(__file__).resolve().parent / "catalog" / "muapi_models.json"

# The studio-facing buckets, in the order the browser's arrays used to be
# declared. These names are a wire contract: the client indexes the payload by
# them.
BUCKETS = ("t2i", "t2v", "i2i", "i2v", "v2v", "lipsync", "recast", "audio")

# Schemas move on the order of weeks, and refreshing one means one HTTP call per
# model. Long TTL, refreshed in the background, never at boot: a stack restart
# must not fan 157 requests at the provider before the first studio opens.
SCHEMA_TTL_SECONDS = 6 * 60 * 60


class MuapiCatalogError(RuntimeError):
    """The catalog file is unusable. Shown to the owner."""


@lru_cache(maxsize=1)
def shipped_catalog() -> dict[str, Any]:
    """The catalog as it ships, parsed once."""
    try:
        payload = json.loads(CATALOG_PATH.read_text())
    except FileNotFoundError as exc:  # pragma: no cover - packaging failure
        raise MuapiCatalogError(f"The MUAPI catalog is missing at {CATALOG_PATH}") from exc
    except json.JSONDecodeError as exc:
        raise MuapiCatalogError(f"The MUAPI catalog is not valid JSON: {exc}") from exc
    buckets = payload.get("buckets")
    if not isinstance(buckets, dict) or not buckets:
        raise MuapiCatalogError("The MUAPI catalog has no model buckets")
    return payload


def buckets() -> dict[str, list[dict[str, Any]]]:
    return {name: list(shipped_catalog()["buckets"].get(name) or []) for name in BUCKETS}


def rows() -> list[dict[str, Any]]:
    """Every row, in bucket order. A model in two buckets appears twice."""
    return [row for name in BUCKETS for row in shipped_catalog()["buckets"].get(name) or []]


@lru_cache(maxsize=1)
def rows_by_id() -> dict[str, dict[str, Any]]:
    """First row per id. Ids are unique within a bucket, shared across a few."""
    found: dict[str, dict[str, Any]] = {}
    for row in rows():
        found.setdefault(str(row.get("id") or ""), row)
    found.pop("", None)
    return found


def endpoint_for(row: dict[str, Any]) -> str:
    """The provider endpoint this row submits to.

    Most rows carry no `endpoint` because it equals the id; the browser client
    has resolved it that way since the first version and the payloads it sends
    depend on it.
    """
    return str(row.get("endpoint") or row.get("id") or "")


def label_for(model_id: str) -> str:
    """The reader-facing name for `model_id`, or the id when it is not ours."""
    row = rows_by_id().get(str(model_id))
    return str((row or {}).get("name") or model_id)


def knows(model_id: str) -> bool:
    return str(model_id) in rows_by_id()


# ---- live schema read -------------------------------------------------------


def _schema_properties(detail: Any) -> dict[str, Any] | None:
    if not isinstance(detail, dict):
        return None
    schemas = (detail.get("input_schema") or {}).get("schemas") or {}
    properties = (schemas.get("input_data") or {}).get("properties")
    return properties if isinstance(properties, dict) else None


def fetch_schemas(
    endpoints: Iterable[str],
    *,
    forward: Callable[..., tuple[int, bytes, dict[str, str]]] = muapi_proxy.forward,
    workers: int = 8,
) -> dict[str, dict[str, Any]]:
    """`{endpoint: input properties}` for every endpoint the provider still serves.

    Through the same proxy the browser's generation calls use, so the key is
    read in exactly one place. An endpoint that 404s or times out is simply
    absent from the result — the catalog keeps what it shipped, which is the
    only sane answer for a model whose schema we could not re-read.
    """
    from concurrent.futures import ThreadPoolExecutor

    wanted = sorted({str(e) for e in endpoints if str(e or "").strip()})

    def one(endpoint: str) -> tuple[str, dict[str, Any] | None]:
        try:
            status, payload, _ = forward(method="GET", path=f"api/v1/models/{endpoint}", timeout=30.0)
        except Exception:  # noqa: BLE001 — an unreadable schema is not an outage
            return endpoint, None
        if status != 200:
            return endpoint, None
        try:
            return endpoint, _schema_properties(json.loads(payload))
        except (ValueError, TypeError):
            return endpoint, None

    found: dict[str, dict[str, Any]] = {}
    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        for endpoint, properties in pool.map(one, wanted):
            if properties:
                found[endpoint] = properties
    return found


def merge_schemas(catalog: dict[str, Any], schemas: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """`catalog` with live values folded into the inputs it already declares.

    The narrow rule this module's docstring sets out: update, never add, never
    remove, never touch a pinned input. So a model that gains an aspect ratio
    upstream gains it here, and a model whose upload field came back does not
    grow a URL box the studio would have to hide.
    """
    merged_buckets: dict[str, list[dict[str, Any]]] = {}
    for name, bucket_rows in (catalog.get("buckets") or {}).items():
        out: list[dict[str, Any]] = []
        for row in bucket_rows or []:
            live = schemas.get(endpoint_for(row))
            declared = row.get("inputs")
            if not live or not isinstance(declared, dict):
                out.append(row)
                continue
            pinned = set(row.get("pinned") or ())
            inputs = {
                key: (live[key] if key in live and key not in pinned else value)
                for key, value in declared.items()
            }
            out.append({**row, "inputs": inputs} if inputs != declared else row)
        merged_buckets[name] = out
    return {**catalog, "buckets": merged_buckets}


class SchemaCache:
    """The live schema read, cached with the simple catalog's discipline.

    Serve what we last had, refresh behind the request, and never make a studio
    wait on the provider. Empty until the first refresh lands, which is what
    makes the shipped rows the answer on a cold start rather than a stall.
    """

    def __init__(self, *, ttl: float = SCHEMA_TTL_SECONDS) -> None:
        self.ttl = ttl
        self._schemas: dict[str, dict[str, Any]] = {}
        self._at = 0.0
        self._refreshing = threading.Event()

    @property
    def schemas(self) -> dict[str, dict[str, Any]]:
        return dict(self._schemas)

    @property
    def fetched_at(self) -> float:
        return self._at

    def stale(self, now: float | None = None) -> bool:
        return (now or time.time()) - self._at > self.ttl

    def refresh(self, *, forward: Callable[..., Any] = muapi_proxy.forward) -> None:
        try:
            found = fetch_schemas((endpoint_for(row) for row in rows()), forward=forward)
            # A read that came back with nothing is an outage, not an answer:
            # keep the previous schemas and let the next refresh try again.
            if found:
                self._schemas = found
            self._at = time.time()
        finally:
            self._refreshing.clear()

    def kick(self, *, forward: Callable[..., Any] = muapi_proxy.forward) -> bool:
        """Start a background refresh if one is due and none is running."""
        if self._refreshing.is_set() or not self.stale():
            return False
        if not muapi_proxy.has_server_key():
            # No key on this machine means the browser talks to the provider
            # directly with its own; there is nothing here to read schemas with.
            return False
        self._refreshing.set()
        threading.Thread(
            target=self.refresh, kwargs={"forward": forward}, name="muapi-schema-refresh", daemon=True,
        ).start()
        return True


_schema_cache = SchemaCache()


def catalog_payload(*, cache: SchemaCache | None = None) -> dict[str, Any]:
    """What ``GET /api/muapi/catalog`` answers.

    `schemas_fetched_at` is 0 until a live read has landed, so the client can
    say the list is the shipped one rather than pretending it is live.
    """
    cache = cache if cache is not None else _schema_cache
    cache.kick()
    catalog = shipped_catalog()
    schemas = cache.schemas
    payload = merge_schemas(catalog, schemas) if schemas else catalog
    return {
        "ok": True,
        "generated_at": catalog.get("generated_at", ""),
        "source": catalog.get("source", ""),
        "schemas_fetched_at": cache.fetched_at,
        "buckets": payload["buckets"],
    }
