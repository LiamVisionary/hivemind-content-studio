#!/usr/bin/env python3
"""Phase-2 validation: Krea2 convrot image, WAI Anima image, eros v1.4+DMD video."""
import json
import time
import urllib.request

BASE = "http://localhost:18188"


def run(name, graph, timeout=1200):
    req = urllib.request.Request(BASE + "/prompt", data=json.dumps({"prompt": graph}).encode(),
                                 headers={"Content-Type": "application/json"})
    try:
        resp = json.load(urllib.request.urlopen(req))
    except urllib.error.HTTPError as e:
        print(f"[{name}] SUBMIT FAILED:", e.read().decode()[:1500], flush=True)
        return False
    pid = resp["prompt_id"]
    t0 = time.time()
    while True:
        hist = json.load(urllib.request.urlopen(BASE + f"/history/{pid}"))
        if pid in hist:
            st = hist[pid].get("status", {})
            if st.get("completed") or st.get("status_str") == "error":
                dt = time.time() - t0
                if st.get("status_str") == "error":
                    msgs = [m for m in st.get("messages", []) if m[0] == "execution_error"]
                    err = msgs[0][1] if msgs else {}
                    print(f"[{name}] ERROR after {dt:.0f}s node={err.get('node_type')}: "
                          f"{err.get('exception_message','')[:400]}", flush=True)
                    return False
                outs = [i.get("filename") for o in hist[pid].get("outputs", {}).values()
                        for k in ("images", "video", "gifs") for i in o.get(k, [])]
                print(f"[{name}] SUCCESS in {dt:.0f}s -> {outs}", flush=True)
                return True
        if time.time() - t0 > timeout:
            print(f"[{name}] TIMEOUT", flush=True)
            return False
        time.sleep(8)


SFW_GIRL = "1girl, solo, looking at viewer, upper body, anime coloring, cherry blossom park, smiling"
ANIMA_NEG = "worst quality, low quality, score_1, score_2, score_3, blurry, jpeg artifacts"

krea2 = {
    "1": {"class_type": "OTUNetLoaderW8A8",
          "inputs": {"unet_name": "Krea2_Turbo_convrot_int8mixed.safetensors",
                     "weight_dtype": "default", "model_type": "krea2",
                     "on_the_fly_quantization": False, "enable_convrot": True,
                     "lora_mode": "None"}},
    "2": {"class_type": "CLIPLoader",
          "inputs": {"clip_name": "qwen3VL4BAbliteratedComfyui_v10.safetensors",
                     "type": "krea2", "device": "default"}},
    "3": {"class_type": "CLIPTextEncode",
          "inputs": {"clip": ["2", 0], "text": "photo of a corgi puppy sitting in a field of "
                     "sunflowers at golden hour, shallow depth of field, 85mm portrait"}},
    "4": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": "blurry, lowres, watermark"}},
    "5": {"class_type": "VAELoader", "inputs": {"vae_name": "qwen_image_vae.safetensors"}},
    "6": {"class_type": "EmptyLatentImage", "inputs": {"width": 1024, "height": 1024, "batch_size": 1}},
    "7": {"class_type": "KSampler",
          "inputs": {"model": ["1", 0], "seed": 7, "steps": 8, "cfg": 1.0,
                     "sampler_name": "deis", "scheduler": "simple", "denoise": 1.0,
                     "positive": ["3", 0], "negative": ["4", 0], "latent_image": ["6", 0]}},
    "8": {"class_type": "VAEDecode", "inputs": {"samples": ["7", 0], "vae": ["5", 0]}},
    "9": {"class_type": "SaveImage", "inputs": {"images": ["8", 0], "filename_prefix": "krea2_cuda"}},
}

