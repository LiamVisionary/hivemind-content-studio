from __future__ import annotations

import json
import os
from typing import Any

IMAGE_EXTENSIONS = ('.png', '.jpg', '.jpeg', '.webp', '.gif')
VIDEO_EXTENSIONS = ('.mp4', '.mov', '.webm', '.mkv')
ENCRYPTED_WORKFLOW_FORMAT = 'comfyui-mobile-encrypted-workflow'


# In-memory cache for the prompt JSON text of a file, keyed by absolute path.
# Each entry stores (mtime, prompt_text_lower). Lookups verify the cached
# mtime against the file's current mtime so edits/replacements invalidate the
# entry transparently. Bounded by ComfyUI's process lifetime.
_PROMPT_TEXT_CACHE: dict[str, tuple[float, str]] = {}
# Cap the cache so repeated prompt searches over large output folders can't grow
# it without bound for the life of the process.
_PROMPT_TEXT_CACHE_MAX = 4096


def _read_prompt_text(full_path: str) -> str:
    """Read the embedded prompt JSON text from a PNG and return it lowercased.

    Returns an empty string for non-PNG files or for files that can't be read.
    PNGs from ComfyUI store the prompt under the `prompt` tEXt chunk; we read
    just that chunk via Pillow's Image.info, which doesn't decode pixels and
    keeps per-file cost low.
    """
    ext = os.path.splitext(full_path)[1].lower()
    if os.environ.get("COMFY_MOBILE_ENABLE_PROMPT_SEARCH", "0").lower() not in {"1", "true", "yes", "on"}:
        return ''
    if ext != '.png':
        return ''
    try:
        from PIL import Image
        with Image.open(full_path) as img:
            metadata = img.info
            prompt_value = metadata.get('prompt', '')
            if isinstance(prompt_value, bytes):
                prompt_value = prompt_value.decode('utf-8', errors='ignore')
            if not isinstance(prompt_value, str):
                prompt_value = str(prompt_value)
            return prompt_value.lower()
    except Exception:
        return ''


