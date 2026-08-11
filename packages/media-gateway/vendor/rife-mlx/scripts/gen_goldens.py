"""P1: PyTorch parity oracle. Requires [parity] extra + refs/<v>/ package.

Captures (seed 1234, CPU fp32) → goldens/<v>.npz, all stored NCHW/NHWC as noted:
  - warp:        random img + random flow -> warped            (Gate A)
  - interp_up/dn: bilinear resize at 2x and 0.5x                (Gate A)
  - ifnet_full:  IFNet(img0,img1,t=0.5,scale=1) merged frame   (Gate B)
  - ifnet inputs img0/img1 (so the MLX side runs the same input)

A minimal model/warplayer.py shim is created under refs/<v>/ so the bundled
train_log code imports without the full Practical-RIFE repo.
"""

from __future__ import annotations

import os
import sys

import numpy as np

V = sys.argv[1] if len(sys.argv) > 1 else "4.25"
REFS = os.path.join("refs", V)
SEED = 1234
sys.path.insert(0, REFS)
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import torch  # noqa: E402
import torch.nn.functional as F  # noqa: E402


def main() -> None:
    from train_log.IFNet_HDv3 import IFNet  # bundled arch

    os.makedirs("goldens", exist_ok=True)
    rng = np.random.default_rng(SEED)
    torch.manual_seed(SEED)
    out: dict[str, np.ndarray] = {}

    # --- warp oracle (NCHW in torch) ---
    img = rng.random((1, 4, 24, 32)).astype(np.float32)
    flow = (rng.random((1, 2, 24, 32)).astype(np.float32) - 0.5) * 8.0
    from model.warplayer import warp
    w = warp(torch.from_numpy(img), torch.from_numpy(flow)).detach().numpy()
    out["warp_img_nchw"] = img
    out["warp_flow_nchw"] = flow
    out["warp_out_nchw"] = w

    # --- bilinear interpolate oracle (align_corners=False, as in IFBlock) ---
    x = rng.random((1, 3, 20, 28)).astype(np.float32)
    out["interp_in_nchw"] = x
    out["interp_up2_nchw"] = F.interpolate(torch.from_numpy(x), scale_factor=2.0,
                                           mode="bilinear", align_corners=False).numpy()
    out["interp_dn2_nchw"] = F.interpolate(torch.from_numpy(x), scale_factor=0.5,
                                           mode="bilinear", align_corners=False).numpy()

    # --- full IFNet inference oracle ---
    m = IFNet().eval()
    sd = torch.load(os.path.join(REFS, "train_log", "flownet.pkl"),
                    map_location="cpu", weights_only=True)
    sd = {k.replace("module.", ""): v for k, v in sd.items()}
    m.load_state_dict(sd, strict=False)

    H, W = 64, 64
    img0 = rng.random((1, 3, H, W)).astype(np.float32)
    img1 = rng.random((1, 3, H, W)).astype(np.float32)
    scale = 1.0
    scale_list = [16 / scale, 8 / scale, 4 / scale, 2 / scale, 1 / scale]
    with torch.no_grad():
        flow_l, mask, merged = m(torch.cat((torch.from_numpy(img0),
                                            torch.from_numpy(img1)), 1), 0.5, scale_list)
    out["ifnet_img0_nchw"] = img0
    out["ifnet_img1_nchw"] = img1
    out["ifnet_merged_nchw"] = merged[-1].detach().numpy()
    out["ifnet_flow_final_nchw"] = flow_l[-1].detach().numpy()

    np.savez(os.path.join("goldens", f"{V}.npz"), **out)
    print(f"OK goldens/{V}.npz:")
    for k, v in out.items():
        print(f"   {k:22s} {tuple(v.shape)}")
    mm = out["ifnet_merged_nchw"]
    print(f"   merged range [{mm.min():.4f}, {mm.max():.4f}]")


if __name__ == "__main__":
    main()
