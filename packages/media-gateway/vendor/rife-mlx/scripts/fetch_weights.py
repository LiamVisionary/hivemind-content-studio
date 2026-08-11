"""P1: download the pinned RIFE version package (model .py + flownet.pkl).

Weights ship via Google Drive only (no HF), bundled with the version's arch .py.
Uses gdown. Output: refs/<version>/ containing IFNet_HDv3.py, RIFE_HDv3.py,
flownet.pkl. The arch .py is then read to PIN config.py (block count, channels,
scale_list, align_corners) before any porting.

  python scripts/fetch_weights.py 4.25
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from rife_mlx.config import VERSIONS  # noqa: E402


def main() -> None:
    version = sys.argv[1] if len(sys.argv) > 1 else "4.25"
    cfg = VERSIONS[version]
    out = os.path.join("refs", version)
    os.makedirs(out, exist_ok=True)
    import gdown
    # per-version package is a zip on Drive; gdown fetches by id, then unzip
    dst = os.path.join(out, f"RIFE_{version}.zip")
    gdown.download(id=cfg.gdrive_id, output=dst, quiet=False)
    print(f"downloaded -> {dst}  (unzip into {out}/ to expose IFNet_HDv3.py + flownet.pkl)")


if __name__ == "__main__":
    main()
