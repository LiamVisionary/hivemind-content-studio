#!/usr/bin/env python3
"""Derive the optional Apple Turbo editor workflow from the pinned upstream example."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = Path.home() / "comfy/ComfyUI/custom_nodes/comfyui-krea2edit/workflows/krea2_identity_edit.json"
DEFAULT_OUTPUT = ROOT / "workflows/Krea2 Turbo Identity Optional Apple Silicon.json"


def node(nodes, node_id):
    return next(item for item in nodes if item["id"] == node_id)


def input_slot(name, typ, link, optional=False):
    value = {"name": name, "type": typ, "link": link}
    if optional:
        value["shape"] = 7
    return value


def validate(workflow: dict) -> None:
    nodes = {item["id"]: item for item in workflow["nodes"]}
    if len(nodes) != len(workflow["nodes"]):
        raise ValueError("workflow contains duplicate node ids")
    links = {item[0]: item for item in workflow["links"]}
    if len(links) != len(workflow["links"]):
        raise ValueError("workflow contains duplicate link ids")
    for link_id, source_id, source_slot, target_id, target_slot, typ in workflow["links"]:
        if source_id not in nodes or target_id not in nodes:
            raise ValueError(f"link {link_id} references a missing node")
        output = nodes[source_id].get("outputs", [])[source_slot]
        target = nodes[target_id].get("inputs", [])[target_slot]
        if link_id not in (output.get("links") or []):
            raise ValueError(f"link {link_id} is missing from source node {source_id}")
        if target.get("link") != link_id:
            raise ValueError(f"link {link_id} is missing from target node {target_id}")
        if output.get("type") != typ or target.get("type") != typ:
            raise ValueError(f"link {link_id} has inconsistent socket types")
    if workflow["last_link_id"] != max(links, default=0):
        raise ValueError("last_link_id does not match the generated links")


def build(source: Path) -> dict:
    workflow = json.loads(source.read_text(encoding="utf-8"))
    workflow["id"] = "hivemind-krea2-turbo-identity-optional-apple"
    workflow["revision"] = 1
    workflow["last_link_id"] = 18
    workflow["nodes"] = [item for item in workflow["nodes"] if item["id"] not in {71, 73, 90, 92, 102}]
    workflow["groups"] = [group for group in workflow["groups"] if group["id"] != 3]
    nodes = workflow["nodes"]

    loader = node(nodes, 55)
    loader.update({
        "type": "Krea2IdentityOptionalAppleModelLoader",
        "inputs": [input_slot("image", "IMAGE", 1, optional=True)],
        "outputs": [{"name": "MODEL", "type": "MODEL", "links": [2]}],
        "widgets_values": [
            "Krea2_Turbo_convrot_int8mixed.safetensors",
            "Krea2_Turbo_identity_v1_2_convrot_int8mixed.safetensors",
        ],
    })
    loader.setdefault("properties", {})["Node name for S&R"] = "Krea2IdentityOptionalAppleModelLoader"

    clip = node(nodes, 56)
    clip["outputs"] = [{"name": "CLIP", "type": "CLIP", "links": [4, 5]}]
    clip["widgets_values"] = ["qwen3vl_4b_bf16.safetensors", "krea2", "default"]

    vae = node(nodes, 57)
    vae["outputs"] = [{"name": "VAE", "type": "VAE", "links": [6, 7]}]

    image = node(nodes, 72)
    image.update({
        "type": "HivemindOptionalLoadImage",
        "outputs": [
            {"name": "IMAGE", "type": "IMAGE", "links": [1, 9, 10, 11]},
            {"name": "MASK", "type": "MASK", "links": None},
        ],
        "widgets_values": ["None", "image"],
    })
    image.setdefault("properties", {})["Node name for S&R"] = "HivemindOptionalLoadImage"

    patch = node(nodes, 79)
    patch.update({
        "type": "Krea2IdentityOptionalModelPatch",
        "inputs": [
            input_slot("model", "MODEL", 2),
            input_slot("vae", "VAE", 7),
            input_slot("image", "IMAGE", 9, optional=True),
        ],
        "outputs": [{"name": "MODEL", "type": "MODEL", "links": [3]}],
        "widgets_values": [4.0, "fit", True],
    })
    patch.setdefault("properties", {})["Node name for S&R"] = "Krea2IdentityOptionalModelPatch"

    positive = node(nodes, 84)
    positive.update({
        "type": "Krea2IdentityOptionalEncode",
        "inputs": [input_slot("clip", "CLIP", 4), input_slot("image", "IMAGE", 10, optional=True)],
        "outputs": [{"name": "CONDITIONING", "type": "CONDITIONING", "links": [14]}],
        "widgets_values": [
            "Restage the same adult person in a cinematic portrait while preserving exact facial identity.",
            768,
        ],
    })
    positive.setdefault("properties", {})["Node name for S&R"] = "Krea2IdentityOptionalEncode"

    negative = node(nodes, 85)
    negative.update({
        "type": "Krea2IdentityOptionalEncode",
        "inputs": [input_slot("clip", "CLIP", 5), input_slot("image", "IMAGE", 11, optional=True)],
        "outputs": [{"name": "CONDITIONING", "type": "CONDITIONING", "links": [15]}],
        "widgets_values": ["", 768],
    })
    negative.setdefault("properties", {})["Node name for S&R"] = "Krea2IdentityOptionalEncode"

    latent = node(nodes, 82)
    latent["inputs"][0]["link"] = 12
    latent["inputs"][1]["link"] = 13
    latent["outputs"] = [{"name": "LATENT", "type": "LATENT", "links": [16]}]
    resolution = node(nodes, 83)
    resolution["outputs"][0]["links"] = [12]
    resolution["outputs"][1]["links"] = [13]

    sampler = node(nodes, 53)
    sampler["inputs"] = [
        input_slot("model", "MODEL", 3),
        input_slot("positive", "CONDITIONING", 14),
        input_slot("negative", "CONDITIONING", 15),
        input_slot("latent_image", "LATENT", 16),
    ]
    sampler["outputs"] = [{"name": "LATENT", "type": "LATENT", "links": [17]}]
    sampler["widgets_values"] = [42, "randomize", 10, 1, "euler_ancestral", "beta", 1]
    decode = node(nodes, 54)
    decode["inputs"] = [input_slot("samples", "LATENT", 17), input_slot("vae", "VAE", 6)]
    decode["outputs"] = [{"name": "IMAGE", "type": "IMAGE", "links": [18]}]
    save = node(nodes, 29)
    save["inputs"] = [input_slot("images", "IMAGE", 18)]
    save["widgets_values"] = ["krea2_identity_optional"]

    workflow["links"] = [
        [1, 72, 0, 55, 0, "IMAGE"],
        [2, 55, 0, 79, 0, "MODEL"],
        [3, 79, 0, 53, 0, "MODEL"],
        [4, 56, 0, 84, 0, "CLIP"],
        [5, 56, 0, 85, 0, "CLIP"],
        [6, 57, 0, 54, 1, "VAE"],
        [7, 57, 0, 79, 1, "VAE"],
        [9, 72, 0, 79, 2, "IMAGE"],
        [10, 72, 0, 84, 1, "IMAGE"],
        [11, 72, 0, 85, 1, "IMAGE"],
        [12, 83, 0, 82, 0, "INT"],
        [13, 83, 1, 82, 1, "INT"],
        [14, 84, 0, 53, 1, "CONDITIONING"],
        [15, 85, 0, 53, 2, "CONDITIONING"],
        [16, 82, 0, 53, 3, "LATENT"],
        [17, 53, 0, 54, 0, "LATENT"],
        [18, 54, 0, 29, 0, "IMAGE"],
    ]

    node(nodes, 100)["widgets_values"] = [
        "Pinned dependencies:\n- Krea2_Turbo_convrot_int8mixed.safetensors\n- Krea2_Turbo_identity_v1_2_convrot_int8mixed.safetensors\n- qwen3vl_4b_bf16.safetensors\n- qwen_image_vae.safetensors\n- lbouaraba/comfyui-krea2edit"
    ]
    node(nodes, 101)["widgets_values"] = [
        "OPTIONAL REFERENCE IMAGE\n\nLeave this set to None for the regular prebuilt Krea 2 Turbo ConvRot route. Load one adult reference image to select the prebuilt identity ConvRot model, VAE source tokens, grounded Qwen3-VL conditioning, and static source-token cache."
    ]
    node(nodes, 105)["widgets_values"] = [
        "Turbo defaults: 10 steps, CFG 1, euler_ancestral / beta.\n\n8 steps favors composition/instruction adherence; 12 steps can add face detail."
    ]
    node(nodes, 106)["widgets_values"] = [
        "KREA 2 TURBO IDENTITY EDIT v1.2\n\nNo image: regular optimized Krea 2 Turbo.\nImage supplied: the dedicated identity-baked ConvRot lane plus source-token patch, grounded vision conditioning, and exact pre-block caching."
    ]
    workflow.setdefault("extra", {})["workflow_name"] = "Krea2 Turbo Identity Optional Apple Silicon"
    validate(workflow)
    return workflow


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    workflow = build(args.source.expanduser().resolve())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(workflow, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(args.output.resolve())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
