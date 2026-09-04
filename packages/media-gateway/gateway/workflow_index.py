"""The durable output -> encrypted-workflow-envelope index, and the studio
setup records harvested from a graph."""
import json
import re
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from gateway import graphs, lanes, media as _media, net, util


# --- Persistent output -> encrypted-workflow-envelope index -------------------
#
# ComfyUI runs with --disable-metadata, so output files never contain their
# workflow; "load workflow from image" historically depended on ComfyUI's
# in-memory history, which dies on every restart. This index harvests the
# encrypted workflow envelope + output filenames from each lane's history
# while it is alive and persists the mapping, so workflow recovery survives
# restarts and output encryption. Only encrypted envelopes are stored - the
# same client-side key model as everywhere else; no plaintext workflows.
WORKFLOW_INDEX_FILE = Path.home() / ".comfy-private.noindex" / "output-workflow-index.jsonl"
workflow_index_lock = threading.Lock()
_workflow_index = {}
_workflow_index_records = {}
_workflow_index_prompts = set()


def _is_encrypted_workflow_envelope(value):
    return (
        isinstance(value, dict)
        and value.get("encrypted") is True
        and value.get("format") == "comfyui-mobile-encrypted-workflow"
    )


def _envelope_records_from_history(hist, seen_prompt_ids=None):
    """Extract {prompt_id, filenames, workflow} records from a Comfy /history payload."""
    seen = seen_prompt_ids if seen_prompt_ids is not None else set()
    records = []
    for pid, item in (hist or {}).items():
        if not isinstance(item, dict) or pid in seen:
            continue
        prompt = item.get("prompt")
        extra = prompt[3] if isinstance(prompt, (list, tuple)) and len(prompt) > 3 else None
        workflow = (((extra or {}).get("extra_pnginfo") or {}).get("workflow")) if isinstance(extra, dict) else None
        if not _is_encrypted_workflow_envelope(workflow):
            continue
        filenames = []
        for out in (item.get("outputs") or {}).values():
            if not isinstance(out, dict):
                continue
            for key in ("images", "gifs", "videos"):
                for media in out.get(key) or []:
                    name = media.get("filename") if isinstance(media, dict) else None
                    if isinstance(name, str) and name:
                        filenames.append(name)
        if filenames:
            records.append({"prompt_id": pid, "filenames": filenames, "workflow": workflow})
    return records


def _load_workflow_index():
    try:
        if not WORKFLOW_INDEX_FILE.exists():
            return
        with WORKFLOW_INDEX_FILE.open("r", encoding="utf-8") as f:
            for line in f:
                try:
                    rec = json.loads(line)
                except Exception:
                    continue
                workflow = rec.get("workflow")
                if not _is_loadable_workflow_envelope(workflow):
                    continue
                for name in rec.get("filenames") or []:
                    if isinstance(name, str) and name:
                        _workflow_index[name] = workflow
                        _workflow_index_records[name] = {
                            "prompt_id": rec.get("prompt_id"),
                            "lane": rec.get("lane"),
                            "recorded_at": rec.get("recorded_at"),
                        }
                pid = rec.get("prompt_id")
                if pid:
                    _workflow_index_prompts.add(pid)
    except Exception as e:
        print(f"[workflow-index] load failed: {e}", file=sys.stderr)


def _harvest_comfy_workflow_envelopes():
    added = 0
    for lane, base in lanes.COMFY_LANES.items():
        try:
            with net.urlopen(lanes.comfy_lane_request(lane, "/history?max_items=128"), timeout=10) as r:
                hist = json.load(r)
        except Exception:
            continue
        with workflow_index_lock:
            seen = set(_workflow_index_prompts)
        for rec in _envelope_records_from_history(hist, seen):
            rec["lane"] = lane
            rec["recorded_at"] = datetime.now(timezone.utc).isoformat()
            with workflow_index_lock:
                if rec["prompt_id"] in _workflow_index_prompts:
                    continue
                _workflow_index_prompts.add(rec["prompt_id"])
                for name in rec["filenames"]:
                    _workflow_index[name] = rec["workflow"]
                    _workflow_index_records[name] = {
                        "prompt_id": rec.get("prompt_id"),
                        "lane": rec.get("lane"),
                        "recorded_at": rec.get("recorded_at"),
                    }
                try:
                    WORKFLOW_INDEX_FILE.parent.mkdir(parents=True, exist_ok=True)
                    with WORKFLOW_INDEX_FILE.open("a", encoding="utf-8") as f:
                        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
                except Exception as e:
                    print(f"[workflow-index] append failed: {e}", file=sys.stderr)
            added += 1
    return added


