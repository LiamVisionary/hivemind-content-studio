"""SAM3 smart-select mask graphs.

Translated from Mix-Studio (GPL-3.0) `lib/edit-mask.js` `buildSam3MaskGraph`,
which builds a transient ComfyUI graph whose only product is a white-on-black
mask. Two ways to say what you mean:

  * text  — "the jacket" → SAM3Grounding finds every match above a confidence
    floor, capped so one word cannot return the whole scene.
  * points — tap the thing (and optionally tap what to exclude) →
    SAM3CreatePoint/SAM3CombinePoints → SAM3Segmentation.

Deliberate difference from the donor: the mask leaves through **PreviewImage**,
not SaveImage. SaveImage writes into the studio's output directory, where the
privacy sweeper seals it — so every smart-select would leave an undecryptable
mask in History and the gateway could not read back the thing it just made.
PreviewImage writes to ComfyUI's temp directory, which the route reads once and
deletes.

The node ids are those of `PozzettiAndrea/ComfyUI-SAM3`, pinned and installed
locally (see the pack's own __init__.py for the fork notes).
"""

from __future__ import annotations

# Upstream's own guidance: below ~0.2 the grounder starts returning scenery.
DEFAULT_CONFIDENCE = 0.2
MAX_DETECTIONS = 12
# A mask is a selection, not a scene graph; ten taps is already unusual.
MAX_POINTS = 10


def normalize_points(points):
    """Clamp taps to the unit square and default them to 'include this'.

    Coordinates are fractions of the image so the caller never has to know the
    natural resolution — the same contract the donor used."""
    normalized = []
    for point in (points or [])[:MAX_POINTS]:
        if not isinstance(point, dict):
            continue
        try:
            x = float(point.get("x", 0) or 0)
            y = float(point.get("y", 0) or 0)
        except (TypeError, ValueError):
            continue
        normalized.append({
            "x": min(1.0, max(0.0, x)),
            "y": min(1.0, max(0.0, y)),
            "foreground": point.get("foreground", True) is not False,
        })
    return normalized


def _append_point_group(graph, prefix, points):
    if not points:
        return None
    keys = []
    for index, point in enumerate(points, start=1):
        key = f"{prefix}_{index}"
        graph[key] = {
            "class_type": "SAM3CreatePoint",
            "inputs": {"x": point["x"], "y": point["y"], "is_foreground": point["foreground"]},
        }
        keys.append(key)
    combine_key = f"{prefix}_combine"
    graph[combine_key] = {
        "class_type": "SAM3CombinePoints",
        "inputs": {f"point_{i + 1}": [key, 0] for i, key in enumerate(keys)},
    }
    return [combine_key, 0]


def build_sam3_mask_prompt(image_name, prompt="", points=None, confidence=DEFAULT_CONFIDENCE):
    """The transient graph, as a ComfyUI API prompt dict.

    Text wins when both are supplied: it is the more specific instruction, and
    mixing a grounding phrase with taps asks two different questions at once.
    """
    image_name = str(image_name or "").strip()
    text = str(prompt or "").strip()
    taps = normalize_points(points)
    if not image_name:
        raise ValueError("a source image is required")
    if not text and not taps:
        raise ValueError("describe an object or tap the image")

    graph = {
        "source": {"class_type": "LoadImage", "inputs": {"image": image_name}},
        "sam3_model": {"class_type": "LoadSAM3Model", "inputs": {"precision": "auto", "compile": False}},
    }
    if text:
        graph["sam3_ground"] = {
            "class_type": "SAM3Grounding",
            "inputs": {
                "sam3_model_config": ["sam3_model", 0],
                "image": ["source", 0],
                "confidence_threshold": max(0.05, min(0.95, float(confidence))),
                "text_prompt": text,
                "max_detections": MAX_DETECTIONS,
            },
        }
        mask = ["sam3_ground", 0]
    else:
        positive = _append_point_group(graph, "sam3_positive", [p for p in taps if p["foreground"]])
        negative = _append_point_group(graph, "sam3_negative", [p for p in taps if not p["foreground"]])
        if not positive:
            raise ValueError("tap the thing to select at least once")
        inputs = {
            "sam3_model_config": ["sam3_model", 0],
            "image": ["source", 0],
            "refinement_iterations": 1,
            "use_multimask": True,
            "output_best_mask": True,
            "positive_points": positive,
        }
        if negative:
            inputs["negative_points"] = negative
        graph["sam3_segment"] = {"class_type": "SAM3Segmentation", "inputs": inputs}
        mask = ["sam3_segment", 0]

    graph["mask_image"] = {"class_type": "MaskToImage", "inputs": {"mask": mask}}
    graph["preview_mask"] = {"class_type": "PreviewImage", "inputs": {"images": ["mask_image", 0]}}
    return graph
