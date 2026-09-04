"""Private media: staged inputs and their sweeper, output encryption, the E2E
vault identity and the sealed-envelope helpers that serve a file back."""
import base64
import binascii
import getpass
import hashlib
import json
import mimetypes
import os
import re
import sqlite3
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from gateway import config, history, promptroutes, util, workflow_index


OUTPUT_MEDIA_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4", ".mov", ".webm", ".m4v", ".mkv"}
OUTPUT_ENCRYPTION_ENABLED = os.environ.get("ZIMG_OUTPUT_ENCRYPTION", "1") != "0"
OUTPUT_ENCRYPTION_SERVICE = os.environ.get("ZIMG_OUTPUT_KEYCHAIN_SERVICE", "zimage-output-encryption")
OUTPUT_ENCRYPTION_ITER = int(os.environ.get("ZIMG_OUTPUT_ENCRYPTION_ITER", "50000"))
OUTPUT_PLAINTEXT_GRACE_SECONDS = int(os.environ.get("ZIMG_OUTPUT_PLAINTEXT_GRACE", "0"))
OUTPUT_ENCRYPTION_SUFFIX = ".zenc"
# Phase-2 client-side E2E media (off by default; coexists with legacy .zenc).
# When on AND the owner has created a vault (public key present), new output is
# sealed to that public key so the gateway can encrypt but never decrypt — only
# the browser holding the passphrase-derived private key can. See media_seal.py.
E2E_MEDIA_ENABLED = os.environ.get("ZIMG_E2E_MEDIA", "0") == "1"
E2E_MEDIA_SUFFIX = ".e2e"
VAULT_DB = Path(os.environ.get(
    "ZIMG_VAULT_DB",
    str(Path(os.environ.get("CONTENT_STUDIO_DATA_DIR", str(Path(__file__).resolve().parents[2] / "data"))) / "owner-vault.sqlite3"),
)).expanduser()
PRIVATE_INPUT_PREFIXES = (
    "media-studio-inline-",
    "media-studio-input-",
    "media-studio-reference-",
    "mcp_inline_",
    "mcp_ingredients_",
    "mcp_ltx_",
    "mcp_video_",
)
PRIVATE_INPUT_MAX_AGE_SECONDS = int(os.environ.get("ZIMG_PRIVATE_INPUT_MAX_AGE", "7200"))
# Uploads that arrive through the generic ComfyUI upload route keep the caller's
# own filename, so they match none of the staging prefixes above and used to sit
# in the input directory as plaintext forever. The local generator has to read
# these pixels, so they cannot be sealed to the owner vault the way outputs are —
# bounded retention is what keeps the exposure window short. Durable references
# live sealed in the owner reference store (data/uploads), never here.
PRIVATE_INPUT_UPLOAD_MAX_AGE_SECONDS = int(os.environ.get("ZIMG_PRIVATE_INPUT_UPLOAD_MAX_AGE", "86400"))
encryption_lock = threading.Lock()
active_output_paths = set()
active_output_paths_lock = threading.Lock()
_output_encryption_password = None


def delete_private_input(name):
    raw = str(name or "").strip()
    if not raw or Path(raw).name != raw or not raw.startswith(PRIVATE_INPUT_PREFIXES):
        raise ValueError("invalid private input filename")
    root = config.COMFY_INPUT_DIR.expanduser().resolve()
    candidate = (root / raw).resolve()
    if not util._is_under(candidate, root):
        raise ValueError("private input path escaped the input directory")
    if not candidate.exists():
        return False
    if not candidate.is_file():
        raise ValueError("private input is not a file")
    candidate.unlink()
    return True


