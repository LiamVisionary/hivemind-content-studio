"""Tolerant JSON extraction from LLM prose.

The four-layer extraction ladder is adapted from zhouxiaoka/autoclip's
`backend/utils/llm_client.py::parse_json_response` (MIT): strip the prose that
models put in front of the payload, then try a fenced block, then the whole
body, then a regex scan for the outermost array or object.

Their `fix_common_json_errors` repair pass is deliberately NOT carried over. One
of its rewrites quotes every bare identifier followed by a colon without first
checking whether the key is already quoted, so a valid `"start_time":` comes out
as `""start_time"":` and the repair corrupts input it was handed intact. A model
that cannot produce parseable JSON should be asked again, not regex-patched.
"""

from __future__ import annotations

import json
import re
from typing import Any

# Control characters that break json.loads, minus the ones that are legal
# whitespace inside a document.
_CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_FENCE = re.compile(r"```(?:json)?\s*([\s\S]*?)\s*```", re.DOTALL)
_OUTERMOST = re.compile(r"\[[\s\S]*\]|\{[\s\S]*\}", re.DOTALL)


class LlmJsonError(ValueError):
    """Raised when no layer of the ladder finds parseable JSON."""


def sanitize(text: str) -> str:
    return _CONTROL_CHARS.sub("", text.lstrip("﻿").strip())


def strip_prose(text: str) -> str:
    """Drop any preamble before the payload starts.

    Models routinely open with "Here is the JSON you asked for:" and close with
    a summary paragraph. Cutting to the first line that opens a structure keeps
    the fence layer below from tripping on the preamble.
    """
    lines = text.splitlines()
    for index, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith(("[", "{", "```")):
            return "\n".join(lines[index:]).strip()
    return text.strip()


def parse_json_response(response: str) -> Any:
    """Return the first parseable JSON value in `response`.

    Layers, in order: fenced code block, whole sanitized body, outermost
    array/object found by regex. Raises `LlmJsonError` if every layer fails.
    """
    if not response or not response.strip():
        raise LlmJsonError("LLM returned an empty response")

    body = strip_prose(response)

    match = _FENCE.search(body)
    if match:
        try:
            return json.loads(sanitize(match.group(1)))
        except json.JSONDecodeError:
            pass

    try:
        return json.loads(sanitize(body))
    except json.JSONDecodeError:
        pass

    scan = _OUTERMOST.search(body)
    if scan:
        try:
            return json.loads(sanitize(scan.group()))
        except json.JSONDecodeError:
            pass

    raise LlmJsonError(f"No parseable JSON in LLM response: {response[:200]!r}")


def parse_list(response: str) -> list[dict[str, Any]]:
    """Parse a response that must be a JSON array of objects."""
    value = parse_json_response(response)
    if isinstance(value, dict):
        # Some models wrap the array in a single-key object. Unwrap the only
        # list-valued field rather than failing on a payload that is all there.
        lists = [v for v in value.values() if isinstance(v, list)]
        if len(lists) == 1:
            value = lists[0]
    if not isinstance(value, list):
        raise LlmJsonError(f"Expected a JSON array, got {type(value).__name__}")
    return [item for item in value if isinstance(item, dict)]


def parse_object(response: str) -> dict[str, Any]:
    """Parse a response that must be a JSON object."""
    value = parse_json_response(response)
    if not isinstance(value, dict):
        raise LlmJsonError(f"Expected a JSON object, got {type(value).__name__}")
    return value
