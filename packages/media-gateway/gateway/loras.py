"""LoRA selection: prompt tokens, strengths, path resolution, and the
encrypted preview/version cache."""
import hashlib
import json
import os
import re
import subprocess
import threading
from pathlib import Path

from gateway import config, graphs, media, models, util


LAST_MOBILE_PROMPT_LORAS_FILE = config.GATEWAY_STATE_DIR / "last_mobile_prompt_loras.json"
LORA_STRENGTH_MIN = -100000.0
LORA_STRENGTH_MAX = 100000.0


LORA_PROMPT_TOKEN_RE = re.compile(r'<lora:([^:>]+):([^>]+)>', re.I)
LORA_MODEL_EXTS = {'.safetensors', '.ckpt', '.pt', '.pth'}


def _scan_lora_tokens(value, out):
    if isinstance(value, str):
        for match in LORA_PROMPT_TOKEN_RE.finditer(value):
            out.append({'name': match.group(1), 'strength': match.group(2)})
    elif isinstance(value, dict):
        for child in value.values():
            _scan_lora_tokens(child, out)
    elif isinstance(value, list):
        for child in value:
            _scan_lora_tokens(child, out)


def _lora_trace_from_prompt_nodes(prompt):
    lora_nodes = []
    lora_tokens = []
    if not isinstance(prompt, dict):
        return lora_nodes, lora_tokens
    for node_id, node in prompt.items():
        if not isinstance(node, dict):
            continue
        class_type = str(node.get('class_type') or '')
        inputs = node.get('inputs') or {}
        if isinstance(inputs, dict):
            _scan_lora_tokens(inputs, lora_tokens)
        has_lora_input = isinstance(inputs, dict) and any('lora' in str(k).lower() for k in inputs.keys())
        if 'lora' in class_type.lower() or has_lora_input:
            redacted_inputs = {}
            if isinstance(inputs, dict):
                for key in ['lora_name', 'strength', 'strength_model', 'strength_clip', 'lora_stack', 'model', 'clip']:
                    if key in inputs:
                        redacted_inputs[key] = inputs.get(key)
            lora_nodes.append({'id': node_id, 'class_type': class_type, 'inputs': redacted_inputs})
    return lora_nodes, lora_tokens


def _prompt_has_lora_semantics(prompt):
    lora_nodes, lora_tokens = _lora_trace_from_prompt_nodes(prompt)
    return bool(lora_nodes or lora_tokens)


def _generation_request_has_loras(data):
    if isinstance(data, dict) and data.get('loras') is not None:
        req_loras = data.get('loras')
        if isinstance(req_loras, list):
            return any(isinstance(item, dict) and str(item.get('id', '')).strip() for item in req_loras)
        return bool(req_loras)
    return bool(models.load_selected_loras())


def _lora_strength(inputs, default=1.0):
    if not isinstance(inputs, dict):
        return default
    for key in ('strength_model', 'strength', 'model_strength'):
        if key in inputs:
            try:
                return float(inputs.get(key))
            except Exception:
                return default
    return default


def _lora_strength_for_input(inputs, input_key, default=1.0):
    if not isinstance(inputs, dict):
        return default
    candidates = ['strength_model', 'strength', 'model_strength']
    key = str(input_key)
    match = re.search(r'(\d+)$', key)
    if match:
        suffix = match.group(1)
        candidates.extend([
            f'strength_{suffix}',
            f'strength_model_{suffix}',
            f'lora_strength_{suffix}',
            f'lora_{suffix}_strength',
        ])
    for candidate in candidates:
        if candidate in inputs:
            try:
                return float(inputs.get(candidate))
            except Exception:
                return default
    return default


