"""The model library: Civitai search and download, installed-model scanning,
bundles and what is equipped."""
import hashlib
import json
import os
import re
import subprocess
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlparse, urlencode
from urllib.request import Request
from urllib.error import HTTPError, URLError

from gateway import config, history, loras as _loras, net, util


EQUIPPED_FILE = config.GATEWAY_STATE_DIR / "equipped_models.json"
SELECTED_LORAS_FILE = config.GATEWAY_STATE_DIR / "selected_loras.json"
CIVITAI_TOKEN_FILE = Path(
    os.environ.get("CIVITAI_TOKEN_FILE", str(config.MEDIA_STATE_ROOT / "secure/civitai-token"))
).expanduser().resolve()
CIVITAI_TOKEN_ENV_KEYS = (
    'CIVITAI_TOKEN',
    'CIVITAI_API_TOKEN',
    'CIVITAI_API_KEY',
    'CIVITAI_KEY',
    'CIVITAI_ACCESS_TOKEN',
    'CIVITAI_BEARER_TOKEN',
    'CIVITAI_PAT',
)
CIVITAI_API = "https://civitai.com/api/v1"
CIVITAI_BASE_MODELS_CACHE = {'at': 0, 'items': None}
CIVITAI_BASE_MODELS_TTL = 6 * 60 * 60
# modelId -> {'at': ts, 'versions': [{'id', 'name', 'baseModel'}]} for update checks.
CIVITAI_MODEL_VERSIONS_CACHE = {}
CIVITAI_MODEL_VERSIONS_TTL = 6 * 60 * 60
CIVITAI_FALLBACK_BASE_MODELS = [
    'ZImageTurbo', 'Z-Image Turbo', 'Z Image',
    'SD 1.5', 'SD 1.4', 'SD 2.0', 'SD 2.1', 'SDXL 1.0', 'SDXL Turbo', 'SDXL Lightning',
    'Pony', 'Illustrious', 'NoobAI', 'Animagine XL', 'Playground v2', 'PixArt a', 'AuraFlow',
    'Flux.1 D', 'Flux.1 Dev', 'Flux.1 Schnell', 'Flux.1 Kontext', 'Flux',
    'Stable Cascade', 'Stable Diffusion 3', 'Stable Diffusion 3.5', 'Stable Diffusion 3.5 Large', 'Stable Diffusion 3.5 Medium',
    'HiDream', 'Lumina', 'HunyuanDiT', 'Kolors', 'Kwai-Kolors', 'Chroma', 'OmniGen',
    'Wan Video', 'Wan Video 1.3B t2v', 'Wan Video 14B t2v', 'Wan Video 14B i2v',
    'Hunyuan Video', 'LTXV', 'Mochi', 'CogVideoX', 'SVD', 'AnimateDiff', 'Allegro',
    'OpenSora', 'SkyReels', 'Qwen-Image', 'Qwen-Image-Edit', 'Hidream-I1',
]


def comfy_combo_options(entry):
    """The choices in a node's combo input, whichever schema it uses.

    V1 nodes put the list in element 0; V3 nodes put the literal string 'COMBO'
    there and move the choices into element 1's 'options'. Reading only element
    0 silently yields nothing for V3 nodes, which reads as "the model is not
    installed" when it is sitting right there on disk.
    """
    if not isinstance(entry, (list, tuple)) or not entry:
        return []
    if isinstance(entry[0], list):
        return entry[0]
    if len(entry) > 1 and isinstance(entry[1], dict):
        options = entry[1].get("options")
        if isinstance(options, list):
            return options
    return []


def comfy_model_catalog():
    """What ComfyUI is actually offering, per model folder.

    Read from a loader node's combo options rather than the filesystem, because
    that is the exact list the graph's names have to match — a file present on
    disk but not in the list (wrong folder, not yet rescanned) would otherwise
    look installed and then fail at validation.
    """
    sources = {
        "checkpoints": ("CheckpointLoaderSimple", "ckpt_name"),
        "loras": ("LoraLoaderModelOnly", "lora_name"),
        "text_encoders": ("LTXAVTextEncoderLoader", "text_encoder"),
        "latent_upscale_models": ("LatentUpscaleModelLoader", "model_name"),
    }
    catalog = {}
    for folder, (class_type, field) in sources.items():
        names = []
        try:
            payload = net.urlopen(f"{config.COMFY_HTTP_DEFAULT}/object_info/{class_type}", timeout=10).read()
            spec = json.loads(payload.decode("utf-8")).get(class_type) or {}
            entry = spec.get("input", {}).get("required", {}).get(field) or []
            names = [str(n) for n in comfy_combo_options(entry)]
        except Exception:
            names = []
        catalog[folder] = names
    return catalog



def civitai_token(token_override=None):
    if token_override:
        return str(token_override).strip()
    for key in CIVITAI_TOKEN_ENV_KEYS:
        env = os.environ.get(key)
        if env:
            return env.strip()
    for p in [CIVITAI_TOKEN_FILE]:
        if p.exists():
            tok = p.read_text().strip()
            if tok:
                return tok
    return ''


def civitai_token_status():
    sources = []
    for key in CIVITAI_TOKEN_ENV_KEYS:
        if os.environ.get(key):
            sources.append({'type': 'env', 'name': key, 'set': True})
    sources.append({'type': 'file', 'path': str(CIVITAI_TOKEN_FILE), 'set': CIVITAI_TOKEN_FILE.exists() and bool(CIVITAI_TOKEN_FILE.read_text().strip())})
    return {'configured': bool(civitai_token()), 'sources': sources}


def civitai_headers(token_override=None):
    headers = {'User-Agent': 'Hermes-ZImage-ComfyUI/1.0'}
    tok = civitai_token(token_override)
    if tok:
        headers['Authorization'] = f'Bearer {tok}'
    return headers


def civitai_download_headers():
    # Do not use Authorization for /api/download/models. Civitai redirects to a
    # signed R2/S3 URL, and urllib preserves the Authorization header across the
    # redirect; R2 then treats it as AWS auth and returns 400
    # "Missing x-amz-content-sha256". Put the token in the Civitai URL query
    # instead, then follow the redirect with only normal browser-ish headers.
    return {'User-Agent': 'Hermes-ZImage-ComfyUI/1.0'}


def civitai_download_url(url, token_override=None):
    tok = civitai_token(token_override)
    if not tok:
        return url
    parsed = urlparse(str(url))
    host = (parsed.netloc or '').lower()
    if host.startswith('www.'):
        host = host[4:]
    if host not in {'civitai.com', 'civitai.red'} or not re.search(r'/api/download/models/\d+', parsed.path):
        return url
    qs = parse_qs(parsed.query, keep_blank_values=True)
    if not qs.get('token'):
        qs['token'] = [tok]
    query = urlencode(qs, doseq=True)
    return parsed._replace(query=query).geturl()


def civitai_json(path, params=None, token_override=None, retries=0):
    """One Civitai API call.

    `retries` is opt-in and defaults to off, so the download and update paths
    behave exactly as before. The images feed passes a budget because Civitai's
    /images endpoint returns a transient 503 often enough to matter — measured
    2026-08-28 at roughly one call in three, on requests that succeed
    unchanged a second later.
    """
    query = urlencode({k: v for k, v in (params or {}).items() if v not in (None, '', [])}, doseq=True)
    url = CIVITAI_API + path + (('?' + query) if query else '')
    attempt = 0
    while True:
        try:
            req = Request(url, headers=civitai_headers(token_override))
            with net.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode('utf-8'))
        except HTTPError as e:
            # Only the upstream-is-busy family is worth repeating; a 401 or a
            # 404 means the same thing however many times it is asked.
            if attempt >= retries or e.code not in (429, 500, 502, 503, 504):
                raise
        except (URLError, TimeoutError):
            if attempt >= retries:
                raise
        attempt += 1
        time.sleep(min(2 ** attempt * 0.4, 3.0))