def cleanup_staged_private_inputs_once(
    max_age_seconds=PRIVATE_INPUT_MAX_AGE_SECONDS,
    upload_max_age_seconds=None,
):
    """Expire plaintext inputs. Pipeline staging (the known prefixes) is short
    lived; anything else — user-named uploads, keyframes, nested reference
    folders — expires on the longer upload budget instead of living forever."""
    upload_age = (
        PRIVATE_INPUT_UPLOAD_MAX_AGE_SECONDS if upload_max_age_seconds is None else upload_max_age_seconds
    )
    root = config.COMFY_INPUT_DIR.expanduser().resolve()
    if not root.exists():
        return 0
    now = time.time()
    deleted = 0
    for candidate in root.rglob("*"):
        if not candidate.is_file():
            continue
        # Already-sealed envelopes are client-only; nothing to expire for privacy.
        if candidate.suffix in (OUTPUT_ENCRYPTION_SUFFIX, E2E_MEDIA_SUFFIX):
            continue
        limit = max_age_seconds if candidate.name.startswith(PRIVATE_INPUT_PREFIXES) else upload_age
        try:
            if now - candidate.stat().st_mtime < limit:
                continue
            candidate.unlink()
            deleted += 1
        except OSError:
            continue
    return deleted


def private_input_sweeper():
    while True:
        cleanup_staged_private_inputs_once()
        time.sleep(300)


def output_encryption_password(create=True):
    """Return the output encryption secret: macOS Keychain, else a 0600 key file.

    The secret is intentionally not stored in project files or logs. This is
    encryption-at-rest against filesystem browsing/copying; the running wrapper
    process can still decrypt in order to serve authenticated app requests.
    """
    global _output_encryption_password
    if _output_encryption_password:
        return _output_encryption_password
    if not OUTPUT_ENCRYPTION_ENABLED:
        return None
    account = getpass.getuser()
    try:
        proc = subprocess.run(
            ["/usr/bin/security", "find-generic-password", "-s", OUTPUT_ENCRYPTION_SERVICE, "-a", account, "-w"],
            text=True,
            capture_output=True,
            timeout=10,
        )
        if proc.returncode == 0 and proc.stdout.strip():
            _output_encryption_password = proc.stdout.strip()
            return _output_encryption_password
    except Exception:
        pass
    # A machine that already fell back to a key file keeps using it. Reversing
    # that order would mean the day the Keychain starts answering again, every
    # output encrypted since becomes undecryptable.
    from_file = _output_encryption_key_file_read()
    if from_file:
        _output_encryption_password = from_file
        return from_file
    if not create:
        return None
    secret = base64.urlsafe_b64encode(os.urandom(48)).decode("ascii")
    try:
        proc = subprocess.run(
            ["/usr/bin/security", "add-generic-password", "-U", "-s", OUTPUT_ENCRYPTION_SERVICE, "-a", account, "-w", secret],
            text=True,
            capture_output=True,
            timeout=10,
        )
        stored = proc.returncode == 0
    except Exception:
        stored = False
    if not stored:
        # Linux, Windows, a locked keychain, no `security` binary: a 0600 key
        # file under the gateway state dir, so the gateway starts instead of
        # aborting before it ever listens.
        secret = _output_encryption_key_file_write(secret)
        if not secret:
            raise RuntimeError("could not create the output encryption key")
    _output_encryption_password = secret
    return secret


OUTPUT_ENCRYPTION_KEY_FILE = config.GATEWAY_STATE_DIR / "secure" / f"{OUTPUT_ENCRYPTION_SERVICE}.key"


def _output_encryption_key_file_read():
    try:
        if OUTPUT_ENCRYPTION_KEY_FILE.is_file():
            return OUTPUT_ENCRYPTION_KEY_FILE.read_text(encoding="ascii").strip() or None
    except OSError:
        pass
    return None


