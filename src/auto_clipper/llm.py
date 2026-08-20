"""LLM access for the semantic layer.

This module deliberately owns no provider code. The studio already has two
paths, and adding a third client would fork the project's own way:

- `hivemind_content_studio.local_llm` — the app-spawned llama-server. Unpaid and
  local, which matches what Auto Clipper is for.
- `app.services.llm` — the provider-generic cloud path (config.toml).

Resolution order is set by `AUTO_CLIPPER_LLM`:

    auto (default)  already-loaded local model, else cloud
    local           already-loaded local model only
    cloud           cloud only
    off             no LLM; callers fall back to their pre-LLM behaviour

Local models are used only when the studio already has one loaded. We never load
or unload one: model lifecycle belongs to the studio, and evicting whatever the
user is working with to caption a clip would be a rude trade.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any, Callable, Protocol

logger = logging.getLogger(__name__)

Caller = Callable[[str, Any], str]

SYSTEM_HINT = (
    "You return JSON and nothing else. No preamble, no explanation, no commentary "
    "after the JSON."
)


class LlmUnavailable(RuntimeError):
    """Raised when no configured LLM path can serve a call."""


class _Runtime(Protocol):  # pragma: no cover - structural typing only
    def snapshot(self) -> dict[str, Any]: ...
    def chat(self, **kwargs: Any) -> str: ...


def mode() -> str:
    return (os.environ.get("AUTO_CLIPPER_LLM") or "auto").strip().lower()


def _compose(prompt: str, payload: Any) -> str:
    if payload is None:
        return prompt
    body = json.dumps(payload, ensure_ascii=False, indent=2)
    return f"{prompt}\n\n# Input data\n\n```json\n{body}\n```\n"


def _loaded_local_model(runtime: _Runtime) -> str | None:
    try:
        snapshot = runtime.snapshot()
    except Exception as exc:  # pragma: no cover - runtime probing is best-effort
        logger.debug("local llm snapshot failed: %s", exc)
        return None
    loaded = snapshot.get("loaded") or []
    preferred = os.environ.get("AUTO_CLIPPER_LLM_MODEL")
    ids = [str(entry.get("modelId")) for entry in loaded if entry.get("modelId")]
    if preferred and preferred in ids:
        return preferred
    return ids[0] if ids else None


def _call_local(text: str) -> str:
    try:
        from hivemind_content_studio import local_llm
    except ImportError as exc:
        raise LlmUnavailable(f"local_llm is not importable: {exc}") from exc

    runtime = local_llm.runtime()
    model_id = _loaded_local_model(runtime)
    if not model_id:
        raise LlmUnavailable(
            "No local model is loaded. Load one in the studio, or set AUTO_CLIPPER_LLM=cloud."
        )
    return runtime.chat(
        model_id=model_id,
        messages=[
            {"role": "system", "content": SYSTEM_HINT},
            {"role": "user", "content": text},
        ],
        temperature=0.3,
        max_tokens=4096,
    )


def _call_cloud(text: str) -> str:
    try:
        from app.services.llm import _generate_response
    except ImportError as exc:
        raise LlmUnavailable(f"cloud llm service is not importable: {exc}") from exc
    try:
        return _generate_response(f"{SYSTEM_HINT}\n\n{text}")
    except Exception as exc:
        raise LlmUnavailable(f"cloud llm call failed: {exc}") from exc


def call_llm(prompt: str, payload: Any = None) -> str:
    """Send `prompt` plus `payload` to the first usable LLM path.

    Raises `LlmUnavailable` rather than returning a sentinel, so every caller has
    to decide explicitly what happens when there is no model — which for this
    package always means "keep the render, skip the enrichment".
    """
    selected = mode()
    if selected == "off":
        raise LlmUnavailable("AUTO_CLIPPER_LLM=off")

    text = _compose(prompt, payload)
    errors: list[str] = []

    if selected in {"auto", "local"}:
        try:
            return _call_local(text)
        except LlmUnavailable as exc:
            errors.append(str(exc))
            if selected == "local":
                raise

    if selected in {"auto", "cloud"}:
        try:
            return _call_cloud(text)
        except LlmUnavailable as exc:
            errors.append(str(exc))

    raise LlmUnavailable("; ".join(errors) or f"unknown AUTO_CLIPPER_LLM mode {selected!r}")


def resolve_caller(caller: Caller | None) -> Caller:
    """Return the injected caller, or the real one.

    Tests and dry runs pass their own; nothing else should need this.
    """
    return caller or call_llm