def civitai_search_models(params):
    """Fetch Civitai search results, following cursors until requested limit.

    Civitai's /models endpoint is paginated. The UI's "limit" is treated as the
    desired total count, not just the first API page size, so searches don't look
    artificially truncated.
    """
    clean = {k: v for k, v in (params or {}).items() if v not in (None, '', [])}
    try:
        requested = max(1, min(300, int(clean.get('limit') or 40)))
    except Exception:
        requested = 40
    per_page = min(100, requested)
    clean['limit'] = str(per_page)
    items = []
    metadata = {}
    cursor = clean.get('cursor')
    pages = 0
    while len(items) < requested and pages < 8:
        if cursor:
            clean['cursor'] = cursor
        data = civitai_json('/models', clean)
        pages += 1
        batch = data.get('items') or []
        items.extend(batch)
        metadata = data.get('metadata') or {}
        cursor = metadata.get('nextCursor') or None
        if not cursor or not batch:
            break
    return {'items': items[:requested], 'metadata': {**metadata, 'pagesFetched': pages, 'requestedLimit': requested, 'returned': min(len(items), requested)}}


# --- Civitai inspiration feed (images + videos with usable prompts) ---------
# Distinct from civitai_search_models above: that browses MODELS to install,
# this browses what people MADE with them, for the prompt attached.
#
# The whole feature rests on a prompt actually being there, and Civitai's API
# does not guarantee one. `withMeta=true` INCLUDES the meta object; it does not
# filter by it, so a raw page is roughly half unusable (measured 2026-08-28:
# 100 raw -> 37 image / 49 video items with a usable prompt). Two consequences,
# both handled here rather than in the UI:
#   * the caller's limit is a target to fill, so cursors are followed like
#     civitai_search_models does, and
#   * "has a prompt" has to mean more than "the key exists" — see below.

# Prompts that are present but carry nothing to reuse. Seen in the wild: a bare
# link back to another Civitai image as the entire "prompt", and settings notes
# ("turbo lora strength 1.75, 3/7 steps + VFI") parked in negativePrompt.
_CIVITAI_URL_ONLY = re.compile(r'^\s*https?://\S+\s*$', re.I)
CIVITAI_MIN_PROMPT_CHARS = 12


def civitai_image_prompt(item):
    """The reusable prompt on an image, or '' when there is nothing to load."""
    prompt = str(((item.get('meta') or {}).get('prompt') or '')).strip()
    if len(prompt) < CIVITAI_MIN_PROMPT_CHARS:
        return ''
    if _CIVITAI_URL_ONLY.match(prompt):
        return ''
    return prompt


def civitai_search_images(params):
    """Civitai images/videos that carry a usable prompt, filling `limit`.

    Same cursor-following shape as civitai_search_models, with the filter
    applied per page: the caller asks for 24 usable results, not 24 rows of
    which a random half are blank.
    """
    clean = {k: v for k, v in (params or {}).items() if v not in (None, '', [])}
    try:
        requested = max(1, min(200, int(clean.get('limit') or 24)))
    except Exception:
        requested = 24
    # Over-fetch: at the measured ~40% yield, asking for exactly `requested`
    # would spend a page per handful. 100 is Civitai's own per-page ceiling.
    clean['limit'] = str(min(100, max(requested * 2, 50)))
    clean['withMeta'] = 'true'
    items = []
    metadata = {}
    cursor = clean.get('cursor')
    pages = 0
    scanned = 0
    while len(items) < requested and pages < 6:
        if cursor:
            clean['cursor'] = cursor
        data = civitai_json('/images', clean, retries=3)
        pages += 1
        batch = data.get('items') or []
        scanned += len(batch)
        items.extend(i for i in batch if civitai_image_prompt(i))
        metadata = data.get('metadata') or {}
        cursor = metadata.get('nextCursor') or None
        if not cursor or not batch:
            break
    return {
        'items': items[:requested],
        # nextCursor is what the NEXT "Load more" resumes from, so it has to be
        # the cursor past the last page actually read — not the one that came
        # back with the page the last kept item happened to be on.
        'metadata': {
            **metadata,
            'pagesFetched': pages,
            'scanned': scanned,
            'requestedLimit': requested,
            'returned': min(len(items), requested),
        },
    }


def civitai_image_media_urls(item):
    """(display url, poster url) for a result card.

    image.civitai.com takes transforms as a PATH segment, so the stored
    `original=true` becomes `width=<n>`. On a video that yields a smaller
    TRANSCODED mp4 rather than a still (confirmed 2026-08-28), which is what the
    card wants anyway — it plays on hover, exactly like the model browser's.
    """
    url = str(item.get('url') or '')
    if not url:
        return '', ''
    card = re.sub(r'/original=true/', '/width=450/', url, count=1)
    return url, (card if card != url else url)


def summarize_civitai_image(item):
    """One inspiration card. Only the fields the finder and the studio hand-off
    read — the raw payload carries reaction breakdowns and moderation flags that
    have no business crossing the bridge."""
    meta = item.get('meta') or {}
    full, card = civitai_image_media_urls(item)
    # Civitai records the canvas as "832x1216"; the studios want the two numbers.
    width = item.get('width')
    height = item.get('height')
    size = str(meta.get('Size') or meta.get('size') or '')
    if (not width or not height) and re.fullmatch(r'\d+x\d+', size):
        width, height = (int(part) for part in size.split('x'))
    resources = []
    for entry in (meta.get('civitaiResources') or [])[:12]:
        if not isinstance(entry, dict):
            continue
        resources.append({
            'type': entry.get('type'),
            'weight': entry.get('weight'),
            'modelVersionId': entry.get('modelVersionId'),
            'modelVersionName': entry.get('modelVersionName'),
        })
    return {
        'id': item.get('id'),
        'url': full,
        'cardUrl': card,
        'kind': 'video' if str(item.get('type') or '').lower() == 'video' else 'image',
        'width': width,
        'height': height,
        'baseModel': item.get('baseModel') or '',
        'username': item.get('username') or '',
        'postId': item.get('postId'),
        'nsfw': bool(item.get('nsfw')),
        'nsfwLevel': item.get('nsfwLevel') or '',
        'createdAt': item.get('createdAt'),
        'stats': item.get('stats') or {},
        'pageUrl': f"https://civitai.com/images/{item.get('id')}" if item.get('id') else '',
        'prompt': civitai_image_prompt(item),
        'negativePrompt': str(meta.get('negativePrompt') or '').strip(),
        'sampler': meta.get('sampler') or meta.get('Sampler') or '',
        'scheduler': meta.get('Schedule type') or meta.get('scheduler') or '',
        'steps': meta.get('steps') or meta.get('Steps'),
        'cfgScale': meta.get('cfgScale') or meta.get('CFG scale'),
        'seed': meta.get('seed') or meta.get('Seed'),
        'clipSkip': meta.get('clipSkip') or meta.get('Clip skip'),
        'modelName': meta.get('Model') or '',
        'resources': resources,
        'modelVersionIds': item.get('modelVersionIds') or [],
    }


def resolve_civitai_url(value):
    """Resolve civitai.com or civitai.red URLs to a modelVersionId/fileId."""
    raw = str(value or '').strip()
    if not raw:
        raise RuntimeError('Civitai URL required')
    parsed = urlparse(raw)
    host = (parsed.netloc or '').lower()
    if host.startswith('www.'):
        host = host[4:]
    if host not in {'civitai.com', 'civitai.red'}:
        raise RuntimeError('URL must be from civitai.com or civitai.red')
    qs = parse_qs(parsed.query)
    version_id = (qs.get('modelVersionId') or qs.get('versionId') or qs.get('modelVersion') or [None])[0]
    file_id = (qs.get('fileId') or qs.get('modelFileId') or [None])[0]

    m = re.search(r'/api/download/models/(\d+)', parsed.path)
    if m:
        version_id = version_id or m.group(1)

    if version_id:
        version = civitai_json(f'/model-versions/{int(version_id)}')
        return {'versionId': str(version.get('id') or version_id), 'fileId': str(file_id or ''), 'version': version}

    m = re.search(r'/models/(\d+)', parsed.path)
    if not m:
        raise RuntimeError('Could not find a model or model version id in that Civitai URL')
    model_id = m.group(1)
    model = civitai_json(f'/models/{int(model_id)}')
    versions = model.get('modelVersions') or []
    if not versions:
        raise RuntimeError('No model versions found for that Civitai model URL')
    version = versions[0]
    return {'versionId': str(version.get('id')), 'fileId': str(file_id or ''), 'model': model, 'version': version}


