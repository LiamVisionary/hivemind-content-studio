"""Which engine runs a text model, and what the picker may offer.

The image side already learned this lesson the expensive way: dispatching on
"is it local?" sent an OpenAI OAuth pick to MUAPI, and the fix was one table
keyed by PROVIDER (``image_router.py``). Text models now have the same single
table, for the same reason — the producer can run on a ``llama-server`` this app
spawned or on HivemindOS's cloud routes, and those are different credentials,
different billing and different privacy, so the choice cannot be re-derived from
a naming convention at each call site.

Two functions carry it:

  ``runtime_for(model_id)``  the engine that runs this id, or a refusal naming why
  ``catalog()``              every model either source can offer, plus the state
                             each source is in and which id to start on

Everything the browser renders comes from ``catalog()``, so "which models exist"
has one answer and the picker cannot drift from what will actually run.
"""

from __future__ import annotations

from typing import Any

from . import hivemindos_models, local_llm

LOCAL = "local"
HIVEMINDOS = hivemindos_models.PROVIDER


def source_of(model_id: str) -> str:
    """Which source owns this id. The HivemindOS prefix is the only marker —
    local ids are filesystem-derived and cannot be pattern-matched safely."""
    return HIVEMINDOS if hivemindos_models.is_hivemindos_model(model_id) else LOCAL


def runtime_for(model_id: str) -> Any:
    """The engine for one model id.

    Both engines expose the same ``chat(...)`` keyword signature, which is what
    lets ``story_producer``'s tasks stay written against an engine rather than
    against a provider.
    """
    if source_of(model_id) == HIVEMINDOS:
        return hivemindos_models.runtime()
    return local_llm.runtime()


def catalog() -> dict[str, Any]:
    """Everything the producer picker needs, from both sources at once.

    Never raises. A source that cannot answer is reported as a source that
    cannot answer — with the reason and the action that repairs it — because a
    picker that drops a whole source on a bad day looks to the owner like the
    feature was removed.
    """
    local = _local_source()
    cloud = _hivemindos_source()
    return {
        "sources": {LOCAL: local, HIVEMINDOS: cloud},
        "models": [*local["models"], *cloud["models"]],
        "defaultModelId": default_model_id(local, cloud),
    }


def _local_source() -> dict[str, Any]:
    try:
        snapshot = local_llm.runtime().snapshot()
    except Exception as exc:  # a local runtime that cannot scan is still a state
        return {
            "id": LOCAL,
            "label": "On this machine",
            "available": False,
            "detail": str(exc),
            "remedy": "",
            "models": [],
        }
    models = [
        {
            "id": model["id"],
            "name": model.get("name") or model["id"],
            # Left to the browser: it already turns fit + bytes into a status
            # line (`promptHelperRuntime.modelStatus`) and a second wording of
            # the same fact here would be the copy that goes stale.
            "subtitle": "",
            "group": "On this machine",
            "badge": "Local",
            "tier": "free",
            "source": LOCAL,
            "fit": model.get("fit"),
            "sizeBytes": model.get("sizeBytes"),
            "estimatedLoadBytes": model.get("estimatedLoadBytes"),
            "vision": bool(model.get("vision")),
            "maxContext": model.get("maxContext"),
        }
        for model in snapshot.get("models") or []
    ]
    return {
        "id": LOCAL,
        "label": "On this machine",
        "available": bool(models),
        "detail": "" if models else "No local models found on this machine.",
        "remedy": "" if models else "add-local-model",
        "models": models,
        "availableBytes": snapshot.get("availableBytes"),
        "totalBytes": snapshot.get("totalBytes"),
        "loaded": snapshot.get("loaded") or [],
    }


def _hivemindos_source() -> dict[str, Any]:
    state = hivemindos_models.status()
    try:
        # The address the "Open HivemindOS" repair points at, from the same place
        # the calls go — a second copy in the browser would be the one that is
        # wrong when HIVEMINDOS_URL is set.
        url = hivemindos_models.base_url()
    except ValueError:
        url = ""
    return {
        "id": HIVEMINDOS,
        "label": "HivemindOS",
        "url": url,
        # Which of the two ways this studio is reaching HivemindOS: through the
        # app on this machine, or straight to the hosted service. The picker says
        # so, because it changes where credits are added and which balance the
        # answer spends.
        "route": state.get("route") or hivemindos_models.ROUTE_DIRECT,
        "available": bool(state.get("reachable")),
        "detail": state.get("detail") or "",
        "remedy": state.get("remedy") or "",
        "models": state.get("models") or [],
        "credits": state.get("credits") or {},
        "defaultModelId": state.get("defaultModelId") or hivemindos_models.DEFAULT_MODEL_ID,
    }


def default_model_id(local: dict[str, Any], cloud: dict[str, Any]) -> str:
    """What to start a fresh install on.

    A model already in RAM wins: it is free, private and answers now. Otherwise
    the cloud default, which is the whole point of having one — a machine with no
    weights on it used to have no producer at all. A local model that merely
    fits comes last, because choosing it commits the owner to a multi-minute
    load they did not ask for.
    """
    for model in local.get("models") or []:
        if model.get("fit") == "loaded":
            return model["id"]
    if cloud.get("available"):
        return str(cloud.get("defaultModelId") or hivemindos_models.DEFAULT_MODEL_ID)
    for model in local.get("models") or []:
        if model.get("fit") in ("fits", "needs_unload"):
            return model["id"]
    return ""