def workflow_index_sweeper():
    _load_workflow_index()
    while True:
        try:
            _harvest_comfy_workflow_envelopes()
        except Exception as e:
            print(f"[workflow-index] sweeper error: {e}", file=sys.stderr)
        time.sleep(15)


def workflow_envelope_for_filename(name):
    with workflow_index_lock:
        return _workflow_index.get(name)


def workflow_index_record_for_filename(name):
    with workflow_index_lock:
        rec = _workflow_index_records.get(name)
        return dict(rec) if isinstance(rec, dict) else None


VAULT_SEALED_SETUP_FORMAT = "hivemind-vault-sealed-setup"


def _is_vault_sealed_setup(value):
    return (
        isinstance(value, dict)
        and value.get("format") == VAULT_SEALED_SETUP_FORMAT
        and isinstance(value.get("ciphertext"), str)
        and isinstance(value.get("wrapped_dek"), str)
    )


def _is_loadable_workflow_envelope(value):
    return _is_encrypted_workflow_envelope(value) or _is_vault_sealed_setup(value)


def seal_json_to_vault(obj):
    """Seal a small JSON object to the owner vault public key (RSA-OAEP + AES-GCM),
    the same wire format as media (frontend `decryptMedia`). Server can encrypt but
    never decrypt. Returns the envelope dict, or None if no vault exists yet."""
    spki = _media.vault_public_key_spki()
    if not spki:
        return None
    # No temp files and no subprocess: the setup graph is small, and it used to
    # be written to disk in PLAINTEXT for the helper to read before being
    # sealed. In-process sealing closes that window entirely.
    import media_seal

    sealed = media_seal.seal(
        json.dumps(obj, ensure_ascii=False).encode("utf-8"),
        media_seal.load_public_key(spki),
    )
    return {
        "format": VAULT_SEALED_SETUP_FORMAT,
        "v": 1,
        "ciphertext": sealed["ciphertext"],
        "wrapped_dek": sealed["wrapped_dek"],
    }


