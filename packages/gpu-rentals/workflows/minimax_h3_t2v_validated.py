#!/usr/bin/env python3
"""Submit a MiniMax H3 text-to-video(+audio) job to ComfyUI and wait.

Mirrors ltx23_t2v_validated.py. Graph is the official Comfy-Org
video_minimax_h3_t2v template (subgraph expanded to API format) with the
SpectrumApplyMiniMaxH3 node spliced onto the MODEL edge — toggle it with
SPECTRUM=0/1 (default 1) to A/B native vs forecast-accelerated sampling.

Env:
  BASE      ComfyUI base URL          (default http://localhost:18188)
  SPECTRUM  1 = Spectrum conservative preset, 0 = native      (default 1)
  SAGE      1 = insert the KJNodes SageAttention patch        (default 0)
  SECONDS   clip duration in seconds                          (default 4)
  WIDTH/HEIGHT  multiple of 32, H3 native short edge 768      (default 864x480)
  STEPS     sampler steps (community: 15 ~= 20 for H3)        (default 20)
  SEED      noise seed                                        (default 42)

Requires ComfyUI >= e377e263 (2026-08-03: native MiniMax H3 + packed-latent
sampler API) and the ComfyUI-Spectrum-MiniMax-H3 custom node when SPECTRUM=1.
"""
import json
import os
import time
import urllib.request

BASE = os.environ.get("BASE", "http://localhost:18188")
SPECTRUM = os.environ.get("SPECTRUM", "1") == "1"
SAGE = os.environ.get("SAGE", "0") == "1"
# TURBO=1: larryvrh 4-step distill (drbaph ckpt500 conversion) — 8 steps,
# LoRA strength 1.0, MANDATORY sigma shift video 12 / audio 6. Forces
# SPECTRUM off (no forecast window at 8 steps).
TURBO = os.environ.get("TURBO", "0") == "1"
if TURBO:
    SPECTRUM = False
SECONDS = float(os.environ.get("SECONDS", "4"))
WIDTH = int(os.environ.get("WIDTH", "864"))
HEIGHT = int(os.environ.get("HEIGHT", "480"))
STEPS = int(os.environ.get("STEPS", "8" if TURBO else "20"))
SEED = int(os.environ.get("SEED", "42"))

# Official frame grid: 24fps, length snaps UP to 17k+5.
raw = max(5, round(SECONDS * 24))
LENGTH = raw + (5 - raw % 17) % 17

info = json.load(urllib.request.urlopen(BASE + "/object_info"))
for required in ("MiniMaxH3ImageToVideo", "VAEDecodeAudio", "CreateVideo"):
    assert required in info, f"ComfyUI too old: missing {required}"
if SPECTRUM:
    assert "SpectrumApplyMiniMaxH3" in info, "Spectrum custom node not installed"
SAGE_NODE = None
if SAGE:
    # KJNodes ships the patch under a historically typo'd class name; accept both.
    SAGE_NODE = next((n for n in ("PathchSageAttentionKJ", "PatchSageAttentionKJ") if n in info), None)
    assert SAGE_NODE, "SAGE=1 but no SageAttention patch node (install comfyui-kjnodes + pip sageattention)"
if TURBO:
    assert "MiniMaxH3SigmaShift" in info, "ComfyUI too old for MiniMaxH3SigmaShift"
print(f"nodes ok | turbo={'on' if TURBO else 'off'} | spectrum={'on' if SPECTRUM else 'off'} "
      f"| sage={'on' if SAGE_NODE else 'off'} "
      f"| {WIDTH}x{HEIGHT} f{LENGTH} steps={STEPS} seed={SEED}", flush=True)

PROMPT = (
    "A cheerful young woman stands on an airport moving walkway that carries "
    "her slowly toward the camera, one hand on her rolling suitcase. Static "
    "medium close-up, her face sharp and well lit. She looks into the lens "
    "and speaks, lips moving in clear sync with her words. She says warmly: "
    "\"I've gotta catch this flight, but I'm so excited to generate cool "
    "content on Hivemind OS.\" She giggles softly at the end.\n\n"
    "Audio: clear female voice in sync with her lips, quiet airport ambience, "
    "soft rolling luggage sounds, no music.\n\n"
    "The camera never moves. No text, subtitles, logos or watermarks."
)

# Model patch chain: UNETLoader -> (Turbo LoRA) -> (SageAttention) ->
# (SigmaShift, turbo-mandatory) -> (Spectrum) -> guider/scheduler
BASE_MODEL_NODE = "6"
if TURBO:
    BASE_MODEL_NODE = "turbo_lora"
if SAGE:
    SAGE_UPSTREAM = BASE_MODEL_NODE
    BASE_MODEL_NODE = "sage"
if TURBO:
    SHIFT_UPSTREAM = BASE_MODEL_NODE
    BASE_MODEL_NODE = "sigma_shift"
MODEL_NODE = "spectrum" if SPECTRUM else BASE_MODEL_NODE