def civitai_version_display_name(version):
    """Human label for a resolved version — lets a caller name a download in flight."""
    model_name = str(((version or {}).get('model') or {}).get('name') or '').strip()
    version_name = str((version or {}).get('name') or '').strip()
    if model_name and version_name and version_name.lower() not in model_name.lower():
        return f'{model_name} · {version_name}'
    return model_name or version_name


def validate_civitai_expected_type(version, expected_type=None):
    expected = str(expected_type or '').strip().lower()
    if not expected:
        return
    actual = str((version.get('model') or {}).get('type') or '').strip()
    normalized_actual = actual.lower().replace(' ', '')
    if expected == 'lora' and not any(token in normalized_actual for token in ('lora', 'locon', 'lycoris')):
        raise RuntimeError(f'Expected a Civitai LoRA URL, but the selected model type is {actual or "unknown"}')


def comfy_dir_for_civitai(model_type, file_name=''):
    mt = (model_type or '').lower().replace(' ', '')
    name = (file_name or '').lower()
    if 'lora' in mt or 'lycoris' in mt:
        return config.COMFY / 'models' / 'loras'
    if 'checkpoint' in mt:
        return config.COMFY / 'models' / 'checkpoints'
    if 'textualinversion' in mt or 'embedding' in mt:
        return config.COMFY / 'models' / 'embeddings'
    if mt == 'vae' or 'vae' in name:
        return config.COMFY / 'models' / 'vae'
    if 'controlnet' in mt or 'control' in mt:
        return config.COMFY / 'models' / 'controlnet'
    if 'upscaler' in mt or 'upscale' in mt or 'esrgan' in name:
        return config.COMFY / 'models' / 'upscale_models'
    if 'motion' in mt or 'animatediff' in mt:
        return config.COMFY / 'models' / 'animatediff_models'
    if 'clip' in mt or 'textencoder' in mt:
        return config.COMFY / 'models' / 'text_encoders'
    return config.COMFY / 'models' / util.safe_name(model_type or 'civitai')


def current_base_models():
    equipped = load_equipped()
    ids = {m.get('id','').lower() for m in equipped}
    names = ' '.join([m.get('name','') for m in equipped]).lower()
    vals = []
    if 'z_image' in names or 'z-image' in names or 'zimage' in names or any(('z_image' in x or 'zimage' in x) for x in ids):
        # Civitai's current canonical base-model filter for Z-Image Turbo LoRAs
        # is "ZImageTurbo". The human-facing spelling "Z-Image" only returns
        # a tiny older slice of results.
        vals += ['ZImageTurbo']
    if 'flux' in names:
        vals += ['Flux.1 D', 'Flux.1 Dev', 'Flux.1 Schnell', 'Flux']
    if 'sd_xl' in names or 'sdxl' in names or 'illustrious' in names:
        vals += ['SDXL 1.0', 'Illustrious', 'Pony']
    if 'sd15' in names or 'v1-5' in names or '1.5' in names:
        vals += ['SD 1.5']
    if not vals:
        vals = ['ZImageTurbo']
    # Civitai uses inconsistent spellings for this base in different places.
    # Keep the canonical display/API value first, but do not show near-duplicate
    # aliases like "Z Image" in the UI.
    seen=[]
    seen_norm=set()
    for v in vals:
        n = normalize_base(v)
        if n not in seen_norm:
            seen.append(v)
            seen_norm.add(n)
    return seen


def normalize_base(v):
    return re.sub(r'[^a-z0-9]+', '', str(v or '').lower())


def civitai_base_model_options(force=False):
    """Return richer Civitai base-model filter options.

    Civitai's public REST API does not provide a stable simple base-model list.
    We keep a broad fallback list and opportunistically harvest live baseModel
    values from top /models pages so new values appear without frontend edits.
    """
    import time
    now = time.time()
    cached = CIVITAI_BASE_MODELS_CACHE.get('items')
    if cached and not force and now - float(CIVITAI_BASE_MODELS_CACHE.get('at') or 0) < CIVITAI_BASE_MODELS_TTL:
        return cached

    values = []
    values.extend(current_base_models())
    values.extend(CIVITAI_FALLBACK_BASE_MODELS)
    try:
        # Sample popular/new models by type and collect version.baseModel strings.
        # Keep this bounded so the UI does not wait on a huge scrape.
        for model_type in ['LORA', 'Checkpoint', 'TextualInversion', 'Controlnet', 'VAE', 'Poses']:
            data = civitai_json('/models', {
                'types': model_type,
                'sort': 'Most Downloaded',
                'period': 'AllTime',
                'limit': '100',
                'primaryFileOnly': 'true',
            })
            for item in data.get('items') or []:
                for version in item.get('modelVersions') or []:
                    if version.get('baseModel'):
                        values.append(str(version.get('baseModel')))
    except Exception:
        # Cloudflare/rate limits/auth hiccups should not break the UI.
        pass

    seen = set()
    out = []
    preferred = {normalize_base(x): i for i, x in enumerate(current_base_models())}
    for raw in values:
        val = str(raw or '').strip()
        if not val:
            continue
        key = normalize_base(val)
        if key in seen:
            continue
        seen.add(key)
        out.append(val)
    out.sort(key=lambda x: (preferred.get(normalize_base(x), 999), x.lower()))
    CIVITAI_BASE_MODELS_CACHE.update({'at': now, 'items': out})
    return out


def compatible_base(base):
    return lora_base_matches(base, current_base_models())


def lora_base_matches(base, base_models):
    cur = {normalize_base(x) for x in (base_models or []) if normalize_base(x)}
    b = normalize_base(base)
    if not b or not cur:
        return False
    return b in cur or any(b.startswith(x) or x.startswith(b) for x in cur)


def lora_sidecar(path):
    return Path(str(path) + '.civitai.json')


def local_loras():
    root = config.COMFY / 'models' / 'loras'
    out=[]
    if not root.exists():
        return out
    for p in root.rglob('*'):
        if not p.is_file() or p.suffix.lower() not in {'.safetensors','.ckpt','.pt','.pth'}:
            continue
        meta = read_model_metadata(p)
        base = meta.get('baseModel') or meta.get('base_model') or meta.get('modelVersion',{}).get('baseModel') or ''
        if not base or not compatible_base(base):
            continue
        rel = str(p.relative_to(root))
        out.append({'id': rel, 'name': p.name, 'path': str(p), 'baseModel': base or 'Unknown/local', 'metadata': meta, 'selected': False, 'strength': 1.0})
    selected = {x.get('id'): x for x in load_selected_loras()}
    for lora in out:
        if lora['id'] in selected:
            lora['selected'] = True
            lora['strength'] = float(selected[lora['id']].get('strength', 1.0))
    out.sort(key=lambda x: (not x['selected'], x['name'].lower()))
    return out


def load_selected_loras():
    if not SELECTED_LORAS_FILE.exists():
        return []
    try:
        items = json.loads(SELECTED_LORAS_FILE.read_text())
    except Exception:
        return []
    valid = {lora['id']: lora for lora in local_loras_unfiltered()}
    out=[]
    for item in items:
        lid = item.get('id')
        if lid in valid and compatible_base(valid[lid].get('baseModel')):
            out.append({'id': lid, 'name': valid[lid]['name'], 'strength': float(item.get('strength', 1.0)), 'path': valid[lid]['path'], 'baseModel': valid[lid].get('baseModel','')})
    return out


def local_loras_unfiltered():
    root = config.COMFY / 'models' / 'loras'
    out=[]
    if not root.exists():
        return out
    for p in root.rglob('*'):
        if not p.is_file() or p.suffix.lower() not in {'.safetensors','.ckpt','.pt','.pth'}:
            continue
        meta = read_model_metadata(p)
        base = meta.get('baseModel') or meta.get('base_model') or meta.get('modelVersion',{}).get('baseModel') or ''
        out.append({'id': str(p.relative_to(root)), 'name': p.name, 'path': str(p), 'baseModel': base, 'metadata': meta})
    return out


