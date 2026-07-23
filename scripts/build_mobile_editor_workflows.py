#!/usr/bin/env python3
"""Rebuild ComfyUI mobile editor workflows from registered API workflows.

The Media Studio registry references editor-format graphs under
`ComfyUI/user/default/workflows/`. Those files are derived state: this script
regenerates each `mobile_workflow` from its `api_workflow` graph plus node
definitions from a running ComfyUI's /object_info.
"""

from __future__ import annotations

import json
import sys
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
REGISTRY = REPO / "packages" / "media-gateway" / "workflow-registry.json"
OBJECT_INFO_PORTS = (8188, 8198, 8199)
WIDGET_TYPES = {"INT", "FLOAT", "STRING", "BOOLEAN"}


def load_object_info() -> dict:
    merged: dict = {}
    for port in OBJECT_INFO_PORTS:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/object_info", timeout=30) as response:
                merged.update(json.loads(response.read().decode("utf-8")))
        except OSError:
            continue
    if not merged:
        raise SystemExit("No running ComfyUI lane answered /object_info; start the stack first")
    return merged


def input_specs(definition: dict) -> list[tuple[str, object, dict]]:
    specs: list[tuple[str, object, dict]] = []
    inputs = definition.get("input") or {}
    for section in ("required", "optional"):
        for name, spec in (inputs.get(section) or {}).items():
            kind = spec[0] if isinstance(spec, (list, tuple)) and spec else spec
            options = spec[1] if isinstance(spec, (list, tuple)) and len(spec) > 1 and isinstance(spec[1], dict) else {}
            specs.append((name, kind, options))
    return specs


def is_widget(kind: object) -> bool:
    return isinstance(kind, list) or (isinstance(kind, str) and kind in WIDGET_TYPES)


def build_editor_graph(api_graph: dict, object_info: dict, extra: dict) -> dict:
    nodes = []
    links = []
    link_id = 0
    incoming: dict[str, list[tuple[str, int, int, int]]] = {}
    outgoing: dict[tuple[str, int], list[int]] = {}

    ordered = sorted(api_graph.items(), key=lambda item: int(item[0]))
    for index, (node_id, node) in enumerate(ordered):
        class_type = node["class_type"]
        definition = object_info.get(class_type)
        if definition is None:
            raise SystemExit(f"Node class {class_type!r} is not known to any running ComfyUI lane")
        api_inputs = node.get("inputs") or {}
        widgets: list = []
        input_slots = []
        for name, kind, options in input_specs(definition):
            value = api_inputs.get(name)
            if isinstance(value, list) and len(value) == 2 and isinstance(value[1], int) and str(value[0]) in api_graph:
                link_id += 1
                source_id, source_slot = str(value[0]), int(value[1])
                slot_type = kind if isinstance(kind, str) else "COMBO"
                links.append([link_id, int(source_id), source_slot, int(node_id), len(input_slots), slot_type])
                outgoing.setdefault((source_id, source_slot), []).append(link_id)
                input_slots.append({"name": name, "type": slot_type, "link": link_id})
            elif is_widget(kind):
                if name in api_inputs:
                    widgets.append(api_inputs[name])
                elif "default" in options:
                    widgets.append(options["default"])
        output_types = definition.get("output") or []
        output_names = definition.get("output_name") or output_types
        outputs = [
            {
                "name": str(output_names[slot]) if slot < len(output_names) else str(output_types[slot]),
                "type": output_types[slot] if isinstance(output_types[slot], str) else "COMBO",
                "links": [],
                "slot_index": slot,
            }
            for slot in range(len(output_types))
        ]
        nodes.append({
            "id": int(node_id),
            "type": class_type,
            "pos": [80 + (index % 6) * 360, 80 + (index // 6) * 260],
            "size": [320, 120],
            "flags": {},
            "order": index,
            "mode": 0,
            "inputs": input_slots,
            "outputs": outputs,
            "properties": {"Node name for S&R": class_type},
            "widgets_values": widgets,
        })

    by_id = {node["id"]: node for node in nodes}
    for (source_id, source_slot), link_ids in outgoing.items():
        outputs = by_id[int(source_id)]["outputs"]
        if source_slot < len(outputs):
            outputs[source_slot]["links"] = link_ids

    return {
        "last_node_id": max((node["id"] for node in nodes), default=0),
        "last_link_id": link_id,
        "nodes": nodes,
        "links": links,
        "groups": [],
        "config": {},
        "extra": extra,
        "version": 0.4,
    }


def main() -> None:
    registry = json.loads(REGISTRY.read_text(encoding="utf-8"))
    object_info = load_object_info()
    built = 0
    for workflow in registry["workflows"]:
        api_path = workflow.get("api_workflow")
        mobile_path = workflow.get("mobile_workflow")
        if not api_path or not mobile_path:
            continue
        api_file = Path(api_path).expanduser()
        if not api_file.is_file():
            print(f"skip {workflow['id']}: api workflow missing at {api_file}", file=sys.stderr)
            continue
        payload = json.loads(api_file.read_text(encoding="utf-8"))
        api_graph = payload.get("prompt") if isinstance(payload.get("prompt"), dict) else payload
        extra: dict = {}
        if isinstance(workflow.get("native_mlx"), dict):
            extra["nativeMlxLtx"] = workflow["native_mlx"]
        editor = build_editor_graph(api_graph, object_info, extra)
        destination = Path(mobile_path).expanduser()
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(json.dumps(editor, indent=2, sort_keys=False) + "\n", encoding="utf-8")
        built += 1
        print(f"built {workflow['id']} -> {destination.name}")
    print(f"{built} mobile editor workflows rebuilt")


if __name__ == "__main__":
    main()
