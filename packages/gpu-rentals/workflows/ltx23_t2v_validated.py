#!/usr/bin/env python3
"""Submit an LTX-2.3 text-to-video job to local ComfyUI and wait for output."""
import json
import time
import urllib.request

BASE = "http://localhost:18188"

info = json.load(urllib.request.urlopen(BASE + "/object_info"))
enc_out = info["LTXAVTextEncoderLoader"]["output"]
cond_out = info["LTXVConditioning"]["output"]
print("encoder outputs:", enc_out, "| conditioning outputs:", cond_out, flush=True)
assert enc_out[0] == "CLIP", "unexpected encoder output"

POS = ("A golden retriever puppy runs through a sunny wildflower meadow in slow "
       "motion, fur rippling, flower petals drifting in the breeze, warm "
       "afternoon light, shallow depth of field, cinematic nature footage.")
NEG = "blurry, distorted, deformed, low quality, watermark, text, jittery"

g = {
    "1": {"class_type": "CheckpointLoaderSimple",
          "inputs": {"ckpt_name": "ltx-2.3-22b-dev-fp8.safetensors"}},
    "2": {"class_type": "LTXAVTextEncoderLoader",
          "inputs": {"text_encoder": "gemma_3_12B_it_fp8_scaled.safetensors",
                     "ckpt_name": "ltx-2.3-22b-dev-fp8.safetensors",
                     "device": "default"}},
    "3": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": POS}},
    "4": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": NEG}},
    "5": {"class_type": "LTXVConditioning",
          "inputs": {"positive": ["3", 0], "negative": ["4", 0], "frame_rate": 25.0}},
    "6": {"class_type": "EmptyLTXVLatentVideo",
          "inputs": {"width": 768, "height": 512, "length": 97, "batch_size": 1}},
    "13": {"class_type": "LTXVAudioVAELoader",
           "inputs": {"ckpt_name": "ltx-2.3-22b-dev-fp8.safetensors"}},
    "14": {"class_type": "LTXVEmptyLatentAudio",
           "inputs": {"frames_number": 97, "frame_rate": 25,
                      "batch_size": 1, "audio_vae": ["13", 0]}},
    "15": {"class_type": "LTXVConcatAVLatent",
           "inputs": {"video_latent": ["6", 0], "audio_latent": ["14", 0]}},
    "7": {"class_type": "LTXVScheduler",
          "inputs": {"steps": 20, "max_shift": 2.05, "base_shift": 0.95,
                     "stretch": True, "terminal": 0.1, "latent": ["15", 0]}},
    "8": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}},
    "9": {"class_type": "SamplerCustom",
          "inputs": {"model": ["1", 0], "add_noise": True, "noise_seed": 42,
                     "cfg": 3.0, "positive": ["5", 0], "negative": ["5", 1],
                     "sampler": ["8", 0], "sigmas": ["7", 0],
                     "latent_image": ["15", 0]}},
    "16": {"class_type": "LTXVSeparateAVLatent", "inputs": {"av_latent": ["9", 0]}},
    "10": {"class_type": "VAEDecode", "inputs": {"samples": ["16", 0], "vae": ["1", 2]}},
    "11": {"class_type": "CreateVideo", "inputs": {"images": ["10", 0], "fps": 25.0}},
    "12": {"class_type": "SaveVideo",
           "inputs": {"video": ["11", 0], "filename_prefix": "ltx_smoke",
                      "format": "mp4", "codec": "h264"}},
}

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
            print("status:", st.get("status_str"), "| elapsed: %.0fs" % (time.time() - t0), flush=True)
            if st.get("status_str") == "error":
                msgs = [m for m in st.get("messages", []) if m[0] == "execution_error"]
                print("ERROR DETAIL:", json.dumps(msgs)[:3000], flush=True)
                raise SystemExit(1)
            for node, out in hist[pid].get("outputs", {}).items():
                for k in ("images", "video", "gifs"):
                    for item in out.get(k, []):
                        print("OUTPUT:", item.get("subfolder", ""), item.get("filename"), flush=True)
            break
    if time.time() - t0 > 1800:
        print("TIMEOUT after 30min", flush=True)
        raise SystemExit(1)
    time.sleep(10)
print("RUN COMPLETE", flush=True)