def lora_preview_source(path, meta):
    """Return a local image path or remote image URL for a LoRA card."""
    model_path = Path(path)
    candidates = []
    for key in ['preview_url', 'previewUrl', 'image', 'thumbnail']:
        if meta.get(key):
            candidates.append(str(meta.get(key)))
    for ext in ['.preview.png', '.preview.jpg', '.preview.jpeg', '.png', '.jpg', '.jpeg', '.webp']:
        candidates.append(str(model_path.with_suffix(ext)))
    for candidate in candidates:
        if candidate.startswith(('http://', 'https://')):
            return candidate
        preview_path = Path(candidate)
        if not preview_path.is_absolute():
            preview_path = model_path.parent / preview_path
        if preview_path.exists() and preview_path.is_file():
            return str(preview_path.resolve())

    image_groups = [
        (meta.get('civitai') or {}).get('images') or [],
        meta.get('images') or [],
        (meta.get('modelVersion') or {}).get('images') or [],
    ]
    for images in image_groups:
        for image in images:
            if not isinstance(image, dict) or not image.get('url'):
                continue
            if str(image.get('type') or 'image').lower() == 'video':
                continue
            return str(image['url'])
    return ''


def compact_lora_record(item):
    meta = item.get('metadata') if isinstance(item.get('metadata'), dict) else {}
    version = meta.get('modelVersion') if isinstance(meta.get('modelVersion'), dict) else {}
    model = version.get('model') if isinstance(version.get('model'), dict) else {}
    display_name = str(
        model.get('name')
        or meta.get('displayName')
        or meta.get('name')
        or Path(item.get('name') or item.get('id') or 'LoRA').stem
    ).strip()
    trigger_words = version.get('trainedWords') or meta.get('trainedWords') or meta.get('triggerWords') or []
    if isinstance(trigger_words, str):
        trigger_words = [value.strip() for value in re.split(r'[,\n]', trigger_words) if value.strip()]
    trigger_words = [str(value).strip() for value in trigger_words if str(value).strip()][:8]
    return {
        'id': item['id'],
        'name': item['name'],
        'displayName': display_name,
        'baseModel': item.get('baseModel') or 'Unknown/local',
        'triggerWords': trigger_words,
        'hasPreview': bool(lora_preview_source(item['path'], meta)),
        'defaultWeight': 1.0,
        # Version identity from the Civitai sidecar: what a card labels itself with
        # and what an update check compares against. Empty for hand-placed files.
        'versionId': str(version.get('id') or ''),
        'versionName': str(version.get('name') or '').strip(),
        # Civitai's /model-versions payload nests `model` WITHOUT an id and carries
        # the model id on the version itself, so real sidecars only have modelId.
        'modelId': str(version.get('modelId') or model.get('id') or ''),
    }


def lora_version_cache_path(model_id):
    name = hashlib.sha256(f"model:{model_id}".encode("utf-8")).hexdigest()[:32]
    return _loras.LORA_VERSION_CACHE_DIR / f"{name}.enc"


def cached_model_versions(model_id):
    payload = _loras.lora_cache_load(lora_version_cache_path(model_id))
    if not payload:
        return None
    try:
        record = json.loads(payload.decode("utf-8"))
    except Exception:
        return None
    return record if isinstance(record, dict) and isinstance(record.get("versions"), list) else None


def cache_model_versions(model_id, record):
    try:
        _loras.lora_cache_store(lora_version_cache_path(model_id), json.dumps(record).encode("utf-8"))
    except Exception:
        pass


def civitai_model_versions(model_id, force=False):
    """Version list for a Civitai model id, cached — update checks are chatty otherwise."""
    import time
    key = str(model_id)
    now = time.time()
    cached = CIVITAI_MODEL_VERSIONS_CACHE.get(key)
    if cached and not force and now - float(cached.get('at') or 0) < CIVITAI_MODEL_VERSIONS_TTL:
        return cached.get('versions') or []
    if not force:
        # Encrypted on disk, so a gateway restart does not re-ask Civitai about
        # every installed LoRA just to redraw the same update badges.
        stored = cached_model_versions(key)
        if stored and now - float(stored.get('at') or 0) < CIVITAI_MODEL_VERSIONS_TTL:
            CIVITAI_MODEL_VERSIONS_CACHE[key] = stored
            return stored.get('versions') or []
    model = civitai_json(f'/models/{int(model_id)}')
    versions = [
        {'id': str(v.get('id') or ''), 'name': str(v.get('name') or ''), 'baseModel': str(v.get('baseModel') or '')}
        for v in (model.get('modelVersions') or [])
        if v.get('id')
    ]
    record = {'at': now, 'versions': versions}
    CIVITAI_MODEL_VERSIONS_CACHE[key] = record
    cache_model_versions(key, record)
    return versions


_VERSION_TOKEN = re.compile(r'^v?\d+(?:[._-]\d+)*[a-z]?$')


def _version_label_tokens(name):
    """Words of a version name with the version numbers removed.

    "Soft Enhance" -> {soft, enhance}; "Krea 2 v1.0" -> {krea}; "v1.1" -> set().
    Digits inside a word go too, so "2vector" and "3vector" are one lineage.
    """
    words = re.split(r'[^a-z0-9]+', str(name or '').lower())
    labels = set()
    for word in words:
        if not word or _VERSION_TOKEN.match(word):
            continue
        stripped = re.sub(r'\d+', '', word)
        if len(stripped) > 1:  # a lone "v" or stray letter carries no meaning
            labels.add(stripped)
    return labels


def _version_numbers(name):
    return [
        tuple(int(part) for part in re.split(r'[._-]', match) if part.isdigit())
        for match in re.findall(r'\d+(?:[._-]\d+)*', str(name or ''))
    ]


def same_version_lineage(installed_name, candidate_name):
    """Whether two version names describe the same thing at different revisions.

    Civitai models publish OPTIONS as versions, not just revisions: "LTX 2.3 -
    Enhancers" ships "Soft Enhance" and "Crisp Enhance" side by side, and the
    higher id is simply the other option, not a newer one. Replacing on that is
    how a Soft install got overwritten with Crisp.

    Heuristic, deliberately conservative: the descriptive words (version numbers
    stripped) must be the same set, or one must be a subset of the other —
    "V4.1 Exp, pre" -> "v4.3_EXP" stays an update, "Soft" -> "Crisp" does not.
    """
    installed = _version_label_tokens(installed_name)
    candidate = _version_label_tokens(candidate_name)
    if not installed or not candidate:
        return True  # a bare "v1.1" says nothing that contradicts the install
    return installed <= candidate or candidate <= installed


def newer_civitai_version(versions, installed_version_id, base_models=None, installed_name=None):
    """The newest version of the SAME base model newer than the installed one, or None.

    Civitai returns versions newest-first, but ids are monotonic per model, so the
    comparison is on the id rather than on list order.

    The base-model filter is what makes this an update rather than a sibling: one
    Civitai model routinely publishes a version per base (ZImageTurbo, Krea 2, Qwen,
    Flux…), and the Krea 2 version of a Z-Image LoRA is a different adapter, not a
    newer one — replacing with it would swap a working file for an incompatible one.
    """
    try:
        installed = int(installed_version_id)
    except (TypeError, ValueError):
        return None
    wanted = [base for base in (base_models or []) if base]
    newest = None
    for version in versions or []:
        try:
            candidate = int(version.get('id'))
        except (TypeError, ValueError):
            continue
        if candidate <= installed:
            continue
        if wanted:
            candidate_base = version.get('baseModel') or ''
            # No declared base is not evidence of a match; skip rather than guess.
            if not candidate_base or not lora_base_matches(candidate_base, wanted):
                continue
        # A sibling option is not an upgrade path, however high its id.
        if installed_name and not same_version_lineage(installed_name, version.get('name')):
            continue
        if newest is None or candidate > int(newest['id']):
            newest = version
    return newest