def _resolve_lora_path(name):
    value = str(name or '').strip()
    if not value:
        return None
    value = value.replace('\\', '/')
    for prefix in ('models/loras/', 'loras/'):
        if value.lower().startswith(prefix):
            value = value[len(prefix):]
            break
    lora_root = (config.COMFY / 'models' / 'loras').resolve()
    candidates = []
    raw_path = Path(value)
    if raw_path.is_absolute():
        candidates.append(raw_path)
    else:
        candidates.append(lora_root / value)
        if raw_path.suffix == '':
            candidates.extend(lora_root / f"{value}{ext}" for ext in sorted(LORA_MODEL_EXTS))
    for candidate in candidates:
        try:
            resolved = candidate.resolve()
            if resolved.exists() and resolved.is_file() and util._is_under(resolved, lora_root):
                return str(resolved)
        except Exception:
            continue
    try:
        stem_or_name = Path(value).name.lower()
        for p in lora_root.rglob('*'):
            if not p.is_file() or p.suffix.lower() not in LORA_MODEL_EXTS:
                continue
            if p.name.lower() == stem_or_name or p.stem.lower() == stem_or_name:
                return str(p.resolve())
    except Exception:
        pass
    return None


def _dedupe_lora_requests(loras):
    out = []
    seen = set()
    for lora in loras or []:
        path = str(lora.get('filePath') or '').strip()
        if not path:
            continue
        try:
            scale = float(lora.get('scale', 1.0))
        except Exception:
            scale = 1.0
        key = (path, round(scale, 6))
        if key in seen:
            continue
        seen.add(key)
        out.append({'filePath': path, 'scale': scale})
    return out


def _extract_lora_stack_requests(stack):
    found = []
    if isinstance(stack, str):
        value = stack.strip()
        if not value or value[0] not in '[{':
            return found
        try:
            return _extract_lora_stack_requests(json.loads(value))
        except Exception:
            return found
    if isinstance(stack, dict):
        name = stack.get('lora_name') or stack.get('name') or stack.get('lora')
        enabled = stack.get('on', stack.get('active', True))
        enabled_ok = enabled is not False and str(enabled).lower() not in {'false', '0', 'off', 'none'}
        if name and enabled_ok:
            path = _resolve_lora_path(name)
            if path:
                found.append({'filePath': path, 'scale': _lora_strength(stack)})
        for value in stack.values():
            found.extend(_extract_lora_stack_requests(value))
    elif isinstance(stack, list):
        if len(stack) >= 2:
            enabled = stack[0]
            enabled_ok = enabled is not False and str(enabled).lower() not in {'false', '0', 'off', 'none'}
            name = next((item for item in stack if isinstance(item, str) and item.lower().endswith(tuple(LORA_MODEL_EXTS))), None)
            if enabled_ok and name:
                strength = 1.0
                for item in stack:
                    if isinstance(item, (int, float)):
                        strength = float(item)
                        break
                path = _resolve_lora_path(name)
                if path:
                    found.append({'filePath': path, 'scale': strength})
        for value in stack:
            if isinstance(value, (dict, list)):
                found.extend(_extract_lora_stack_requests(value))
    return found


def _native_loras_from_prompt_nodes(prompt):
    loras = []
    unresolved = []
    if not isinstance(prompt, dict):
        return loras, unresolved
    for node in prompt.values():
        if not isinstance(node, dict):
            continue
        class_type = str(node.get('class_type') or '').lower()
        inputs = graphs._node_inputs(node)
        if 'lora' in class_type or any('lora' in str(k).lower() for k in inputs.keys()):
            for key in ('lora_name', 'lora', 'name'):
                if key in inputs and isinstance(inputs.get(key), str):
                    path = _resolve_lora_path(inputs.get(key))
                    if path:
                        loras.append({'filePath': path, 'scale': _lora_strength(inputs)})
                    else:
                        unresolved.append(str(inputs.get(key)))
            for key, value in inputs.items():
                if 'lora' not in str(key).lower():
                    continue
                if isinstance(value, str):
                    path = _resolve_lora_path(value)
                    if path:
                        loras.append({'filePath': path, 'scale': _lora_strength_for_input(inputs, key)})
                elif isinstance(value, (dict, list)):
                    loras.extend(_extract_lora_stack_requests(value))
            if 'lora_stack' in inputs:
                loras.extend(_extract_lora_stack_requests(inputs.get('lora_stack')))
    _, tokens = _lora_trace_from_prompt_nodes(prompt)
    for token in tokens:
        path = _resolve_lora_path(token.get('name'))
        if path:
            try:
                scale = float(token.get('strength', 1.0))
            except Exception:
                scale = 1.0
            loras.append({'filePath': path, 'scale': scale})
        else:
            unresolved.append(str(token.get('name') or ''))
    return _dedupe_lora_requests(loras), [x for x in unresolved if x]


