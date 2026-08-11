"""Strength Hunt — sweep one or two LoRA strengths across a fixed prompt+seed,
pack every variant into as few ComfyUI queue jobs as possible, and describe the
labeled comparison sheet that documents the results.

Translated to Python from Mix-Studio (BlackMixture/Mix-Studio, GPL-3.0)
lib/strength-hunt.js. The load-bearing idea is `merge_strength_hunt_graphs`:
content-hash structural dedup lets N complete API graphs collapse into ONE
prompt whose shared nodes (loaders, text encode, VAE) run once, while each
variant keeps its own sampler/LoRA/save chain. Save-type nodes are never
shared, and each save's filename_prefix carries the variant index — the
filename is the ordering contract that maps outputs back to grid positions.

Kept dependency-free (stdlib only): app.py imports this under the system
python3. Pixel work (the sheet PNG itself) lives in
bin/compose-strength-hunt-sheet.py, which runs under the repo venv for PIL,
consuming the pure layout computed here. See THIRD_PARTY_NOTICES.md.
"""

from __future__ import annotations

import json
import math
import re

HUNT_STEP = 0.2
# Donor bound: hunts never sweep past magnitude 2 no matter how extreme the
# manually-entered strength is, so a typo cannot create a giant batch.
HUNT_MAX_MAGNITUDE = 2.0
MAX_HUNT_LORAS = 2
# 11 values per axis at step 0.2 / cap 2.0 -> 121 worst-case variants.
MAX_HUNT_VARIANTS = 121

SIDE_EFFECT_CLASSES = {"SaveImage", "SaveVideo", "PreviewImage", "PreviewAny"}

_OUTPUT_INDEX_RE = re.compile(r"strength_hunt_(\d+)")


def strength_values(max_strength, step=HUNT_STEP, cap=HUNT_MAX_MAGNITUDE):
    """0 toward max_strength inclusive, in `step` increments. Sign-preserving:
    a negative current strength sweeps 0, -0.2, ... (donor 1.0.3 behavior).
    Zero is always included so 'LoRA off' is always one of the tiles."""
    try:
        target = float(max_strength)
    except (TypeError, ValueError):
        target = 0.0
    if not math.isfinite(target):
        target = 0.0
    target = max(-abs(cap), min(abs(cap), target))
    if abs(target) < 1e-9:
        return [0.0]
    sign = 1.0 if target > 0 else -1.0
    magnitude = abs(target)
    values = []
    count = int(magnitude / step + 1e-9)
    for i in range(count + 1):
        values.append(round(sign * i * step, 4))
    if abs(abs(values[-1]) - magnitude) > 1e-9:
        values.append(round(target, 4))
    return values


def build_strength_hunt_plan(loras, hunt_ids, step=HUNT_STEP, max_variants=MAX_HUNT_VARIANTS):
    """Plan the sweep. `loras` is the full selection [{id, strength}, ...];
    `hunt_ids` names 1..MAX_HUNT_LORAS of them as axes (their CURRENT strength
    is each axis's sweep target). Returns axes, grid dims, and per-variant
    LoRA lists (strength-0 entries are dropped — the model must genuinely run
    without that LoRA, matching the donor's on:false).

    Two-axis layout is row-major with rows = axis 2, columns = axis 1 (donor
    grid orientation), so variant index -> (row, col) is index divmod cols."""
    selection = [
        {"id": str(item.get("id") or ""), "strength": float(item.get("strength", 1.0))}
        for item in (loras or [])
        if isinstance(item, dict) and str(item.get("id") or "").strip()
    ]
    by_id = {item["id"]: item for item in selection}
    axis_ids = []
    for hunt_id in hunt_ids or []:
        hunt_id = str(hunt_id or "").strip()
        if not hunt_id or hunt_id in axis_ids:
            continue
        if hunt_id not in by_id:
            raise ValueError(f"strength hunt LoRA is not in the selection: {hunt_id}")
        axis_ids.append(hunt_id)
    if not axis_ids:
        raise ValueError("strength hunt needs at least one LoRA to sweep")
    if len(axis_ids) > MAX_HUNT_LORAS:
        raise ValueError(f"strength hunt supports at most {MAX_HUNT_LORAS} LoRAs")

    axes = [
        {"id": axis_id, "values": strength_values(by_id[axis_id]["strength"], step=step)}
        for axis_id in axis_ids
    ]

    if len(axes) == 1:
        cols = len(axes[0]["values"])
        rows = 1
        coords = [(value,) for value in axes[0]["values"]]
    else:
        cols = len(axes[0]["values"])
        rows = len(axes[1]["values"])
        coords = [
            (col_value, row_value)
            for row_value in axes[1]["values"]
            for col_value in axes[0]["values"]
        ]
    if len(coords) > max_variants:
        raise ValueError(
            f"strength hunt would generate {len(coords)} variants (limit {max_variants}); "
            "lower the swept strengths"
        )

    variants = []
    for index, coord in enumerate(coords):
        variant_loras = []
        for item in selection:
            strength = item["strength"]
            for axis_position, axis in enumerate(axes):
                if item["id"] == axis["id"]:
                    strength = coord[axis_position]
            if abs(strength) < 1e-9 and item["id"] in axis_ids:
                continue  # swept to zero -> genuinely off
            variant_loras.append({"id": item["id"], "strength": round(strength, 4)})
        variants.append({
            "index": index,
            "row": index // cols,
            "col": index % cols,
            "coords": {axes[i]["id"]: coord[i] for i in range(len(axes))},
            "loras": variant_loras,
        })

    return {"axes": axes, "rows": rows, "cols": cols, "variants": variants}