anima = {
    "1": {"class_type": "UNETLoader",
          "inputs": {"unet_name": "waiANIMA_v10Base10.safetensors", "weight_dtype": "default"}},
    "2": {"class_type": "LoraLoaderModelOnly",
          "inputs": {"model": ["1", 0], "lora_name": "anima-turbo-lora-v0.2.safetensors",
                     "strength_model": 0.85}},
    "3": {"class_type": "CLIPLoader",
          "inputs": {"clip_name": "waiANIMA_v10Base10_txt.safetensors",
                     "type": "stable_diffusion", "device": "default"}},
    "4": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["3", 0], "text": SFW_GIRL}},
    "5": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["3", 0], "text": ANIMA_NEG}},
    "6": {"class_type": "VAELoader", "inputs": {"vae_name": "qwen_image_vae.safetensors"}},
    "7": {"class_type": "EmptyQwenImageLayeredLatentImage",
          "inputs": {"width": 1024, "height": 1344, "layers": 0, "batch_size": 1}},
    "8": {"class_type": "KSampler",
          "inputs": {"model": ["2", 0], "seed": 7, "steps": 8, "cfg": 1.0,
                     "sampler_name": "euler", "scheduler": "normal", "denoise": 1.0,
                     "positive": ["4", 0], "negative": ["5", 0], "latent_image": ["7", 0]}},
    "9": {"class_type": "VAEDecode", "inputs": {"samples": ["8", 0], "vae": ["6", 0]}},
    "10": {"class_type": "SaveImage", "inputs": {"images": ["9", 0], "filename_prefix": "anima_cuda"}},
}

EROS_POS = ("A woman in a red summer dress dances gracefully in a sunlit park, "
            "flowing fabric, camera slowly orbiting, cinematic, warm light.")
eros = {
    "1": {"class_type": "CheckpointLoaderSimple",
          "inputs": {"ckpt_name": "ltx2310eros_v14.safetensors"}},
    "1L": {"class_type": "LoraLoaderModelOnly",
           "inputs": {"model": ["1", 0], "lora_name": "ltx2310eros_v14_dmd_lora.safetensors",
                      "strength_model": 1.0}},
    "2": {"class_type": "LTXAVTextEncoderLoader",
          "inputs": {"text_encoder": "gemma_3_12B_it_fp8_scaled.safetensors",
                     "ckpt_name": "ltx2310eros_v14.safetensors", "device": "default"}},
    "3": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": EROS_POS}},
    "4": {"class_type": "CLIPTextEncode",
          "inputs": {"clip": ["2", 0], "text": "blurry, distorted, deformed, low quality, watermark"}},
    "5": {"class_type": "LTXVConditioning",
          "inputs": {"positive": ["3", 0], "negative": ["4", 0], "frame_rate": 25.0}},
    "6": {"class_type": "EmptyLTXVLatentVideo",
          "inputs": {"width": 768, "height": 512, "length": 97, "batch_size": 1}},
    "13": {"class_type": "LTXVAudioVAELoader", "inputs": {"ckpt_name": "ltx2310eros_v14.safetensors"}},
    "14": {"class_type": "LTXVEmptyLatentAudio",
           "inputs": {"frames_number": 97, "frame_rate": 25, "batch_size": 1, "audio_vae": ["13", 0]}},
    "15": {"class_type": "LTXVConcatAVLatent",
           "inputs": {"video_latent": ["6", 0], "audio_latent": ["14", 0]}},
    "7": {"class_type": "LTXVScheduler",
          "inputs": {"steps": 8, "max_shift": 2.05, "base_shift": 0.95,
                     "stretch": True, "terminal": 0.1, "latent": ["15", 0]}},
    "8": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}},
    "9": {"class_type": "SamplerCustom",
          "inputs": {"model": ["1L", 0], "add_noise": True, "noise_seed": 7,
                     "cfg": 1.0, "positive": ["5", 0], "negative": ["5", 1],
                     "sampler": ["8", 0], "sigmas": ["7", 0], "latent_image": ["15", 0]}},
    "16": {"class_type": "LTXVSeparateAVLatent", "inputs": {"av_latent": ["9", 0]}},
    "10": {"class_type": "VAEDecode", "inputs": {"samples": ["16", 0], "vae": ["1", 2]}},
    "11": {"class_type": "CreateVideo", "inputs": {"images": ["10", 0], "fps": 25.0}},
    "12": {"class_type": "SaveVideo",
           "inputs": {"video": ["11", 0], "filename_prefix": "eros_dmd_cuda",
                      "format": "mp4", "codec": "h264"}},
}

results = {}
results["krea2"] = run("krea2-convrot", krea2)
results["anima"] = run("wai-anima", anima)
results["eros"] = run("eros-v14-dmd", eros)
print("SUMMARY:", json.dumps(results), flush=True)
print("ALL TESTS DONE", flush=True)