def _native_loras_from_generation_request(data, base_models=None):
    if isinstance(data, dict) and data.get('loras') is not None:
        selected = models.resolve_lora_selection(data.get('loras') or [], base_models)
    else:
        selected = models.load_selected_loras()
        if base_models:
            selected = [item for item in selected if models.lora_base_matches(item.get('baseModel'), base_models)]
    loras = []
    for item in selected:
        try:
            path = str(Path(item.get('path')).resolve())
        except Exception:
            path = item.get('path')
        loras.append({'filePath': path, 'scale': item.get('strength', 1.0)})
    return _dedupe_lora_requests(loras)


def _strip_lora_prompt_tokens(text):
    return re.sub(r'\s+', ' ', LORA_PROMPT_TOKEN_RE.sub('', str(text or ''))).strip()


def record_mobile_prompt_lora_trace(body):
    """Persist redacted LoRA-only diagnostics for the last proxied Mobile prompt.

    This intentionally does not store prompt text or the full API graph. It keeps
    only class_type, node id, lora filenames, strengths, and <lora:name:...>
    tokens found in string fields.
    """
    try:
        data = json.loads(body.decode('utf-8', errors='replace') if isinstance(body, (bytes, bytearray)) else body)
        prompt = data.get('prompt') if isinstance(data, dict) else None
        if not isinstance(prompt, dict):
            return
        lora_nodes, lora_tokens = _lora_trace_from_prompt_nodes(prompt)
        LAST_MOBILE_PROMPT_LORAS_FILE.write_text(json.dumps({
            'at': util.now_iso(),
            'lora_nodes': lora_nodes,
            'lora_tokens': lora_tokens,
        }, indent=2), encoding='utf-8')
    except Exception as e:
        try:
            LAST_MOBILE_PROMPT_LORAS_FILE.write_text(json.dumps({'at': util.now_iso(), 'error': str(e)}, indent=2), encoding='utf-8')
        except Exception:
            pass


# ── LoRA data cache (encrypted at rest) ─────────────────────────────────────────
# Card previews and Civitai version lists are the only LoRA data that comes from the
# internet, and both used to be re-fetched constantly: the preview route pulled every
# remote image on every request, and the version list lived in memory alone, so a
# gateway restart re-asked Civitai about every installed LoRA.
#
# On disk entries are AES-256-CBC with the same machine key the outputs use, under
# hashed filenames — a LoRA collection is as private as the images it makes, so the
# cache must not name what is installed. In memory they stay plaintext (bounded) so
# repeat reads skip the key derivation entirely.
#
# Preview entries are keyed by the installed file's IDENTITY (id + size + mtime), so
# an updated or replaced LoRA can never serve its predecessor's image, and entries
# for LoRAs that are gone are pruned the next time the catalog is read.
LORA_CACHE_DIR = config.GATEWAY_STATE_DIR / "lora-cache"
LORA_PREVIEW_CACHE_DIR = LORA_CACHE_DIR / "previews"
LORA_VERSION_CACHE_DIR = LORA_CACHE_DIR / "versions"
LORA_CACHE_MEMORY_LIMIT = int(os.environ.get("ZIMG_LORA_CACHE_MEMORY_BYTES", str(32 * 1024 * 1024)))
LORA_CACHE_PASS_ENV = "HIVEMIND_LORA_CACHE_PASS"
_lora_cache_memory = {}
_lora_cache_memory_bytes = 0
_lora_cache_lock = threading.Lock()


def _lora_cache_recall(key):
    with _lora_cache_lock:
        return _lora_cache_memory.get(key)


def _lora_cache_remember(key, payload):
    global _lora_cache_memory_bytes
    if len(payload) > LORA_CACHE_MEMORY_LIMIT:
        return
    with _lora_cache_lock:
        if key in _lora_cache_memory:
            return
        while _lora_cache_memory and _lora_cache_memory_bytes + len(payload) > LORA_CACHE_MEMORY_LIMIT:
            evicted = next(iter(_lora_cache_memory))
            _lora_cache_memory_bytes -= len(_lora_cache_memory.pop(evicted))
        _lora_cache_memory[key] = payload
        _lora_cache_memory_bytes += len(payload)