def civitai_lora_updates(base_models=None, force=False):
    """Map of installed LoRA id -> newer Civitai version, for the ones that have any.

    Only LoRAs with a Civitai sidecar (model id + version id) can be checked; API
    failures are skipped per model so one rate limit does not hide every update.
    """
    items = local_loras_unfiltered()
    if base_models:
        items = [item for item in items if lora_base_matches(item.get('baseModel'), base_models)]
    out = {}
    for item in items:
        record = compact_lora_record(item)
        model_id, version_id = record.get('modelId'), record.get('versionId')
        if not model_id or not version_id:
            continue
        try:
            versions = civitai_model_versions(model_id, force=force)
        except Exception:
            continue
        # Prefer the installed file's own base model; fall back to the caller's
        # filter when the sidecar never recorded one.
        installed_base = [item.get('baseModel')] if item.get('baseModel') else list(base_models or [])
        newer = newer_civitai_version(versions, version_id, installed_base, record.get('versionName'))
        if not newer:
            continue
        out[record['id']] = {
            'currentVersionId': version_id,
            'currentVersionName': record.get('versionName') or '',
            'latestVersionId': newer['id'],
            'latestVersionName': newer.get('name') or '',
            'latestBaseModel': newer.get('baseModel') or '',
            'modelId': model_id,
            'url': f"https://civitai.com/models/{model_id}?modelVersionId={newer['id']}",
        }
    return out


def resolve_installed_lora_path(lora_id):
    """Absolute path for an installed-LoRA id, refusing anything outside models/loras."""
    root = (config.COMFY / 'models' / 'loras').resolve()
    candidate = (root / str(lora_id or '')).resolve()
    if candidate == root or root not in candidate.parents:
        raise RuntimeError('Refusing to touch a LoRA outside the ComfyUI loras directory')
    if not candidate.is_file():
        raise RuntimeError(f'No installed LoRA named {lora_id}')
    return candidate


def replace_installed_lora(old_path, result):
    """Retire the superseded file once its replacement is on disk.

    Called only after a successful download, so the old LoRA stays usable for the
    whole transfer. A same-filename update has already overwritten it, in which
    case there is nothing to remove.
    """
    old = Path(old_path).resolve()
    new = Path((result or {}).get('path') or '').resolve()
    if not new.is_file() or old == new:
        return {'removed': '', 'replacedBy': str(new)}
    root = (config.COMFY / 'models' / 'loras').resolve()
    if root not in old.parents:
        raise RuntimeError('Refusing to remove a LoRA outside the ComfyUI loras directory')
    for sidecar in metadata_sidecars(old):
        sidecar.unlink(missing_ok=True)
    old.unlink(missing_ok=True)
    # Carry the generation selection over to the replacement instead of silently
    # dropping the LoRA out of the active set.
    try:
        old_id = str(old.relative_to(root))
        new_id = str(new.relative_to(root))
        selected = load_selected_loras()
        if any(x.get('id') == old_id for x in selected):
            save_selected_loras([
                {'id': new_id, 'strength': x.get('strength', 1.0)} if x.get('id') == old_id else x
                for x in selected
            ])
    except Exception:
        pass
    return {'removed': str(old), 'replacedBy': str(new)}


def local_lora_catalog(base_models):
    items = local_loras_unfiltered()
    # Opening the panel is the moment the installed set is known, so it is also when
    # cached data for LoRAs that were deleted or replaced stops being reachable.
    _loras.prune_lora_caches(items)
    matches = [
        item for item in items
        if lora_base_matches(item.get('baseModel'), base_models)
    ]
    records = [compact_lora_record(item) for item in matches]
    records.sort(key=lambda item: (item['displayName'].lower(), item['name'].lower()))
    return records


def resolve_lora_selection(items, base_models=None):
    available = {item['id']: item for item in local_loras_unfiltered()}
    clean = []
    seen = set()
    for item in items or []:
        if not isinstance(item, dict):
            continue
        lid = str(item.get('id', '')).strip()
        model = available.get(lid)
        if not model or lid in seen:
            continue
        if base_models and not lora_base_matches(model.get('baseModel'), base_models):
            continue
        try:
            strength = float(item.get('strength', 1.0))
        except Exception:
            strength = 1.0
        strength = max(_loras.LORA_STRENGTH_MIN, min(_loras.LORA_STRENGTH_MAX, strength))
        clean.append({
            'id': lid,
            'name': model['name'],
            'strength': strength,
            'path': model['path'],
            'baseModel': model.get('baseModel', ''),
        })
        seen.add(lid)
    return clean


def save_selected_loras(items):
    clean = resolve_lora_selection(items, current_base_models())
    SELECTED_LORAS_FILE.write_text(json.dumps(clean, indent=2))
    return clean


def selected_lora_id_for_model(model):
    """Return the ComfyUI lora_name/id for an installed model record, if it is a LoRA."""
    if not model or model.get('folder') != 'loras':
        return ''
    try:
        return str(Path(model.get('path', '')).resolve().relative_to((config.COMFY / 'models' / 'loras').resolve()))
    except Exception:
        mid = str(model.get('id') or '')
        return mid[len('loras/'):] if mid.startswith('loras/') else str(model.get('name') or '')


def add_lora_to_generation_selection(model, strength=1.0):
    lid = selected_lora_id_for_model(model)
    if not lid:
        return False
    selected = load_selected_loras()
    if any(x.get('id') == lid for x in selected):
        return False
    updated = save_selected_loras(selected + [{'id': lid, 'strength': strength}])
    return any(x.get('id') == lid for x in updated)


def remove_lora_from_generation_selection(model):
    lid = selected_lora_id_for_model(model)
    if not lid:
        return False
    selected = load_selected_loras()
    updated = [x for x in selected if x.get('id') != lid]
    if len(updated) == len(selected):
        return False
    save_selected_loras(updated)
    return True


def summarize_civitai_item(item):
    versions=[]
    for v in item.get('modelVersions') or []:
        files=[]
        for f in v.get('files') or []:
            files.append({'id': f.get('id'), 'name': f.get('name'), 'type': f.get('type'), 'primary': f.get('primary'), 'sizeKB': f.get('sizeKB'), 'metadata': f.get('metadata') or {}, 'downloadUrl': f.get('downloadUrl')})
        versions.append({'id': v.get('id'), 'name': v.get('name'), 'baseModel': v.get('baseModel'), 'trainedWords': v.get('trainedWords') or [], 'files': files, 'downloadUrl': v.get('downloadUrl'), 'images': v.get('images') or []})
    return {'id': item.get('id'), 'name': item.get('name'), 'type': item.get('type'), 'nsfw': item.get('nsfw'), 'creator': (item.get('creator') or {}).get('username'), 'stats': item.get('stats') or {}, 'modelVersions': versions}


class DownloadCancelled(Exception):
    """Raised inside the transfer loop when a caller asks to cancel a download."""


