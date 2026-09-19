#!/usr/bin/env python3
"""Compile the shared Krea2 canvas preparation fragment for an LTX anchor."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from hardware_profile import detect_profile  # noqa: E402
from krea2_identity_workflow import build_krea2_turbo_outpaint_prompt  # noqa: E402


def main() -> int:
    request = json.load(sys.stdin)
    source = Path(str(request.get("source") or "")).expanduser().resolve()
    if not source.is_file():
        raise ValueError(f"anchor source does not exist: {source}")
    image_name = str(request.get("image_name") or source.name).strip()
    width = int(request.get("width") or 768)
    height = int(request.get("height") or 448)
    if width < 64 or height < 64 or width > 4096 or height > 4096:
        raise ValueError("anchor target dimensions must be between 64 and 4096")
    with Image.open(source) as image:
        source_width, source_height = image.size
    profile = str(request.get("profile") or "").strip() or detect_profile(os.environ)
    result = build_krea2_turbo_outpaint_prompt(
        request.get("prompt") or "",
        image_name,
        source_width=source_width,
        source_height=source_height,
        options={
            "width": width,
            "height": height,
            "seed": int(request.get("seed") or 42),
            "steps": int(request.get("steps") or 10),
            "cfg": float(request.get("cfg") or 1.0),
            "ref_boost": float(request.get("ref_boost") or 4.0),
            "identity_strength": float(request.get("identity_strength") or 1.0),
            "grounding_px": int(request.get("grounding_px") or 768),
            "feathering": int(request.get("feathering") or 48),
        },
        profile=profile,
        filename_prefix=str(request.get("filename_prefix") or "ltx_anchor_outpaint"),
    )
    result["graph"].pop("12", None)
    print(json.dumps({**result, "profile": profile}, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)
