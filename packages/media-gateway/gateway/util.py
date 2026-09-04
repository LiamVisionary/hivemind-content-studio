"""Small shared helpers: timestamps, safe names, atomic writes, option coercion."""
import html
import json
import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def safe_name(name):
    return re.sub(r"[^A-Za-z0-9_.-]", "_", name)


def redact_access_log_message(value):
    return re.sub(
        r"(?i)([?&](?:token|access_token|api_key|key)=)[^&\s\"]*",
        lambda match: match.group(1) + "%5Bredacted%5D",
        str(value),
    )


def _is_under(path, root):
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except Exception:
        return False


def write_json_atomic(path, payload, *, indent=None):
    """Write a state file so a crash can never leave half of one behind.

    The loaders here treat unparseable state as absent — load_download_jobs()
    returns {} on a JSONDecodeError — so a truncated write is not a corrupt
    file, it is a silently emptied queue. Same tmp+os.replace as the route
    store has always used; every JSON state file gets it now.
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=indent)
        handle.flush()
        os.fsync(handle.fileno())
    try:
        os.replace(temporary, path)
    except OSError:
        # The previous file is still whole; take the half-written one with us
        # rather than leaving it for a directory listing to trip over.
        try:
            temporary.unlink()
        except OSError:
            pass
        raise


def _atomic_write_jsonl(path, records):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        for record in records:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def h(value):
    return html.escape(str(value or ""))


def json_safe_text(value, limit=2000):
    text = str(value or "")[-limit:]
    return "".join(ch if ch in "\t\n\r" or ord(ch) >= 32 else "" for ch in text)


def nice_time(value):
    if not value:
        return ""
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return dt.astimezone().strftime("%b %-d, %-I:%M %p")
    except Exception:
        return str(value)


def int_option(options, key, default, lo, hi):
    try:
        value = int(options.get(key, default))
    except Exception:
        value = default
    return max(lo, min(hi, value))


def int_quality_option(options, key, default):
    try:
        value = int(round(float(options.get(key, default))))
        return value if value > 0 else default
    except Exception:
        return default


def float_quality_option(options, key, default):
    try:
        value = float(options.get(key, default))
        return value if value == value else default
    except Exception:
        return default


def float_option(options, key, default, lo, hi):
    try:
        value = float(options.get(key, default))
    except Exception:
        value = default
    return max(lo, min(hi, value))


def bool_option(options, key, default):
    value = options.get(key, default)
    if isinstance(value, str):
        return value.strip().lower() not in {"0", "false", "no", "off", ""}
    return bool(value)


def human_bytes(n):
    try: n = float(n)
    except Exception: return '0 B'
    units = ['B','KB','MB','GB','TB']
    i = 0
    while n >= 1024 and i < len(units)-1:
        n /= 1024; i += 1
    return f"{n:.1f} {units[i]}" if i else f"{int(n)} B"