def download_civitai_version(version_id, file_id=None, progress_cb=None, token_override=None, should_cancel=None):
    version = civitai_json(f'/model-versions/{int(version_id)}', token_override=token_override)
    model_type = (version.get('model') or {}).get('type') or 'Model'
    files = version.get('files') or []
    chosen = None
    if file_id:
        chosen = next((f for f in files if str(f.get('id')) == str(file_id)), None)
    if not chosen:
        chosen = next((f for f in files if f.get('primary')), None) or (files[0] if files else None)
    if not chosen:
        raise RuntimeError('No downloadable files on this version')
    dest_dir = comfy_dir_for_civitai(model_type, chosen.get('name'))
    dest_dir.mkdir(parents=True, exist_ok=True)
    filename = util.safe_name(chosen.get('name') or f'civitai_{version_id}.safetensors')
    dest = (dest_dir / filename).resolve()
    if not str(dest).startswith(str((config.COMFY / 'models').resolve())):
        raise RuntimeError('Refusing to write outside ComfyUI models directory')
    url = chosen.get('downloadUrl') or version.get('downloadUrl') or f'https://civitai.com/api/download/models/{version_id}'
    req = Request(civitai_download_url(url, token_override=token_override), headers=civitai_download_headers())
    try:
        r = net.urlopen(req, timeout=60)
    except HTTPError as e:
        body = ''
        try:
            body = e.read().decode('utf-8', errors='replace')
        except Exception:
            body = ''
        if e.code == 401:
            message = ''
            try:
                parsed = json.loads(body) if body else {}
                message = parsed.get('message') or parsed.get('error') or ''
            except Exception:
                message = body.strip()
            if message:
                message = message.rstrip('. ') + '.'
            # No path here: the token-file location named the owner's home
            # directory in a toast. Settings is where the token is added.
            token_hint = " This model needs a Civitai token — add it in Settings." if not civitai_token(token_override) else ""
            raise RuntimeError(f"Civitai download requires authenticated Civitai access for version {version_id}. {message}{token_hint}".strip()) from e
        raise
    with r:
        total = int(r.headers.get('Content-Length') or chosen.get('sizeKB') or 0)
        if total and total < 1024 * 1024 and chosen.get('sizeKB'):
            total = int(float(chosen.get('sizeKB')) * 1024)
        cd = r.headers.get('Content-Disposition','')
        m = re.search(r"filename\\*?=(?:UTF-8''|utf-8'')?\"?([^\";]+)", cd, re.I)
        if m:
            filename = util.safe_name(m.group(1).split('/')[-1])
            dest = (dest_dir / filename).resolve()
        tmp = dest.with_suffix(dest.suffix + '.part')
        done = 0
        if progress_cb:
            progress_cb(done, total)
        cancelled = False
        try:
            with tmp.open('wb') as f:
                while True:
                    if should_cancel and should_cancel():
                        cancelled = True
                        break
                    chunk = r.read(1024*1024)
                    if not chunk:
                        break
                    f.write(chunk)
                    done += len(chunk)
                    if progress_cb:
                        progress_cb(done, total)
        except Exception:
            # A reset or a full disk used to leave the .part behind (only the
            # cancel path cleaned up); the partial file is the only trace.
            tmp.unlink(missing_ok=True)
            raise
        if cancelled:
            # Leave nothing half-written behind: the partial file is the only trace.
            tmp.unlink(missing_ok=True)
            raise DownloadCancelled('Download cancelled')
        tmp.rename(dest)
    side = {'downloadedAt': util.now_iso(), 'modelType': model_type, 'modelVersion': version, 'baseModel': version.get('baseModel'), 'file': chosen}
    lora_sidecar(dest).write_text(json.dumps(side, indent=2))
    return {'ok': True, 'path': str(dest), 'directory': str(dest_dir), 'filename': dest.name, 'modelType': model_type, 'baseModel': version.get('baseModel'), 'versionId': version.get('id'), 'fileId': chosen.get('id')}


def public_download_job(job):
    out = dict(job or {})
    total = int(out.get('total_bytes') or 0)
    done = int(out.get('downloaded_bytes') or 0)
    out['percent'] = int(min(100, max(0, (done / total) * 100))) if total else (100 if out.get('status') == 'success' else 0)
    return out


def cancel_civitai_download_job(job_id):
    """Flag a running download for cancellation; the transfer loop stops at the next chunk."""
    with history.download_jobs_lock:
        rec = history.download_jobs.get(job_id)
        if not rec:
            return None
        if rec.get('status') in ('queued', 'running'):
            rec['cancel_requested'] = True
            rec['updated_at'] = util.now_iso()
            history.download_jobs[job_id] = rec
            history.save_download_jobs_unlocked()
        return dict(rec)


def download_job_cancel_requested(job_id):
    with history.download_jobs_lock:
        return bool((history.download_jobs.get(job_id) or {}).get('cancel_requested'))


def start_civitai_download_job(version_id, file_id=None, token_override=None, name=None, replace_id=None):
    job_id = uuid.uuid4().hex[:12]
    rec = {'id': job_id, 'status': 'queued', 'created_at': util.now_iso(), 'versionId': str(version_id), 'fileId': str(file_id or ''), 'downloaded_bytes': 0, 'total_bytes': 0}
    if name:
        # Carried so a caller can label the download before the file lands.
        rec['name'] = str(name)
    replace_path = resolve_installed_lora_path(replace_id) if replace_id else None
    if replace_path:
        # Echoed so a reconnecting client knows which card this download updates.
        rec['replaces'] = str(replace_id)
    with history.download_jobs_lock:
        history.download_jobs[job_id] = rec
        history.save_download_jobs_unlocked()

    def progress(done, total):
        history.update_download_job(job_id, status='running', downloaded_bytes=int(done or 0), total_bytes=int(total or 0), updated_at=util.now_iso())

    def worker():
        history.update_download_job(job_id, status='running', started_at=util.now_iso())
        try:
            result = download_civitai_version(
                version_id,
                file_id,
                progress_cb=progress,
                token_override=token_override,
                should_cancel=lambda: download_job_cancel_requested(job_id),
            )
            if replace_path:
                # Only now that the replacement is on disk does the old file go.
                result = {**result, 'replaced': replace_installed_lora(replace_path, result)}
            with history.download_jobs_lock:
                downloaded = history.download_jobs[job_id].get('total_bytes') or history.download_jobs[job_id].get('downloaded_bytes', 0)
            history.update_download_job(job_id, status='success', finished_at=util.now_iso(), result=result, downloaded_bytes=downloaded)
        except DownloadCancelled:
            history.update_download_job(job_id, status='cancelled', finished_at=util.now_iso(), error='Download cancelled')
        except Exception as e:
            history.update_download_job(job_id, status='error', finished_at=util.now_iso(), error=str(e))

    threading.Thread(target=worker, daemon=True).start()
    return public_download_job(rec)

def ram_info():
    try:
        s = net.comfy_json('/system_stats')
        total = int(s.get('system', {}).get('ram_total') or 0)
        free = int(s.get('system', {}).get('ram_free') or 0)
    except Exception:
        total = free = 0
    if total <= 0:
        try:
            out = subprocess.check_output(['vm_stat'], text=True)
            page = 16384
            vals = {}
            for line in out.splitlines():
                if ':' in line:
                    k,v=line.split(':',1)
                    vals[k]=int(re.sub(r'[^0-9]','',v) or 0)
            free = (vals.get('Pages free',0)+vals.get('Pages inactive',0)+vals.get('Pages speculative',0))*page
            total = int(subprocess.check_output(['sysctl','-n','hw.memsize'], text=True).strip())
        except Exception:
            total = free = 0
    equipped = load_equipped()
    reserved = sum(m.get('estimated_ram_bytes', 0) for m in equipped)
    used = max(total - free, 0) if total else 0
    return {'total': total, 'free': free, 'used': used, 'reserved_equipped': reserved, 'safe_free': max(free - 8*1024**3, 0)}


def model_category(folder, name):
    f, n = folder.lower(), name.lower()
    if any(x in n for x in ['wan', 'hunyuan', 'ltx', 'mochi', 'video', 'animatediff', 'svd']):
        return 'Video generation'
    # ComfyUI text_encoders are components for image/video workflows, not chat LLMs.
    # Check this before name-based LLM detection so qwen_3_4b stays with Z-Image parts.
    if any(x in f for x in ['text_encoders', 'clip', 'bert', 't5']):
        return 'Text encoders'
    if any(x in f for x in ['llm', 'gguf']) or any(x in n for x in ['llama', 'qwen', 'mistral', 'gemma', 'deepseek', 'phi-']):
        return 'LLM / text'
    if any(x in f for x in ['vae']):
        return 'VAE'
    if any(x in f for x in ['lora']):
        return 'LoRA / adapters'
    if any(x in f for x in ['controlnet']):
        return 'Control / conditioning'
    if any(x in f for x in ['upscale', 'esrgan']):
        return 'Upscalers'
    if any(x in f for x in ['audio', 'music', 'svae']):
        return 'Audio generation'
    return 'Image generation'


def estimate_ram(size, folder, name):
    factor = 1.25
    if model_category(folder, name) in {'Text encoders','LLM / text'}:
        factor = 1.15
    if model_category(folder, name) == 'LoRA / adapters':
        factor = 1.05
    return int(size * factor + 512*1024**2)