def _studio_setup_from_graph(graph):
    """Extract the FULL composer-recoverable setup (prompt, negative, seed, steps,
    cfg, dimensions, model checkpoint, LoRAs) from a resolved auto-workflow API
    graph, so 'Load in Studio' can restore every exact setting."""
    sampler = next((n for n in graph.values() if isinstance(n, dict) and str(n.get("class_type")) in graphs._AUTO_SAMPLER_CLASSES), None)
    prompt_text = ""
    negative_text = ""
    seed_val = steps_val = cfg_val = None
    pos_id = None
    if sampler:
        si = sampler.get("inputs") or {}
        seed_val = si.get("seed", si.get("noise_seed"))
        steps_val = si.get("steps")
        cfg_val = si.get("cfg")
        positive_ref = si.get("positive")
        if isinstance(positive_ref, list) and positive_ref:
            pos_id, pos_key = graphs._auto_find_text_node(graph, positive_ref[0])
            if pos_id is not None:
                prompt_text = str((graph[pos_id].get("inputs") or {}).get(pos_key) or "")
        negative_ref = si.get("negative")
        if isinstance(negative_ref, list) and negative_ref:
            neg_id, neg_key = graphs._auto_find_text_node(graph, negative_ref[0])
            if neg_id is not None and neg_id != pos_id:
                negative_text = str((graph[neg_id].get("inputs") or {}).get(neg_key) or "")
    width = height = None
    for node in graph.values():
        inputs = node.get("inputs") if isinstance(node, dict) else {}
        if isinstance(inputs.get("width"), (int, float)) and isinstance(inputs.get("height"), (int, float)):
            width, height = int(inputs["width"]), int(inputs["height"])
            break
    models = []
    loras = []
    for node in graph.values():
        inputs = node.get("inputs") if isinstance(node, dict) else None
        for key, value in (inputs or {}).items():
            if key in ("unet_name", "ckpt_name") and isinstance(value, str) and value:
                models.append(re.sub(r"\.(safetensors|ckpt|gguf)$", "", value, flags=re.IGNORECASE))
            if key == "lora_name" and isinstance(value, str) and value:
                strength = (inputs or {}).get("strength_model", (inputs or {}).get("strength", 1.0))
                loras.append({"name": value, "strength": float(strength) if isinstance(strength, (int, float)) else 1.0})
    seeds = [{"value": int(seed_val), "mode": "fixed"}] if isinstance(seed_val, (int, float)) else []
    return {
        "primaryPrompt": prompt_text,
        "negativePrompt": negative_text,
        "seeds": seeds,
        "seed": int(seed_val) if isinstance(seed_val, (int, float)) else None,
        "steps": int(steps_val) if isinstance(steps_val, (int, float)) else None,
        "cfg": float(cfg_val) if isinstance(cfg_val, (int, float)) else None,
        "width": width,
        "height": height,
        "models": sorted(set(models)),
        "loras": loras,
    }


def _studio_model_id_from_workflow(workflow_stem):
    """Match auto-workflow-discovery.js slugFromFilename → the studio's model id."""
    if not workflow_stem:
        return None
    slug = re.sub(r"[^a-z0-9]+", "-", str(workflow_stem).lower()).strip("-")
    return f"comfy-auto-{slug}" if slug else None


def record_studio_workflow_setup(filenames, graph, prompt_id=None, workflow_stem=None):
    """Vault-seal the FULL setup (prompt, negative, seed, steps, cfg, dims, model,
    LoRAs, + resolved API graph) for a studio (auto-workflow) generation and index
    it by output filename, so 'Load in Studio' restores every exact setting for
    server-generated outputs (which carry no ComfyUI-mobile workflow envelope).
    The setup stays private: sealed to the vault, server can never read it back."""
    names = [util.safe_name(Path(p).name) for p in (filenames or []) if str(p).strip()]
    if not names:
        return
    try:
        payload = _studio_setup_from_graph(graph)
        # The studio model id (comfy-auto-<slug>) so the studio re-selects the
        # exact local model, not just the raw checkpoint name.
        payload["modelId"] = _studio_model_id_from_workflow(workflow_stem)
        # Also carry the resolved API graph so "Load in Canvas" can rebuild the
        # exact node graph client-side. Sealed to the vault (never server-readable).
        payload["apiGraph"] = graph
        envelope = seal_json_to_vault(payload)
        if not envelope:
            return
        recorded_at = util.now_iso()
        rec = {
            "prompt_id": prompt_id or f"studio-{uuid.uuid4().hex[:12]}",
            "filenames": names,
            "workflow": envelope,
            "recorded_at": recorded_at,
            "source": "studio",
        }
        with workflow_index_lock:
            for name in names:
                _workflow_index[name] = envelope
                _workflow_index_records[name] = {"prompt_id": rec["prompt_id"], "lane": "studio", "recorded_at": recorded_at}
            if rec["prompt_id"]:
                _workflow_index_prompts.add(rec["prompt_id"])
            WORKFLOW_INDEX_FILE.parent.mkdir(parents=True, exist_ok=True)
            with WORKFLOW_INDEX_FILE.open("a", encoding="utf-8") as f:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except Exception as e:
        print(f"[workflow-index] studio setup record failed: {e}", file=sys.stderr)