g = {
    "6": {"class_type": "UNETLoader",
          "inputs": {"unet_name": "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
                     "weight_dtype": "default"}},
    "13": {"class_type": "CLIPLoader",
           "inputs": {"clip_name": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
                      "type": "minimax", "device": "default"}},
    "11": {"class_type": "VAELoader",
           "inputs": {"vae_name": "minimax_h3_video_vae_fp16.safetensors"}},
    "24": {"class_type": "VAELoader",
           "inputs": {"vae_name": "minimax_h3_audio_vae_fp32.safetensors"}},
    "104": {"class_type": "MiniMaxH3ImageToVideo",
            "inputs": {"clip": ["13", 0], "vae": ["11", 0], "prompt": PROMPT,
                       "width": WIDTH, "height": HEIGHT, "length": LENGTH}},
    "9": {"class_type": "BasicScheduler",
          "inputs": {"model": [MODEL_NODE, 0], "scheduler": "simple",
                     "steps": STEPS, "denoise": 1.0}},
    "17": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "res_multistep"}},
    "15": {"class_type": "RandomNoise", "inputs": {"noise_seed": SEED}},
    "16": {"class_type": "BasicGuider",
           "inputs": {"model": [MODEL_NODE, 0], "conditioning": ["104", 0]}},
    "14": {"class_type": "SamplerCustomAdvanced",
           "inputs": {"noise": ["15", 0], "guider": ["16", 0], "sampler": ["17", 0],
                      "sigmas": ["9", 0], "latent_image": ["104", 1]}},
    "10": {"class_type": "VAEDecode", "inputs": {"samples": ["14", 0], "vae": ["11", 0]}},
    "23": {"class_type": "VAEDecodeAudio",
           "inputs": {"samples": ["14", 0], "vae": ["24", 0]}},
    "91": {"class_type": "CreateVideo",
           "inputs": {"images": ["10", 0], "audio": ["23", 0], "fps": 24}},
    "92": {"class_type": "SaveVideo",
           "inputs": {"video": ["91", 0],
                      "filename_prefix": "minimax_h3_smoke_"
                                         + ("turbo" if TURBO else ("spectrum" if SPECTRUM else "native"))
                                         + ("_sage" if SAGE else "")
                                         + f"_s{STEPS}",
                      "format": "mp4", "codec": "h264"}},
}

if TURBO:
    g["turbo_lora"] = {"class_type": "LoraLoaderModelOnly",
                       "inputs": {"model": ["6", 0],
                                  "lora_name": "minimax_h3_turbo_4step_ckpt500_pruned_comfyui.safetensors",
                                  "strength_model": 1.0}}

if SAGE:
    g["sage"] = {"class_type": SAGE_NODE,
                 "inputs": {"model": [SAGE_UPSTREAM if SAGE else "6", 0],
                            "sage_attention": "auto"}}

if TURBO:
    g["sigma_shift"] = {"class_type": "MiniMaxH3SigmaShift",
                        "inputs": {"model": [SHIFT_UPSTREAM, 0],
                                   "shift_video": 12.0, "shift_audio": 6.0}}

if SPECTRUM:
    # Conservative preset from the Spectrum README. RES multistep keeps its
    # final 3 solver steps native regardless of tail_actual_steps.
    g["spectrum"] = {"class_type": "SpectrumApplyMiniMaxH3",
                     "inputs": {"model": [BASE_MODEL_NODE, 0], "enabled": True,
                                "blend_weight": 0.50, "degree": 4,
                                "ridge_lambda": 0.10, "window_size": 2.0,
                                "flex_window": 0.75, "warmup_steps": 5,
                                "tail_actual_steps": 1, "max_history": 8,
                                "debug": True,
                                "history_storage": "system_ram"}}

req = urllib.request.Request(
    BASE + "/prompt", data=json.dumps({"prompt": g}).encode(),
    headers={"Content-Type": "application/json"})
try:
    resp = json.load(urllib.request.urlopen(req))
except urllib.error.HTTPError as e:
    print("SUBMIT FAILED:", e.read().decode()[:2000], flush=True)
    raise SystemExit(1)
pid = resp["prompt_id"]
print("prompt_id:", pid, "| queue errors:", resp.get("node_errors") or "none", flush=True)

t0 = time.time()
while True:
    hist = json.load(urllib.request.urlopen(BASE + f"/history/{pid}"))
    if pid in hist:
        st = hist[pid].get("status", {})
        if st.get("completed") or st.get("status_str") == "error":
            elapsed = time.time() - t0
            print(f"status: {st.get('status_str')} | elapsed: {elapsed:.0f}s", flush=True)
            if st.get("status_str") == "error":
                msgs = [m for m in st.get("messages", []) if m[0] == "execution_error"]
                print("ERROR DETAIL:", json.dumps(msgs)[:3000], flush=True)
                raise SystemExit(1)
            for node, out in hist[pid].get("outputs", {}).items():
                for k in ("images", "video", "gifs"):
                    for item in out.get(k, []):
                        print("OUTPUT:", item.get("subfolder", ""),
                              item.get("filename"), flush=True)
            break
    if time.time() - t0 > 2400:
        print("TIMEOUT after 40min", flush=True)
        raise SystemExit(1)
    time.sleep(10)
print("RUN COMPLETE", flush=True)