def model_role(folder, name):
    f = folder.lower()
    if f in {'diffusion_models', 'unet', 'checkpoints'}:
        return 'primary'
    if f in {'animatediff_models'}:
        return 'video_motion'
    if f in {'text_encoders', 'clip'}:
        return 'text_encoder'
    if f == 'vae':
        return 'vae'
    if f == 'loras':
        return 'adapter'
    return 'aux'


def scan_civitai_downloads():
    """Return Civitai version/file IDs already present on disk via download sidecars.

    The UI uses this to keep Download buttons as Downloaded after a browser reload,
    because React state only knows about downloads started in the current session.
    """
    root = config.COMFY / 'models'
    installed = {'versionIds': [], 'fileIds': [], 'byVersion': {}, 'byFile': {}}
    if not root.exists():
        return installed
    seen_versions, seen_files = set(), set()
    for side in root.rglob('*.civitai.json'):
        try:
            meta = json.loads(side.read_text(encoding='utf-8'))
        except Exception:
            continue
        version = meta.get('modelVersion') or {}
        file_meta = meta.get('file') or {}
        model_path = str(side)[:-len('.civitai.json')]
        rec = {
            'path': model_path,
            'filename': Path(model_path).name,
            'modelType': meta.get('modelType'),
            'baseModel': meta.get('baseModel') or version.get('baseModel'),
            'downloadedAt': meta.get('downloadedAt'),
            'versionId': version.get('id'),
            'fileId': file_meta.get('id'),
        }
        vid = str(version.get('id') or '')
        fid = str(file_meta.get('id') or '')
        if vid:
            installed['byVersion'][vid] = rec
            if vid not in seen_versions:
                installed['versionIds'].append(vid)
                seen_versions.add(vid)
        if fid:
            installed['byFile'][fid] = rec
            if fid not in seen_files:
                installed['fileIds'].append(fid)
                seen_files.add(fid)
    return installed


def scan_models():
    exts = {'.safetensors','.ckpt','.pt','.pth','.bin','.gguf','.onnx'}
    models = []
    base = config.COMFY/'models'
    if base.exists():
        for p in base.rglob('*'):
            if p.is_file() and p.suffix.lower() in exts and '.part' not in p.name:
                rel = p.relative_to(base)
                folder = rel.parts[0] if len(rel.parts) > 1 else 'models'
                size = p.stat().st_size
                mid = str(rel)
                models.append({'id': mid, 'name': p.name, 'folder': folder, 'path': str(p), 'size_bytes': size, 'size': util.human_bytes(size), 'category': model_category(folder, p.name), 'role': model_role(folder, p.name), 'estimated_ram_bytes': estimate_ram(size, folder, p.name)})
    models.sort(key=lambda m:(m['category'], m['folder'], m['name'].lower()))
    return models




def read_json_file(path, fallback=None):
    try:
        return json.loads(Path(path).read_text(encoding='utf-8'))
    except Exception:
        return {} if fallback is None else fallback


def metadata_sidecars(path):
    p = Path(path)
    return [
        Path(str(p) + '.civitai.json'),
        p.with_suffix('.metadata.json'),
        Path(str(p) + '.metadata.json'),
    ]


def read_safetensors_metadata(path):
    """Read lightweight embedded safetensors metadata without loading tensor data."""
    p = Path(path)
    if p.suffix.lower() != '.safetensors':
        return {}
    try:
        import struct
        with p.open('rb') as f:
            raw_len = f.read(8)
            if len(raw_len) != 8:
                return {}
            header_len = struct.unpack('<Q', raw_len)[0]
            # Metadata headers are small; refuse absurd values to avoid reading model data.
            if header_len <= 0 or header_len > 64 * 1024 * 1024:
                return {}
            header = json.loads(f.read(header_len))
        meta = header.get('__metadata__') if isinstance(header, dict) else None
        return meta if isinstance(meta, dict) else {}
    except Exception:
        return {}


def normalize_embedded_lora_metadata(meta):
    """Map common embedded LoRA metadata keys into wrapper fields.

    Trainers are inconsistent: kohya-style LoRAs often use ss_base_model_version,
    newer files may use modelspec.architecture, and some files contain no useful
    compatibility metadata. Keep the raw keys too; only add normalized aliases.
    """
    if not isinstance(meta, dict):
        return {}
    out = dict(meta)
    base = (
        meta.get('baseModel')
        or meta.get('base_model')
        or meta.get('ss_base_model_version')
        or meta.get('modelspec.base_model')
        or meta.get('modelspec.architecture')
        or ''
    )
    if base and not out.get('baseModel'):
        out['baseModel'] = str(base)
    if meta.get('ss_output_name') and not out.get('name'):
        out['name'] = str(meta.get('ss_output_name'))
    return out


def read_model_metadata(path):
    merged = normalize_embedded_lora_metadata(read_safetensors_metadata(path))
    for side in metadata_sidecars(path):
        if side.exists():
            data = read_json_file(side, {})
            if isinstance(data, dict):
                # Sidecars from Civitai/downloads are more authoritative than
                # embedded trainer guesses, so let them override.
                merged.update(data)
    return merged


def preview_for_model(path, meta):
    candidates = []
    for key in ['preview_url', 'previewUrl', 'image', 'thumbnail']:
        if meta.get(key):
            candidates.append(str(meta.get(key)))
    civ = meta.get('civitai') or {}
    for img in (civ.get('images') or meta.get('images') or []):
        if isinstance(img, dict) and img.get('url'):
            candidates.append(str(img.get('url')))
    version = meta.get('modelVersion') or {}
    for img in version.get('images') or []:
        if isinstance(img, dict) and img.get('url'):
            candidates.append(str(img.get('url')))
    p = Path(path)
    for ext in ['.preview.png', '.preview.jpg', '.preview.jpeg', '.png', '.jpg', '.jpeg', '.webp']:
        candidates.append(str(p.with_suffix(ext)))
    for c in candidates:
        if not c:
            continue
        if c.startswith(('http://', 'https://')):
            return c
        # A local candidate only counts if the file is actually there. Absolute paths
        # used to short-circuit this check, so every model reported the FIRST sibling
        # extension whether it existed or not — a preview URL that always 404s.
        cp = Path(c)
        if not cp.is_absolute():
            cp = p.parent / c
        if cp.exists() and cp.is_file():
            return str(cp)
    return ''


def normalize_tags(meta):
    tags = meta.get('tags') or []
    if isinstance(tags, str):
        tags = [x.strip() for x in re.split(r'[,#]', tags) if x.strip()]
    civ = meta.get('civitai') or {}
    model = civ.get('model') or {}
    if isinstance(model.get('tags'), list):
        tags = list(tags) + model.get('tags')
    out=[]
    seen=set()
    for t in tags:
        if not t:
            continue
        tt=str(t).strip()
        k=tt.lower()
        if k not in seen:
            out.append(tt)
            seen.add(k)
    return out[:24]


def trigger_words(meta):
    words=[]
    for src in [meta.get('civitai') or {}, meta.get('modelVersion') or {}, meta]:
        vals = src.get('trainedWords') or src.get('trigger_words') or []
        if isinstance(vals, str):
            vals = [x.strip() for x in vals.split(',') if x.strip()]
        if isinstance(vals, list):
            words += [str(x) for x in vals if x]
    out=[]
    seen=set()
    for w in words:
        k=w.lower()
        if k not in seen:
            out.append(w)
            seen.add(k)
    return out[:20]


def library_item_from_model(m):
    path = Path(m['path'])
    meta = read_model_metadata(path)
    civ = meta.get('civitai') or {}
    civ_model = civ.get('model') or {}
    version = meta.get('modelVersion') or civ
    creator = meta.get('creator') or (civ.get('creator') or {}).get('username') or (civ_model.get('creator') or {}).get('username') or ''
    base = meta.get('base_model') or meta.get('baseModel') or version.get('baseModel') or m.get('baseModel') or ''
    display = meta.get('model_name') or meta.get('name') or civ_model.get('name') or path.stem
    modified = meta.get('modified') or path.stat().st_mtime
    usage = meta.get('usage_tips') or {}
    if isinstance(usage, str):
        try:
            usage = json.loads(usage)
        except Exception:
            usage = {'text': usage} if usage else {}
    return {
        **m,
        'displayName': display,
        'baseModel': base or 'Unknown',
        'creator': creator,
        'tags': normalize_tags(meta),
        'triggerWords': trigger_words(meta),
        'preview': preview_for_model(path, meta),
        'favorite': bool(meta.get('favorite')),
        'notes': meta.get('notes') or '',
        'description': meta.get('modelDescription') or version.get('description') or civ_model.get('description') or '',
        'usageTips': usage,
        'dateAdded': datetime.fromtimestamp(float(modified), timezone.utc).isoformat() if modified else '',
        'metadata': meta,
    }