def _stable(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def _is_link(value, graph):
    return (
        isinstance(value, list)
        and len(value) == 2
        and isinstance(value[1], int)
        and not isinstance(value[0], (list, dict))
        and str(value[0]) in graph
    )


def merge_strength_hunt_graphs(graphs):
    """Collapse N complete API-format graphs into one. Nodes are rewritten
    (links -> merged ids) then content-hashed; identical non-side-effect nodes
    are shared. Save/Preview nodes are always kept per-variant — their
    filename_prefix (set per-variant at build time) is the ordering contract.

    ComfyUI treats ANY two-element [id, slot] array as a node link (donor
    gotcha), so matching that interpretation here is deliberate."""
    merged = {}
    signature_to_id = {}
    next_id = 1

    for graph in graphs:
        if not isinstance(graph, dict) or not graph:
            raise ValueError("strength hunt cannot merge an empty graph")
        mapping = {}
        in_progress = set()

        def resolve(node_id, graph=graph, mapping=mapping, in_progress=in_progress):
            nonlocal next_id
            node_id = str(node_id)
            if node_id in mapping:
                return mapping[node_id]
            if node_id in in_progress:
                raise ValueError(f"cycle at node {node_id}")
            in_progress.add(node_id)
            node = graph[node_id]
            inputs = {}
            for key, value in (node.get("inputs") or {}).items():
                if _is_link(value, graph):
                    inputs[key] = [resolve(value[0]), value[1]]
                else:
                    inputs[key] = value
            rewritten = {key: value for key, value in node.items() if key != "inputs"}
            rewritten["inputs"] = inputs
            side_effect = str(node.get("class_type") or "") in SIDE_EFFECT_CLASSES
            signature = None if side_effect else _stable(rewritten)
            if signature is not None and signature in signature_to_id:
                mapped = signature_to_id[signature]
            else:
                mapped = str(next_id)
                next_id += 1
                merged[mapped] = rewritten
                if signature is not None:
                    signature_to_id[signature] = mapped
            mapping[node_id] = mapped
            in_progress.discard(node_id)
            return mapped

        for node_id in list(graph.keys()):
            resolve(node_id)

    return merged


def strength_hunt_output_index(filename):
    """Variant index from a saved filename, or None. Completion re-sorts
    ComfyUI's outputs with this — arrival order is not the grid order."""
    match = _OUTPUT_INDEX_RE.search(str(filename or ""))
    return int(match.group(1)) if match else None


# ---------------------------------------------------------------------------
# Sheet layout (pure math; the PIL composer draws what this describes).
# Donor constants: header 150, margin 24, tile gap 8/10, label band under each
# tile, desired tile width 360 (matrix) / 512 (strip), canvas caps 4096/6144.

def sheet_layout(rows, cols, tile_aspect, *, square=False, count=None):
    rows = max(1, int(rows))
    cols = max(1, int(cols))
    if square and rows == 1:
        total = int(count if count is not None else cols)
        cols = max(1, math.ceil(math.sqrt(total)))
        rows = max(1, math.ceil(total / cols))
    matrix = rows > 1
    desired_tile_width = 360 if matrix else 512
    label_height = 38 if matrix else 34
    gap = 10 if matrix else 8
    margin = 24
    header_height = 150
    max_width = 4096 if matrix else 6144
    max_height = 4096

    tile_width = desired_tile_width
    width = margin * 2 + cols * tile_width + (cols - 1) * gap
    if width > max_width:
        tile_width = (max_width - margin * 2 - (cols - 1) * gap) // cols
        width = margin * 2 + cols * tile_width + (cols - 1) * gap
    tile_height = max(1, round(tile_width / max(0.05, float(tile_aspect))))
    height = header_height + margin + rows * (tile_height + label_height + gap) + margin
    if height > max_height:
        # Labels and gaps do not scale, so solve for the tile height that fits
        # and shrink the width to keep the aspect (a plain proportional scale
        # never converges — it re-overflows by the fixed bands).
        budget_per_row = (max_height - header_height - margin * 2) // rows
        tile_height = max(1, budget_per_row - label_height - gap)
        tile_width = max(1, int(tile_height * max(0.05, float(tile_aspect))))
        height = header_height + margin + rows * (tile_height + label_height + gap) + margin
        width = margin * 2 + cols * tile_width + (cols - 1) * gap
    return {
        "rows": rows,
        "cols": cols,
        "width": int(width),
        "height": int(height),
        "tile_width": int(tile_width),
        "tile_height": int(tile_height),
        "label_height": label_height,
        "gap": gap,
        "margin": margin,
        "header_height": header_height,
    }