def get_cached_prompt_text(full_path: str) -> str:
    """Return the cached lowercased prompt JSON text for a file, refreshing
    the cache when the file's mtime has changed since the last read.
    """
    try:
        mtime = os.path.getmtime(full_path)
    except OSError:
        return ''
    cached = _PROMPT_TEXT_CACHE.get(full_path)
    if cached is not None and cached[0] == mtime:
        return cached[1]
    text = _read_prompt_text(full_path)
    if (
        len(_PROMPT_TEXT_CACHE) >= _PROMPT_TEXT_CACHE_MAX
        and full_path not in _PROMPT_TEXT_CACHE
    ):
        # Coarse eviction: drop the oldest-inserted ~10% (dict preserves order).
        for key in list(_PROMPT_TEXT_CACHE)[: _PROMPT_TEXT_CACHE_MAX // 10]:
            del _PROMPT_TEXT_CACHE[key]
    _PROMPT_TEXT_CACHE[full_path] = (mtime, text)
    return text


def clear_prompt_text_cache() -> None:
    """Drop the in-memory cache. Useful in tests."""
    _PROMPT_TEXT_CACHE.clear()


class MetadataPathError(ValueError):
    def __init__(self, message: str, status_code: int) -> None:
        super().__init__(message)
        self.status_code = status_code


def resolve_metadata_path(
    filepath: str,
    source: str,
    input_dir: str,
    output_dir: str,
) -> str:
    if not filepath:
        raise MetadataPathError("No path provided", 400)

    base_dir = input_dir if source == 'input' else output_dir
    base_dir_real = os.path.realpath(base_dir)
    target_path = os.path.abspath(os.path.join(base_dir_real, filepath))

    # Separator-aware containment on realpath'd paths: rejects same-prefix sibling
    # dirs (e.g. output_secret vs output) and symlink escapes, which a bare
    # startswith on abspath would let through.
    target_real = os.path.realpath(target_path)
    if target_real != base_dir_real and not target_real.startswith(base_dir_real + os.sep):
        raise MetadataPathError("Access denied", 403)

    if not os.path.exists(target_path):
        raise MetadataPathError("File not found", 404)

    if os.path.isdir(target_path):
        raise MetadataPathError("Folder metadata not supported", 400)

    ext = os.path.splitext(target_path)[1].lower()
    if ext in VIDEO_EXTENSIONS:
        base_name = os.path.splitext(os.path.basename(target_path))[0]
        folder_path = os.path.dirname(target_path)
        for image_ext in IMAGE_EXTENSIONS:
            candidate = os.path.join(folder_path, base_name + image_ext)
            if os.path.exists(candidate):
                return candidate
        raise MetadataPathError("No image metadata found for video", 404)

    if ext not in IMAGE_EXTENSIONS:
        raise MetadataPathError("Unsupported file type", 400)

    return target_path


def is_encrypted_workflow_envelope(value: Any) -> bool:
    return (
        isinstance(value, dict)
        and value.get('encrypted') is True
        and value.get('format') == ENCRYPTED_WORKFLOW_FORMAT
        and isinstance(value.get('iterations'), int)
        and isinstance(value.get('salt'), str)
        and isinstance(value.get('iv'), str)
        and isinstance(value.get('data'), str)
    )


def _plaintext_workflow_metadata_allowed() -> bool:
    return os.environ.get("COMFY_MOBILE_ALLOW_PLAINTEXT_IMAGE_WORKFLOW", "0").lower() in {"1", "true", "yes", "on"}


def _is_workflow_like(value: Any) -> bool:
    return isinstance(value, dict) and isinstance(value.get('nodes'), list)


def _load_json_value(value: Any) -> Any | None:
    if isinstance(value, bytes):
        value = value.decode('utf-8', errors='ignore')
    if not value:
        return None
    try:
        return json.loads(value) if isinstance(value, str) else value
    except Exception:
        return None


def _private_workflow_value(value: Any, *, allow_plaintext: bool = False) -> Any | None:
    parsed = _load_json_value(value)
    if is_encrypted_workflow_envelope(parsed):
        return parsed
    if allow_plaintext and _is_workflow_like(parsed):
        return parsed
    return None


def extract_workflow_from_metadata(metadata: dict[str, Any], *, allow_plaintext: bool | None = None) -> Any | None:
    allow_plaintext = _plaintext_workflow_metadata_allowed() if allow_plaintext is None else allow_plaintext
    workflow_value = metadata.get('workflow') or metadata.get('Workflow')
    workflow = _private_workflow_value(workflow_value, allow_plaintext=allow_plaintext)
    if workflow:
        return workflow

    prompt_value = metadata.get('prompt') or metadata.get('Prompt')
    prompt_data = _load_json_value(prompt_value)
    if not isinstance(prompt_data, dict):
        return None

    extra_pnginfo = prompt_data.get('extra_pnginfo', {})
    if isinstance(extra_pnginfo, str):
        try:
            extra_pnginfo = json.loads(extra_pnginfo)
        except Exception:
            extra_pnginfo = {}
    return _private_workflow_value(
        extra_pnginfo.get('workflow')
        or prompt_data.get('workflow')
        or prompt_data.get('workflow_v2'),
        allow_plaintext=allow_plaintext,
    )


# --- Prompt-only Comfy image fallback ---------------------------------------

def _is_prompt_link(value: Any, node_ids: set[str]) -> bool:
    return (
        isinstance(value, list)
        and len(value) >= 2
        and isinstance(value[0], (str, int))
        and isinstance(value[1], int)
        and str(value[0]) in node_ids
    )


def prompt_to_fallback_workflow(prompt_data: Any) -> Any | None:
    """Build a minimal LiteGraph workflow from embedded Comfy API prompt JSON.

    Older Comfy outputs can contain only the API prompt (class_type + input
    graph) and no `workflow` canvas JSON. Mobile's Outputs "Load workflow" path
    expects LiteGraph workflow JSON, so synthesize a compatible graph without
    decoding pixels or logging prompt text.
    """
    if not isinstance(prompt_data, dict):
        return None
    api_nodes = {str(k): v for k, v in prompt_data.items() if isinstance(v, dict)}
    if not api_nodes:
        return None

    node_ids = set(api_nodes.keys())
    id_map: dict[str, int] = {}
    used: set[int] = set()
    next_id = 1
    for raw_id in api_nodes:
        try:
            numeric = int(raw_id)
        except Exception:
            numeric = 0
        if numeric > 0 and numeric not in used:
            id_map[raw_id] = numeric
            used.add(numeric)
            next_id = max(next_id, numeric + 1)
        else:
            while next_id in used:
                next_id += 1
            id_map[raw_id] = next_id
            used.add(next_id)
            next_id += 1

    links: list[list[Any]] = []
    outputs_by_node: dict[str, dict[int, list[int]]] = {raw_id: {} for raw_id in api_nodes}
    pending_inputs: dict[str, list[dict[str, Any]]] = {raw_id: [] for raw_id in api_nodes}
    link_id = 1
    for raw_id, node in api_nodes.items():
        inputs = node.get('inputs') if isinstance(node.get('inputs'), dict) else {}
        input_slot = 0
        for name, value in inputs.items():
            if _is_prompt_link(value, node_ids):
                src_raw = str(value[0])
                src_slot = int(value[1])
                dst_id = id_map[raw_id]
                src_id = id_map[src_raw]
                links.append([link_id, src_id, src_slot, dst_id, input_slot, '*'])
                pending_inputs[raw_id].append({'name': str(name), 'type': '*', 'link': link_id})
                outputs_by_node.setdefault(src_raw, {}).setdefault(src_slot, []).append(link_id)
                link_id += 1
                input_slot += 1

    nodes: list[dict[str, Any]] = []
    cols = 4
    for index, (raw_id, node) in enumerate(api_nodes.items()):
        inputs = node.get('inputs') if isinstance(node.get('inputs'), dict) else {}
        scalar_inputs = {str(k): v for k, v in inputs.items() if not _is_prompt_link(v, node_ids)}
        node_outputs = [
            {'name': str(slot), 'type': '*', 'links': slot_links, 'slot_index': slot}
            for slot, slot_links in sorted(outputs_by_node.get(raw_id, {}).items())
        ]
        nodes.append({
            'id': id_map[raw_id],
            'type': str(node.get('class_type') or raw_id),
            'pos': [(index % cols) * 360, (index // cols) * 220],
            'size': [320, 160],
            'flags': {},
            'order': index,
            'mode': 0,
            'inputs': pending_inputs.get(raw_id, []),
            'outputs': node_outputs,
            'properties': {
                'api_prompt_id': raw_id,
                'api_prompt_inputs': scalar_inputs,
            },
            'widgets_values': scalar_inputs,
        })

    return {
        'last_node_id': max(id_map.values()) if id_map else 0,
        'last_link_id': link_id - 1,
        'nodes': nodes,
        'links': links,
        'groups': [],
        'config': {},
        'extra': {'source': 'embedded_api_prompt_fallback'},
        'version': 0.4,
    }


def extract_prompt_from_metadata(metadata: dict[str, Any]) -> Any | None:
    prompt_value = metadata.get('prompt') or metadata.get('Prompt')
    if isinstance(prompt_value, bytes):
        prompt_value = prompt_value.decode('utf-8', errors='ignore')
    if not prompt_value:
        return None
    try:
        return json.loads(prompt_value) if isinstance(prompt_value, str) else prompt_value
    except Exception:
        return None


def extract_loadable_workflow_from_metadata(
    metadata: dict[str, Any],
    *,
    allow_prompt_fallback: bool | None = None,
    allow_plaintext: bool | None = None,
) -> Any | None:
    workflow = extract_workflow_from_metadata(metadata, allow_plaintext=allow_plaintext)
    if workflow:
        return workflow
    if allow_prompt_fallback is None:
        allow_prompt_fallback = _plaintext_workflow_metadata_allowed()
    if not allow_prompt_fallback:
        return None
    return prompt_to_fallback_workflow(extract_prompt_from_metadata(metadata))