def scan_library():
    models = [library_item_from_model(m) for m in scan_models()]
    buckets = {
        'loras': [],
        'checkpoints': [],
        'embeddings': [],
        'other': [],
    }
    for m in models:
        folder = (m.get('folder') or '').lower()
        role = (m.get('role') or '').lower()
        if 'lora' in folder or role == 'adapter':
            buckets['loras'].append(m)
        elif folder in {'checkpoints', 'diffusion_models', 'unet'} or role == 'primary':
            buckets['checkpoints'].append(m)
        elif 'embedding' in folder or 'textualinversion' in folder:
            buckets['embeddings'].append(m)
        else:
            buckets['other'].append(m)
    for arr in buckets.values():
        arr.sort(key=lambda x: (not x.get('favorite'), x.get('displayName','').lower()))
    recipes = scan_recipes(models)
    stats = library_stats(buckets, recipes)
    return {'items': models, **buckets, 'recipes': recipes, 'stats': stats, 'baseModels': sorted({m.get('baseModel') for m in models if m.get('baseModel')}), 'tags': top_values(models, 'tags')}


def top_values(models, key, limit=80):
    counts = {}
    for m in models:
        vals = m.get(key) or []
        if not isinstance(vals, list):
            vals=[vals]
        for v in vals:
            if v:
                counts[str(v)] = counts.get(str(v), 0) + 1
    return [{'name': k, 'count': v} for k, v in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0].lower()))[:limit]]


def scan_recipes(models):
    recipes=[]
    # Treat saved generation history with selected LoRAs as lightweight recipes.
    for rec in history.load_history(300):
        loras = rec.get('loras') or []
        if not loras:
            continue
        recipes.append({
            'id': rec.get('id'),
            'title': 'Private recipe',
            'prompt': '',
            'loras': loras,
            'tags': ['history'],
            'created_at': rec.get('created_at') or rec.get('finished_at'),
            'preview': (history.public_record(rec).get('image_urls') or [''])[0],
        })
    recipe_dir = config.BASE / 'recipes'
    if recipe_dir.exists():
        for rp in recipe_dir.rglob('*.json'):
            data = read_json_file(rp, {})
            if isinstance(data, dict):
                recipes.append({'id': str(rp.relative_to(recipe_dir)), 'title': data.get('title') or data.get('name') or rp.stem, 'prompt': data.get('prompt') or data.get('positive') or '', 'loras': data.get('loras') or [], 'tags': data.get('tags') or [], 'created_at': data.get('created_at') or '', 'preview': data.get('preview') or ''})
    return recipes[:200]


def library_stats(buckets, recipes):
    allm = buckets['loras'] + buckets['checkpoints'] + buckets['embeddings'] + buckets['other']
    total_bytes = sum(int(m.get('size_bytes') or 0) for m in allm)
    return {
        'totalModels': len(allm),
        'loras': len(buckets['loras']),
        'checkpoints': len(buckets['checkpoints']),
        'embeddings': len(buckets['embeddings']),
        'recipes': len(recipes),
        'totalBytes': total_bytes,
        'favoriteCount': sum(1 for m in allm if m.get('favorite')),
        'taggedCount': sum(1 for m in allm if m.get('tags')),
        'withPreviewCount': sum(1 for m in allm if m.get('preview')),
        'baseModels': top_values(allm, 'baseModel', 30),
        'topTags': top_values(allm, 'tags', 30),
    }


def model_bundles(models=None):
    """Best-effort stack metadata. ComfyUI exposes available files, but not a universal
    primary-model -> encoder/VAE dependency graph, so we combine known manifests
    (e.g. Z-Image) plus workflow/file heuristics. This can be extended as new
    image/video stacks are installed."""
    models = models or scan_models()
    by_id = {m['id']: m for m in models}
    bundles = {}
    def add(primary, label, deps=None, replaces_roles=None, source='manifest'):
        if primary not in by_id:
            return
        deps = [d for d in (deps or []) if d in by_id]
        bundles[primary] = {
            'primary': primary,
            'label': label,
            'deps': deps,
            'all': [primary] + deps,
            'replaces_roles': replaces_roles or ['primary', 'text_encoder', 'vae'],
            'source': source,
        }
    add('diffusion_models/z_image_turbo_bf16.safetensors', 'Z-Image Turbo stack', ['text_encoders/qwen_3_4b.safetensors', 'vae/ae.safetensors'])
    for m in models:
        if m['folder'] == 'checkpoints' and m['id'] not in bundles:
            add(m['id'], m['name'].replace('.safetensors','').replace('.ckpt','') + ' checkpoint stack', [], ['primary', 'text_encoder', 'vae'], 'checkpoint')
    return bundles


def load_equipped():
    if not EQUIPPED_FILE.exists():
        return []
    try:
        return json.loads(EQUIPPED_FILE.read_text())
    except Exception:
        return []


def save_equipped(items):
    EQUIPPED_FILE.write_text(json.dumps(items, indent=2))


def equip_model(mid):
    models_list = scan_models()
    models = {m['id']: m for m in models_list}
    if mid not in models:
        return False, 'Model not found'
    bundles = model_bundles(models_list)
    bundle = bundles.get(mid)
    equipped = load_equipped()
    eq_by_id = {m.get('id'): m for m in equipped}
    if bundle:
        desired_ids = set(bundle['all'])
        # Switching a managed image/video stack replaces old primary/text-encoder/VAE
        # components so incompatible encoders do not stay equipped accidentally.
        def role_of(item):
            cur = models.get(item.get('id'), item)
            return cur.get('role') or item.get('role')
        keep = [models.get(m.get('id'), m) for m in equipped if not (role_of(m) in bundle['replaces_roles'] and m.get('id') not in desired_ids)]
        for did in bundle['all']:
            if did not in {m.get('id') for m in keep}:
                keep.append(models[did])
        new_equipped = keep
        added = [models[i]['name'] for i in bundle['all'] if i not in eq_by_id]
        removed = [models.get(m.get('id'), m).get('name') for m in equipped if role_of(m) in bundle['replaces_roles'] and m.get('id') not in desired_ids]
        msg = f"Equipped {bundle['label']}"
        if added:
            msg += f"; added {', '.join(added)}"
        if removed:
            msg += f"; replaced {', '.join(removed)}"
    else:
        if any(m.get('id') == mid for m in equipped):
            return True, 'Already equipped'
        new_equipped = equipped + [models[mid]]
        msg = 'Equipped'
    ram = ram_info()
    reserved = sum(m.get('estimated_ram_bytes', 0) for m in new_equipped)
    limit = max(ram.get('total',0) - 10*1024**3, 0)
    if ram.get('total') and reserved > limit:
        return False, f"Not enough safe RAM: equipping would reserve {util.human_bytes(reserved)} of {util.human_bytes(ram['total'])}."
    save_equipped(new_equipped)
    if models[mid].get('folder') == 'loras':
        if add_lora_to_generation_selection(models[mid]):
            msg += '; added to generation selection'
        else:
            msg += '; generation selection unchanged'
    return True, msg


def unequip_model(mid):
    before = load_equipped()
    removed = [m for m in before if m.get('id') == mid]
    after = [m for m in before if m.get('id') != mid]
    save_equipped(after)
    for model in removed:
        remove_lora_from_generation_selection(model)
    try:
        net.comfy_json('/free', 'POST', {'unload_models': True, 'free_memory': True})
    except Exception:
        pass
    return len(after) != len(before)