def _output_encryption_key_file_write(secret):
    """Write the key 0600, or return the one that beat us to it."""
    try:
        OUTPUT_ENCRYPTION_KEY_FILE.parent.mkdir(parents=True, exist_ok=True)
        os.chmod(OUTPUT_ENCRYPTION_KEY_FILE.parent, 0o700)
        descriptor = os.open(str(OUTPUT_ENCRYPTION_KEY_FILE), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w") as handle:
            handle.write(secret)
        return secret
    except FileExistsError:
        return _output_encryption_key_file_read()
    except OSError:
        return None


def encrypted_path_for(path):
    path = Path(path)
    return path.with_name(path.name + OUTPUT_ENCRYPTION_SUFFIX)


def logical_path_for_encrypted(path):
    path = Path(path)
    if path.name.endswith(OUTPUT_ENCRYPTION_SUFFIX):
        return path.with_name(path.name[:-len(OUTPUT_ENCRYPTION_SUFFIX)])
    if path.name.endswith(E2E_MEDIA_SUFFIX):
        return path.with_name(path.name[:-len(E2E_MEDIA_SUFFIX)])
    return path


def mark_output_active(path):
    with active_output_paths_lock:
        active_output_paths.add(str(Path(path).resolve()))


def mark_output_inactive(path):
    with active_output_paths_lock:
        active_output_paths.discard(str(Path(path).resolve()))


def output_path_is_active(path):
    with active_output_paths_lock:
        return str(Path(path).resolve()) in active_output_paths


def is_encryptable_output(path):
    path = Path(path)
    if not OUTPUT_ENCRYPTION_ENABLED:
        return False
    if output_path_is_active(path):
        return False
    if path.name.endswith(OUTPUT_ENCRYPTION_SUFFIX) or path.name.endswith(E2E_MEDIA_SUFFIX):
        return False
    if path.suffix.lower() not in OUTPUT_MEDIA_EXTS:
        return False
    if util._is_under(path, config.DEBUG_OUTPUT_DIR):
        return False
    return util._is_under(path, config.OUT_DIR) or util._is_under(path, config.COMFY_OUTPUT_DIR)


_vault_public_key_cache = {"mtime": None, "spki": None}


def e2e_envelope_path_for(path):
    path = Path(path)
    return path.with_name(path.name + E2E_MEDIA_SUFFIX)


def existing_output_path(logical):
    """The physical file for a logical output: plaintext, legacy .zenc, or E2E
    .e2e envelope. Returns None if none exists. Used so history/gallery listing
    finds E2E outputs (whose only on-disk form is the .e2e envelope)."""
    logical = Path(logical)
    for candidate in (logical, encrypted_path_for(logical), e2e_envelope_path_for(logical)):
        try:
            if candidate.exists():
                return candidate
        except OSError:
            continue
    return None


# --- Agent dual-recipient sealing -------------------------------------------
#
# An agent driving the gateway generates the pixels but cannot read them back:
# every output is sealed to the OWNER's vault key and the plaintext is deleted,
# by design. The old workaround was to run a second gateway with
# ZIMG_OUTPUT_ENCRYPTION=0 writing plaintext into a scratch directory — an
# unaudited hole, and the results never reached the owner's studio at all.
#
# Instead, seal the same output twice. The owner's envelope is byte-for-byte
# what it has always been (same helper, same key, same <name>.e2e path), so the
# frontend, history and sweeper are untouched. A second envelope is sealed to
# the requesting agent's PUBLIC key at <name>.agent-<fp>.e2e; the agent holds
# the matching private key and decrypts it itself. No plaintext is written, no
# key is shared, and revoking the agent key ends its access to anything new.
#
# Off unless ZIMG_AGENT_DUAL_SEAL=1. The recipient is per-job: only jobs whose
# submit presented X-E2E-Requester-Pub get a second envelope, so the owner's own
# studio generations stay owner-only.
AGENT_DUAL_SEAL_ENABLED = os.environ.get("ZIMG_AGENT_DUAL_SEAL", "0") == "1"
AGENT_ENVELOPE_PREFIX = ".agent-"
AGENT_SEAL_JOBS_MAX = 256
_agent_seal_jobs = {}
_agent_seal_lock = threading.Lock()


def agent_envelope_path_for(path, fingerprint):
    """<name>.agent-<fp>.e2e — one envelope per recipient, alongside the owner's."""
    path = Path(path)
    return path.with_name(f"{path.name}{AGENT_ENVELOPE_PREFIX}{fingerprint}{E2E_MEDIA_SUFFIX}")


def register_agent_seal_recipient(job_id, spki):
    """Remember that this job's outputs also seal to `spki` (a public SPKI).

    Public material only — safe to hold in memory. Bounded so a long-running
    gateway cannot grow this map without limit."""
    if not AGENT_DUAL_SEAL_ENABLED:
        return None
    job_id = str(job_id or "")
    spki = promptroutes.normalized_requester_spki(spki)
    if not job_id or not spki:
        return None
    with _agent_seal_lock:
        while len(_agent_seal_jobs) >= AGENT_SEAL_JOBS_MAX:
            _agent_seal_jobs.pop(next(iter(_agent_seal_jobs)))
        _agent_seal_jobs[job_id] = spki
    return spki


def agent_seal_recipient_for(job_id):
    if not AGENT_DUAL_SEAL_ENABLED or not job_id:
        return None
    with _agent_seal_lock:
        return _agent_seal_jobs.get(str(job_id))


# The gateway runs on the interpreter the stack pins (STUDIO_PYTHON), which is
# the one pyproject describes and the one that has `cryptography` — so sealing
# is an import, not a subprocess per output. The two remaining helpers below
# that DO need a separate process (the sheet composer, the RIFE pipeline) run on
# this same interpreter.
SUBPROCESS_PYTHON = os.environ.get("ZIMG_E2E_PYTHON") or sys.executable


def vault_public_key_spki():
    """The owner vault public key (base64url spki), or None until the browser
    has created a vault. Read directly from sqlite; cached against the DB mtime."""
    try:
        mtime = VAULT_DB.stat().st_mtime_ns if VAULT_DB.is_file() else None
    except OSError:
        return None
    if mtime == _vault_public_key_cache["mtime"]:
        return _vault_public_key_cache["spki"]
    spki = None
    if mtime is not None:
        try:
            connection = sqlite3.connect(VAULT_DB, timeout=10)
            try:
                row = connection.execute("SELECT identity_json FROM vault_identity WHERE id = 1").fetchone()
            finally:
                connection.close()
            if row:
                spki = json.loads(row[0]).get("public_key")
        except Exception as exc:
            print(f"[e2e-media] could not read vault public key: {exc}", file=sys.stderr)
    _vault_public_key_cache.update(mtime=mtime, spki=spki)
    return spki


def vault_identity_json():
    """The owner vault identity as stored — salt, wrapped keys, public key.
    Everything in it is public-or-wrapped material (vault_store rejects bare
    secrets), useless without the owner passphrase or recovery key. Served to
    token-authed clients (the mobile canvas) so they can unlock in-browser."""
    if not VAULT_DB.is_file():
        return None
    try:
        connection = sqlite3.connect(VAULT_DB, timeout=10)
        try:
            row = connection.execute("SELECT identity_json FROM vault_identity WHERE id = 1").fetchone()
        finally:
            connection.close()
        return json.loads(row[0]) if row else None
    except Exception as exc:
        print(f"[e2e-media] could not read vault identity: {exc}", file=sys.stderr)
        return None


def _seal_file_with_helper(spki, source, envelope, media_name):
    """Seal `source` to the public key `spki`, atomically writing the enc:v1
    envelope JSON to `envelope`. `media_name` drives the recorded media_type.
    The caller owns locking and deletion of the plaintext source."""
    source = Path(source)
    envelope = Path(envelope)
    tmp = envelope.with_name(envelope.name + f".{os.getpid()}.tmp")
    try:
        import media_seal

        sealed = media_seal.seal(source.read_bytes(), media_seal.load_public_key(spki))
        sealed["v"] = 1
        sealed["media_type"] = mimetypes.guess_type(media_name)[0] or "application/octet-stream"
        tmp.write_text(json.dumps(sealed), encoding="utf-8")
        os.replace(tmp, envelope)
    finally:
        try:
            tmp.unlink()
        except FileNotFoundError:
            pass


def seal_output_to_e2e(path, agent_spki=None):
    """Seal media to the owner vault public key as <name>.e2e; delete plaintext.

    When `agent_spki` is given, the SAME plaintext is additionally sealed to
    that public key as <name>.agent-<fp>.e2e before the plaintext is removed.
    The owner's envelope is unaffected either way. A failure to seal the agent
    copy is logged and swallowed: the owner's copy must never be lost because a
    secondary recipient failed.

    Returns True when sealed, False to fall back to legacy encryption (e.g. no
    vault exists yet). The gateway can encrypt here but can never decrypt.
    """
    path = Path(path).resolve()
    spki = vault_public_key_spki()
    if not spki:
        return False
    envelope = e2e_envelope_path_for(path)
    if envelope.exists() and not path.exists():
        return True
    if not path.exists() or not path.is_file():
        return False
    with encryption_lock:
        if envelope.exists() and not path.exists():
            return True
        source_stat = path.stat()
        _seal_file_with_helper(spki, path, envelope, path.name)
        os.utime(envelope, ns=(source_stat.st_atime_ns, source_stat.st_mtime_ns))
        agent_spki = promptroutes.normalized_requester_spki(agent_spki)
        if agent_spki and agent_spki != spki:
            agent_envelope = agent_envelope_path_for(path, promptroutes.requester_fingerprint(agent_spki))
            try:
                _seal_file_with_helper(agent_spki, path, agent_envelope, path.name)
                os.utime(agent_envelope, ns=(source_stat.st_atime_ns, source_stat.st_mtime_ns))
            except Exception as exc:
                print(f"[agent-seal] second recipient failed for {path.name}: {exc}", file=sys.stderr)
        try:
            path.unlink()
        except FileNotFoundError:
            pass
    return True


def encrypt_output_file(path, agent_spki=None):
    """Encrypt output media in place as <name>.zenc and remove plaintext.

    `agent_spki` (optional) adds a second sealed envelope for that recipient on
    the E2E path only — the legacy .zenc path is single-key by construction.

    Returns the logical original path (the filename the UI should keep using).
    """
    path = Path(path).resolve()
    if not is_encryptable_output(path):
        return path
    # Prefer client-side E2E sealing when enabled and a vault exists; otherwise
    # fall through to the legacy Keychain-key .zenc path unchanged.
    if E2E_MEDIA_ENABLED or e2e_envelope_path_for(path).exists():
        try:
            if seal_output_to_e2e(path, agent_spki=agent_spki):
                return path
        except Exception as exc:
            print(f"[e2e-media] seal failed for {path.name}; falling back: {exc}", file=sys.stderr)
    enc = encrypted_path_for(path)
    if enc.exists() and not path.exists():
        return path
    if not path.exists() or not path.is_file():
        return path
    password = output_encryption_password(create=True)
    tmp = enc.with_name(enc.name + f".{os.getpid()}.tmp")
    with encryption_lock:
        if enc.exists() and not path.exists():
            return path
        source_stat = path.stat()
        proc = subprocess.run(
            [
                "/usr/bin/openssl", "enc", "-aes-256-cbc", "-pbkdf2", "-iter", str(OUTPUT_ENCRYPTION_ITER),
                "-salt", "-in", str(path), "-out", str(tmp), "-pass", "stdin",
            ],
            input=password + "\n",
            text=True,
            capture_output=True,
            timeout=120,
        )
        if proc.returncode != 0 or not tmp.exists() or tmp.stat().st_size < 32:
            try:
                tmp.unlink(missing_ok=True)
            except Exception:
                pass
            raise RuntimeError(f"failed to encrypt output media {path.name}")
        os.replace(tmp, enc)
        os.utime(enc, ns=(source_stat.st_atime_ns, source_stat.st_mtime_ns))
        try:
            path.unlink()
        except FileNotFoundError:
            pass
    return path


def decrypt_output_bytes(path):
    """Read plaintext image bytes from a plaintext path or encrypted sidecar."""
    path = Path(path).resolve()
    if path.exists() and path.is_file():
        return path.read_bytes(), mimetypes.guess_type(str(path))[0] or "application/octet-stream"
    enc = encrypted_path_for(path)
    if not enc.exists() or not enc.is_file():
        raise FileNotFoundError(str(path))
    password = output_encryption_password(create=False)
    if not password:
        raise RuntimeError("output encryption key unavailable")
    proc = subprocess.run(
        [
            "/usr/bin/openssl", "enc", "-d", "-aes-256-cbc", "-pbkdf2", "-iter", str(OUTPUT_ENCRYPTION_ITER),
            "-in", str(enc), "-pass", "stdin",
        ],
        input=(password + "\n").encode("utf-8"),
        text=False,
        capture_output=True,
        timeout=120,
    )
    if proc.returncode != 0:
        raise RuntimeError("failed to decrypt output image")
    return proc.stdout, mimetypes.guess_type(str(path))[0] or "application/octet-stream"


def encrypt_outputs(paths, job_id=None):
    """Seal every output of a finished job.

    `job_id` is what ties an output back to the agent that asked for it: when
    that job registered a requester key at submit, each output gets a second
    envelope sealed to it. Without a job id (or without a registered key) this
    behaves exactly as before — owner-only."""
    agent_spki = agent_seal_recipient_for(job_id)
    out = []
    for p in paths or []:
        path = Path(p).expanduser().resolve()
        try:
            out.append(str(encrypt_output_file(path, agent_spki=agent_spki).resolve()))
        except Exception as e:
            if is_encryptable_output(path):
                try:
                    path.unlink(missing_ok=True)
                except OSError:
                    pass
            raise RuntimeError(f"output encryption failed for {path.name}") from e
    return out


def find_output_logical_path(name):
    name = util.safe_name(name)
    if not name:
        return None
    for root in [config.OUT_DIR, config.COMFY_OUTPUT_DIR, config.DEBUG_OUTPUT_DIR]:
        root = root.resolve()
        candidates = [root / name, root / f"{name}{OUTPUT_ENCRYPTION_SUFFIX}", root / f"{name}{E2E_MEDIA_SUFFIX}"]
        for candidate in candidates:
            logical = logical_path_for_encrypted(candidate).resolve()
            existing = candidate.resolve()
            if str(logical).startswith(str(root)) and (
                existing.exists() or encrypted_path_for(logical).exists() or e2e_envelope_path_for(logical).exists()
            ):
                return logical
        try:
            matches = []
            for x in root.rglob("*"):
                if not x.is_file():
                    continue
                logical = logical_path_for_encrypted(x).resolve()
                if logical.name == name:
                    matches.append(logical)
            if matches:
                return matches[0]
        except Exception:
            continue
    return None


def find_exact_output_logical_path(value):
    try:
        logical = logical_path_for_encrypted(Path(value).expanduser()).resolve()
    except Exception:
        return None
    if logical.suffix.lower() not in OUTPUT_MEDIA_EXTS:
        return None
    if not any(util._is_under(logical, root) for root in [config.OUT_DIR, config.COMFY_OUTPUT_DIR]):
        return None
    # plaintext, legacy .zenc, or E2E .e2e — an E2E-only output must still
    # resolve or its history thumbnail 404s.
    if existing_output_path(logical):
        return logical
    return None


def send_output_file(handler, path):
    path = encrypt_output_file(path)
    envelope = e2e_envelope_path_for(Path(path))
    # Same URL, recipient chosen by the key the caller presents: an agent that
    # sends its own X-E2E-Requester-Pub gets the envelope sealed to that key.
    # Serving it leaks nothing — only the matching private key opens it — and
    # the owner's browser, which presents no such header, is unaffected.
    agent_spki = promptroutes.normalized_requester_spki(handler.headers.get(promptroutes.REQUESTER_PUB_HEADER))
    if AGENT_DUAL_SEAL_ENABLED and agent_spki:
        agent_envelope = agent_envelope_path_for(Path(path), promptroutes.requester_fingerprint(agent_spki))
        if agent_envelope.is_file():
            envelope = agent_envelope
    if envelope.is_file():
        # Client-side E2E: the gateway holds no key for this file. Hand the
        # sealed envelope to the browser, which decrypts it with the vault
        # private key. A legacy client that ignores X-E2E-Media simply can't
        # render it — by design, only the owner's browser can.
        data = envelope.read_bytes()
        handler.send_response(200)
        handler.cors_headers()
        handler.send_header("Content-Type", "application/vnd.hivemind.e2e+json")
        handler.send_header("X-E2E-Media", "1")
        handler.send_header("Cache-Control", "private, no-store, max-age=0")
        handler.send_header("Pragma", "no-cache")
        handler.send_header("Content-Length", str(len(data)))
        handler.end_headers()
        handler.wfile.write(data)
        return
    data, ctype = decrypt_output_bytes(path)
    handler.send_response(200)
    handler.cors_headers()
    handler.send_header("Content-Type", ctype)
    handler.send_header("Cache-Control", "private, no-store, max-age=0")
    handler.send_header("Pragma", "no-cache")
    handler.send_header("Content-Length", str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)


def encrypt_existing_outputs_once(max_age_seconds=3):
    if not OUTPUT_ENCRYPTION_ENABLED:
        return 0
    now = time.time()
    changed = 0
    for root in [config.OUT_DIR, config.COMFY_OUTPUT_DIR]:
        try:
            if not root.exists():
                continue
            for p in root.rglob("*"):
                if not p.is_file() or not is_encryptable_output(p):
                    continue
                try:
                    # Avoid racing a writer that is still flushing the file.
                    if now - p.stat().st_mtime < max_age_seconds:
                        continue
                    encrypt_output_file(p)
                    changed += 1
                except Exception as e:
                    print(f"[output-encryption] sweeper skipped {p.name}: {e}", file=sys.stderr)
        except Exception as e:
            print(f"[output-encryption] sweeper failed for {root}: {e}", file=sys.stderr)
    return changed


def output_encryption_sweeper():
    while True:
        try:
            encrypt_existing_outputs_once(max_age_seconds=OUTPUT_PLAINTEXT_GRACE_SECONDS)
        except Exception as e:
            print(f"[output-encryption] sweeper error: {e}", file=sys.stderr)
        time.sleep(5)


def output_file_records(limit=200):
    """Fallback history from image files that exist on disk.

    ComfyUI writes current generations to its private output directory, while
    older wrapper records live in history.jsonl and may point at the wrapper's
    private copy directory.  The UI should still show past generations when the
    prompt history is empty/stale, so synthesize redacted records from files.
    """
    paths = []
    for root in [config.COMFY_OUTPUT_DIR, config.OUT_DIR]:
        try:
            if root.exists():
                for p in root.rglob("*"):
                    if not p.is_file():
                        continue
                    logical = logical_path_for_encrypted(p)
                    if logical.name.startswith("."):
                        continue
                    if logical.suffix.lower() in OUTPUT_MEDIA_EXTS:
                        paths.append(logical)
        except Exception:
            continue
    def _mtime(x):
        physical = existing_output_path(x)
        try:
            return physical.stat().st_mtime if physical else 0
        except OSError:
            return 0

    records = []
    for p in sorted(set(paths), key=_mtime, reverse=True)[:limit]:
        physical = existing_output_path(p)
        if physical is None:
            continue
        try:
            st = physical.stat()
        except Exception:
            continue
        indexed = workflow_index.workflow_index_record_for_filename(p.name) or {}
        indexed_prompt_id = indexed.get("prompt_id") if isinstance(indexed.get("prompt_id"), str) else None
        indexed_recorded_at = indexed.get("recorded_at") if isinstance(indexed.get("recorded_at"), str) else None
        timestamp = indexed_recorded_at or datetime.fromtimestamp(st.st_mtime, timezone.utc).isoformat()
        records.append({
            "id": indexed_prompt_id or f"file-{hashlib.sha1(str(p).encode('utf-8')).hexdigest()[:12]}",
            "prompt": history.PRIVATE_PROMPT_LABEL,
            "status": "success",
            "created_at": timestamp,
            "finished_at": timestamp,
            "outputs": [str(p.resolve())],
            "source": "files",
            **({"lane": indexed.get("lane")} if indexed.get("lane") else {}),
            **({"indexed_prompt_id": indexed_prompt_id} if indexed_prompt_id else {}),
        })
    return records


def stage_inline_image_base64(value):
    if not isinstance(value, str) or not value.strip():
        return None
    encoded = value.strip()
    extension = ".png"
    if encoded.startswith("data:"):
        match = re.match(r"^data:(image/[a-zA-Z0-9.+-]+);base64,(.*)$", encoded, flags=re.DOTALL)
        if not match:
            raise ValueError("image_base64 must be raw base64 or an image data URL")
        mime, encoded = match.groups()
        extension = {
            "image/jpeg": ".jpg",
            "image/jpg": ".jpg",
            "image/webp": ".webp",
            "image/png": ".png",
        }.get(mime.lower(), ".png")
    try:
        payload = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("image_base64 is not valid base64") from exc
    if not payload:
        raise ValueError("image_base64 decoded to an empty image")
    if len(payload) > 20 * 1024 * 1024:
        raise ValueError("decoded inline image exceeds 20MB")
    config.COMFY_INPUT_DIR.mkdir(parents=True, exist_ok=True)
    target = config.COMFY_INPUT_DIR / f"media-studio-inline-{uuid.uuid4().hex[:16]}{extension}"
    target.write_bytes(payload)
    return target


def _reference_image_path(value):
    """A caller-named reference path; a bare name is ComfyUI-input-relative."""
    path = Path(str(value)).expanduser()
    return path if path.is_absolute() else config.COMFY_INPUT_DIR / str(value)


def collect_reference_image_paths(data, uploaded_image=None):
    """Every reference a generation request attached, in the order it sent them.

    Order is load-bearing for lanes that address references by index (H3 names
    them <Picture 1>..<Picture N>), so this preserves the caller's sequence:
    the inline/multipart image first, then image_path, then the images_base64
    and image_paths lists. Duplicates drop to their first position. Raises
    ValueError when an inline image cannot be decoded.
    """
    paths = [uploaded_image] if uploaded_image is not None else []
    if isinstance(data, dict):
        maybe_image = str(data.get('image_path', '') or '')
        if maybe_image:
            paths.append(_reference_image_path(maybe_image))
        extra_b64 = data.get('images_base64')
        if isinstance(extra_b64, list):
            for value in extra_b64:
                staged = stage_inline_image_base64(value)
                if staged is not None:
                    paths.append(staged)
        extra_paths = data.get('image_paths')
        if isinstance(extra_paths, list):
            for value in extra_paths:
                text = str(value or '').strip()
                if text:
                    paths.append(_reference_image_path(text))
    seen = set()
    deduped = []
    for path in paths:
        resolved = str(Path(path).resolve())
        if resolved not in seen:
            seen.add(resolved)
            deduped.append(Path(resolved))
    return deduped