def _lora_cache_forget(key):
    global _lora_cache_memory_bytes
    with _lora_cache_lock:
        payload = _lora_cache_memory.pop(key, None)
        if payload is not None:
            _lora_cache_memory_bytes -= len(payload)


def _lora_cache_openssl(args, payload):
    """Run openssl with the machine key in the CHILD ENV rather than on stdin.

    The output encryption passes its password on stdin, which works because it
    encrypts file-to-file. Cache entries are in-memory bytes, and staging them
    through a plaintext temp file would defeat the point of encrypting them, so the
    payload takes stdin and the password rides in the (short-lived) child's env.
    """
    password = media.output_encryption_password(create=True)
    if not password:
        return None
    env = dict(os.environ)
    env[LORA_CACHE_PASS_ENV] = password
    try:
        proc = subprocess.run(
            ["/usr/bin/openssl", "enc", *args, "-aes-256-cbc", "-pbkdf2",
             "-iter", str(media.OUTPUT_ENCRYPTION_ITER), "-pass", f"env:{LORA_CACHE_PASS_ENV}"],
            input=payload, capture_output=True, env=env, timeout=60,
        )
    except Exception:
        return None
    if proc.returncode != 0 or not proc.stdout:
        return None
    return proc.stdout


def lora_cache_store(path, payload):
    sealed = _lora_cache_openssl(["-salt"], payload)
    if not sealed:
        return False
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
        tmp.write_bytes(sealed)
        os.replace(tmp, path)
        return True
    except Exception:
        return False


def lora_cache_load(path):
    try:
        if not path.is_file():
            return None
        sealed = path.read_bytes()
    except Exception:
        return None
    return _lora_cache_openssl(["-d"], sealed)


def lora_cache_key(item, extra=""):
    """Cache identity for an installed LoRA: change the file, change the key."""
    try:
        stat = Path(item.get("path") or "").stat()
        identity = f"{item.get('id')}|{stat.st_size}|{stat.st_mtime_ns}|{extra}"
    except OSError:
        return ""
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()[:32]


def lora_preview_cache_path(key):
    return LORA_PREVIEW_CACHE_DIR / f"{key}.enc"


def cached_lora_preview(item, source):
    """(bytes, content_type) for a remote preview already fetched, else None."""
    key = lora_cache_key(item, source)
    if not key:
        return None
    payload = _lora_cache_recall(key)
    if payload is None:
        payload = lora_cache_load(lora_preview_cache_path(key))
        if payload is None:
            return None
        _lora_cache_remember(key, payload)
    content_type, _, data = payload.partition(b"\n")
    if not data:
        return None
    return data, content_type.decode("utf-8", "replace") or "image/jpeg"


def cache_lora_preview(item, source, data, content_type):
    key = lora_cache_key(item, source)
    if not key or not data:
        return
    payload = f"{content_type or 'image/jpeg'}\n".encode("utf-8") + data
    _lora_cache_remember(key, payload)
    lora_cache_store(lora_preview_cache_path(key), payload)


def prune_lora_caches(items):
    """Drop cached data for LoRAs that were deleted, replaced, or updated.

    A replaced file changes its own preview key, so this both removes the orphan and
    guarantees the next read refetches. Version lists belong to a Civitai model, not
    to a file, so they survive an update and are dropped only when nothing installed
    refers to that model any more.
    """
    previews, versions = set(), set()
    for item in items or []:
        source = models.lora_preview_source(item.get("path"), item.get("metadata") or {})
        if str(source).startswith(("http://", "https://")):
            key = lora_cache_key(item, source)
            if key:
                previews.add(f"{key}.enc")
        model_id = models.compact_lora_record(item).get("modelId")
        if model_id:
            versions.add(models.lora_version_cache_path(model_id).name)
    for directory, keep in ((LORA_PREVIEW_CACHE_DIR, previews), (LORA_VERSION_CACHE_DIR, versions)):
        try:
            stale = [p for p in directory.glob("*.enc") if p.name not in keep]
        except Exception:
            continue
        for path in stale:
            try:
                path.unlink()
            except OSError:
                continue
            _lora_cache_forget(path.stem)
