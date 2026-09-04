"""The machine's settings: one typed allow-list, one document, one precedence.

A packaged app has no shell. Every machine-level knob in this studio used to be
an environment variable, which meant a person who wanted their models on an
external drive, a different control port, or output encryption off had exactly
one route: open a terminal, write ``stack-local.env`` by hand, restart launchd.
That is not a route a downloaded app has.

So this module is the allow-list of what a person may change, typed:

* a dataclass per section (``paths``, ``lanes``, ``network``, ``privacy``,
  ``reaper``), and one :class:`Setting` spec per key carrying its default, its
  environment-variable names, its validation and whether changing it needs a
  restart;
* **secrets are structurally excluded** — :func:`_reject_secret_names` runs at
  import and refuses any spec whose key or environment name reads like a
  credential, so "the settings document must never hold a secret" is a property
  of the schema rather than a rule someone has to remember;
* one document at :func:`settings_path`, which lives with the machine state
  (not with a git checkout) so the bash supervisor and the packaged app read
  the *same* file.

## Precedence, and why every read reports its source

``environment > document > default``. The environment has to keep winning: the
developer stack, CI and a rented lane all set these names, and a settings file
that silently overrode them would break the machine that wrote it. But a person
who sets a value in the app and sees no change deserves to be told why, so
every key reports where its effective value came from:

* ``default`` — nothing set it,
* ``file``   — this document set it (including when the supervisor exported it
  into the environment from this same document, which is why the comparison is
  by value rather than by "is the variable set"),
* ``env``    — something in the environment is pinning a *different* value than
  the document holds. That is the one case a user cannot fix from the app, and
  it is the case the UI has to name.
"""

from __future__ import annotations

import json
import os
import re
import shlex
from dataclasses import dataclass, fields
from pathlib import Path
from typing import Any, Callable, Mapping

from .config import app_dirs, media_state_root

SETTINGS_FORMAT = 1
# Anything that reads like a credential may not become a settings key. PassBook
# owns secrets; this document is world-readable machine configuration.
SECRET_NAME = re.compile(r"key|token|secret|password|passphrase|credential|auth", re.IGNORECASE)


class SettingsError(ValueError):
    """A value a person typed that this machine cannot use.

    The message is the sentence shown to them, so it names the value and what
    would be acceptable instead — never a traceback and never a bare "invalid".
    """


def settings_path() -> Path:
    """Where the document lives.

    With the machine state, not with the code: a developer checkout and the
    packaged app are the same machine and must not disagree about which port
    the studio uses. In a packaged build this is exactly ``<data_dir>/settings.json``
    because the data dir already resolves under the media-studio root.
    """
    override = os.environ.get("CONTENT_STUDIO_SETTINGS_FILE", "").strip()
    if override:
        return Path(override).expanduser()
    return media_state_root() / "content-studio" / "settings.json"


# ── the typed sections ──────────────────────────────────────────────────────


@dataclass(frozen=True)
class PathSettings:
    """Where big things live. Every one of these needs a restart: the engines
    read their roots once, at boot, in five separate processes."""

    data_dir: Path
    runs_dir: Path
    models_root: Path
    output_root: Path
    model_cache_dir: Path


@dataclass(frozen=True)
class LaneSettings:
    """Optional engines. Off is a working studio, not a broken one."""

    ltx: bool
    flux2_server: bool
    apple_silicon_optimizations: bool


@dataclass(frozen=True)
class NetworkSettings:
    """Where the studio's own parts answer.

    These were five hard-coded loopback literals scattered through the package,
    which is fine until a port collides or a gateway moves to another machine.
    """

    control_host: str
    control_port: int
    gateway_url: str
    upload_base: str
    bridge_url: str
    mcp_url: str
    comfy_url: str


@dataclass(frozen=True)
class PrivacySettings:
    """Encryption at rest. On by default and stays that way unless asked."""

    output_encryption: bool
    agent_dual_seal: bool


@dataclass(frozen=True)
class ReaperSettings:
    """The rental reaper. A box that failed provisioning bills like one that
    works, so this is money, not housekeeping."""

    autoreap: bool
    grace_seconds: int
    bad_machine_hours: int


@dataclass(frozen=True)
class StudioSettings:
    paths: PathSettings
    lanes: LaneSettings
    network: NetworkSettings
    privacy: PrivacySettings
    reaper: ReaperSettings


SECTION_TYPES: dict[str, type] = {
    "paths": PathSettings,
    "lanes": LaneSettings,
    "network": NetworkSettings,
    "privacy": PrivacySettings,
    "reaper": ReaperSettings,
}

SECTION_LABELS: dict[str, str] = {
    "paths": "Models & storage",
    "lanes": "Engines",
    "network": "Network",
    "privacy": "Privacy & vault",
    "reaper": "Rented GPUs",
}


# ── the spec ────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Setting:
    key: str
    kind: str  # "path" | "url" | "bool" | "int" | "text"
    env: tuple[str, ...]
    default: Any | Callable[[], Any]
    restart_required: bool
    summary: str
    minimum: int = 0
    maximum: int = 0
    # What docs/SETTINGS.md prints instead of this machine's own answer, for the
    # defaults that are derived from where the app happens to be installed. The
    # generated file has to be identical on every machine or it cannot be
    # checked in, let alone checked.
    doc_default: str = ""

    @property
    def section(self) -> str:
        return self.key.split(".", 1)[0]

    @property
    def field(self) -> str:
        return self.key.split(".", 1)[1]

    def default_value(self) -> Any:
        # Never checked against the filesystem: a Mac with no ComfyUI checkout
        # still has to boot, and the default is what it boots with.
        raw = self.default() if callable(self.default) else self.default
        return self.coerce(raw, strict=False)

    # ── validation ──
    def coerce(self, raw: Any, *, strict: bool = True) -> Any:
        """Turn whatever was written down into this key's type, or refuse it
        with a sentence that says what would be acceptable."""
        if self.kind == "bool":
            return _as_bool(raw, self.key)
        if self.kind == "int":
            return _as_int(raw, self)
        if self.kind == "path":
            return _as_path(raw, self.key, strict=strict)
        if self.kind == "url":
            return _as_url(raw, self.key)
        text = str(raw).strip()
        if not text:
            raise SettingsError(f"{self.key} cannot be empty.")
        return text

    def serialize(self, value: Any) -> Any:
        """The JSON form: paths become strings, everything else is already JSON."""
        return str(value) if isinstance(value, Path) else value


def _as_bool(raw: Any, key: str) -> bool:
    if isinstance(raw, bool):
        return raw
    text = str(raw).strip().lower()
    if text in {"1", "true", "yes", "on"}:
        return True
    if text in {"0", "false", "no", "off"}:
        return False
    raise SettingsError(f"{key} must be on or off, not {raw!r}.")


def _as_int(raw: Any, spec: "Setting") -> int:
    try:
        value = int(str(raw).strip())
    except (TypeError, ValueError):
        raise SettingsError(f"{spec.key} must be a whole number, not {raw!r}.") from None
    if spec.maximum and not (spec.minimum <= value <= spec.maximum):
        raise SettingsError(f"{spec.key} must be between {spec.minimum} and {spec.maximum}.")
    return value


def _as_path(raw: Any, key: str, *, strict: bool = True) -> Path:
    text = str(raw).strip()
    if not text or "\x00" in text:
        raise SettingsError(f"{key} needs a folder path.")
    path = Path(text).expanduser()
    if not path.is_absolute():
        raise SettingsError(f"{key} needs a full path starting at / or ~, not {text!r}.")
    # A typo'd volume name is the failure this catches: the folder itself may
    # not exist yet (the studio creates its own), but the place it would go has
    # to, or the setting saves and nothing ever appears there.
    if strict and not path.exists() and not path.parent.is_dir():
        raise SettingsError(f"There is no folder at {path.parent} to put {path.name} in.")
    return path


def _as_url(raw: Any, key: str) -> str:
    text = str(raw).strip().rstrip("/")
    if not text:
        raise SettingsError(f"{key} needs an address.")
    match = re.fullmatch(r"(https?)://([^/\s?#]+)(/[^\s?#]*)?", text)
    if not match:
        raise SettingsError(f"{key} must be a http:// or https:// address, not {raw!r}.")
    return text


def _comfy_private_root() -> Path:
    return Path(os.environ.get("COMFY_PRIVATE_ROOT", Path.home() / ".comfy-private.noindex")).expanduser()


SETTINGS: tuple[Setting, ...] = (
    # ── paths ──
    Setting(
        key="paths.data_dir",
        kind="path",
        env=("CONTENT_STUDIO_DATA_DIR",),
        default=lambda: app_dirs().data_dir,
        restart_required=True,
        summary="Where the studio keeps its own state — runs, jobs, the account vaults.",
        doc_default="<repo>/data in a checkout, ~/.hivemindos/media-studio/content-studio in the app",
    ),
    Setting(
        key="paths.runs_dir",
        kind="path",
        env=("CONTENT_STUDIO_RUNS_DIR",),
        default=lambda: app_dirs().data_dir / "runs",
        restart_required=True,
        summary="Where production runs are written.",
        doc_default="<data dir>/runs",
    ),
    Setting(
        key="paths.models_root",
        kind="path",
        env=("COMFY_DIR",),
        default=lambda: Path.home() / "comfy" / "ComfyUI",
        restart_required=True,
        summary="The ComfyUI folder whose models/ subtree holds the local weights.",
        doc_default="~/comfy/ComfyUI",
    ),
    Setting(
        key="paths.output_root",
        kind="path",
        env=("ZIMG_OUTPUT_DIR",),
        default=lambda: _comfy_private_root() / "z_image_outputs",
        restart_required=True,
        summary="Where finished images and video land on disk.",
        doc_default="~/.comfy-private.noindex/z_image_outputs",
    ),
    Setting(
        key="paths.model_cache_dir",
        kind="path",
        env=("HF_HOME",),
        default=lambda: Path.home() / ".cache" / "huggingface",
        restart_required=True,
        summary="The download cache for models fetched from Hugging Face.",
        doc_default="~/.cache/huggingface",
    ),
    # ── lanes ──
    Setting(
        key="lanes.ltx",
        kind="bool",
        env=("COMFY_ENABLE_LTX_LANE",),
        default=False,
        restart_required=True,
        summary="Run the dedicated LTX video lane on this machine.",
    ),
    Setting(
        key="lanes.flux2_server",
        kind="bool",
        env=("ZIMG_ENABLE_FLUX2_SERVER",),
        default=False,
        restart_required=True,
        summary="Keep the Swift/MLX Flux 2 image server warm.",
    ),
    Setting(
        key="lanes.apple_silicon_optimizations",
        kind="bool",
        env=("ZIMG_ENABLE_APPLE_SILICON_OPTIMIZATIONS",),
        default=True,
        restart_required=True,
        summary="Use the Apple Silicon tuning for the local lanes.",
    ),
    # ── network ──
    Setting(
        key="network.control_host",
        kind="text",
        env=("CONTENT_STUDIO_CONTROL_HOST",),
        default="127.0.0.1",
        restart_required=True,
        summary="The address the studio itself listens on.",
    ),
    Setting(
        key="network.control_port",
        kind="int",
        env=("CONTENT_STUDIO_CONTROL_PORT",),
        default=8765,
        restart_required=True,
        summary="The port the studio itself listens on. Change it when something else already has 8765.",
        minimum=1024,
        maximum=65535,
    ),
    Setting(
        key="network.gateway_url",
        kind="url",
        env=("CONTENT_STUDIO_GATEWAY_URL", "ZIMG_GATEWAY_URL", "MEDIA_STUDIO_BACKEND_URL"),
        default="http://127.0.0.1:8787",
        restart_required=False,
        summary="Where the media gateway answers.",
    ),
    Setting(
        key="network.upload_base",
        kind="url",
        env=("MEDIA_STUDIO_UPLOAD_BASE", "MEDIA_STUDIO_STUDIO_URL", "ZIMG_STUDIO_URL"),
        default="http://127.0.0.1:8788",
        restart_required=False,
        summary="Where references are uploaded for the Canvas and the agent tools.",
    ),
    Setting(
        key="network.bridge_url",
        kind="url",
        env=("OPEN_GENERATIVE_AI_URL", "OGA_URL"),
        default="http://127.0.0.1:8794",
        restart_required=False,
        summary="Where the local-inference bridge answers.",
    ),
    Setting(
        key="network.mcp_url",
        kind="url",
        env=("MEDIA_STUDIO_MCP_URL",),
        default="http://127.0.0.1:8796/mcp",
        restart_required=False,
        summary="Where agents reach this machine's media tools.",
    ),
    Setting(
        key="network.comfy_url",
        kind="url",
        env=("COMFY_HTTP_DEFAULT", "COMFY_HTTP", "COMFYUI_URL"),
        default="http://127.0.0.1:8188",
        restart_required=False,
        summary="Your own ComfyUI. The studio attaches to it and never starts or stops it.",
    ),
    # ── privacy ──
    Setting(
        key="privacy.output_encryption",
        kind="bool",
        env=("ZIMG_OUTPUT_ENCRYPTION",),
        default=True,
        restart_required=True,
        summary="Encrypt finished media at rest. Off writes plain files anyone on this Mac can open.",
    ),
    Setting(
        key="privacy.agent_dual_seal",
        kind="bool",
        env=("ZIMG_AGENT_DUAL_SEAL",),
        default=False,
        restart_required=True,
        summary="Also seal agent-requested outputs to the agent that asked for them.",
    ),
    # ── reaper ──
    Setting(
        key="reaper.autoreap",
        kind="bool",
        env=("HIVEMIND_RENTAL_AUTOREAP",),
        default=True,
        restart_required=False,
        summary="Destroy a rented box that failed to provision. Off keeps it billing so you can SSH in.",
    ),
    Setting(
        key="reaper.grace_seconds",
        kind="int",
        env=("HIVEMIND_RENTAL_REAP_GRACE",),
        default=60,
        restart_required=False,
        summary="How long a failed box is left alone before it is destroyed.",
        minimum=0,
        maximum=86400,
    ),
    Setting(
        key="reaper.bad_machine_hours",
        kind="int",
        env=("HIVEMIND_RENTAL_BAD_MACHINE_HOURS",),
        default=24,
        restart_required=False,
        summary="How long a host that just failed stays out of the running.",
        minimum=0,
        maximum=8760,
    ),
)

SETTINGS_BY_KEY: dict[str, Setting] = {spec.key: spec for spec in SETTINGS}


def _reject_secret_names(specs: tuple[Setting, ...]) -> None:
    """Structural exclusion, checked at import.

    A settings document is machine configuration a support engineer may be
    asked to paste. The moment one credential-shaped key is allowed into it,
    "never returns a secret" becomes a review rule instead of a fact.
    """
    for spec in specs:
        names = (spec.key, *spec.env)
        for name in names:
            if SECRET_NAME.search(name):
                raise RuntimeError(
                    f"{spec.key} looks like a credential ({name}). Secrets belong in PassBook, "
                    "never in the settings document."
                )
    # Every declared dataclass field must have a spec, or a section could report
    # a value nobody can see the provenance of.
    for section, section_type in SECTION_TYPES.items():
        for field_def in fields(section_type):
            if f"{section}.{field_def.name}" not in SETTINGS_BY_KEY:
                raise RuntimeError(f"{section}.{field_def.name} has no Setting spec")


_reject_secret_names(SETTINGS)


# ── the document ────────────────────────────────────────────────────────────


def read_document(path: Path | None = None) -> dict[str, Any]:
    """The stored values, or an empty document. Never raises on a broken file.

    A settings file that cannot be parsed must not stop the studio from
    booting; the app falls back to defaults and the Settings page says so.
    """
    target = Path(path) if path is not None else settings_path()
    try:
        raw = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(raw, dict):
        return {}
    values = raw.get("values")
    return {str(k): v for k, v in values.items()} if isinstance(values, dict) else {}


def document_is_readable(path: Path | None = None) -> bool:
    """False only when a file exists and cannot be parsed — the one case worth
    telling someone about, because their edits are being ignored."""
    target = Path(path) if path is not None else settings_path()
    if not target.exists():
        return True
    try:
        json.loads(target.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    return True


def write_document(values: Mapping[str, Any], path: Path | None = None) -> Path:
    target = Path(path) if path is not None else settings_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    payload = {"version": SETTINGS_FORMAT, "values": dict(sorted(values.items()))}
    temporary = target.with_name(f"{target.name}.tmp")
    temporary.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(target)
    return target


# ── resolution ──────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ResolvedSetting:
    spec: Setting
    value: Any
    source: str  # "default" | "file" | "env"
    env_name: str  # the variable pinning it, when source == "env"
    invalid: str  # why a stored value was ignored, when it was


def resolve(
    *,
    env: Mapping[str, str] | None = None,
    document: Mapping[str, Any] | None = None,
) -> dict[str, ResolvedSetting]:
    """Resolve every key: environment over document over default."""
    environ = os.environ if env is None else env
    stored = read_document() if document is None else document
    resolved: dict[str, ResolvedSetting] = {}
    for spec in SETTINGS:
        default = spec.default_value()
        invalid = ""

        file_value: Any = None
        has_file = spec.key in stored
        if has_file:
            try:
                file_value = spec.coerce(stored[spec.key])
            except SettingsError as exc:
                has_file, invalid = False, str(exc)

        env_value: Any = None
        env_name = ""
        for name in spec.env:
            raw = environ.get(name)
            if raw is None or not str(raw).strip():
                continue
            try:
                env_value, env_name = spec.coerce(raw), name
            except SettingsError as exc:
                # A hostile or stale environment must not stop the studio; the
                # value is dropped and the reason is carried to the UI.
                invalid = invalid or f"{name}: {exc}"
                continue
            break

        if env_name:
            value, source = env_value, "env"
        elif has_file:
            value, source = file_value, "file"
        else:
            value, source = default, "default"

        # The supervisor exports this document into the environment for the
        # children, so "the variable is set" is not evidence of an override —
        # only a DIFFERENT value is.
        if source == "env" and has_file and file_value == env_value:
            source, env_name = "file", ""

        resolved[spec.key] = ResolvedSetting(
            spec=spec, value=value, source=source, env_name=env_name, invalid=invalid
        )
    return resolved


def build(resolved: Mapping[str, ResolvedSetting]) -> StudioSettings:
    sections: dict[str, Any] = {}
    for section, section_type in SECTION_TYPES.items():
        sections[section] = section_type(
            **{f.name: resolved[f"{section}.{f.name}"].value for f in fields(section_type)}
        )
    return StudioSettings(**sections)


def load_settings(
    *,
    env: Mapping[str, str] | None = None,
    document: Mapping[str, Any] | None = None,
) -> StudioSettings:
    return build(resolve(env=env, document=document))


_cache: tuple[tuple[Any, ...], StudioSettings] | None = None


def settings() -> StudioSettings:
    """The effective settings, re-read when the document or the environment
    changes underneath us.

    Callers reach for this on every request (the bridge proxy, the Comfy lane
    resolver), so it is cached on the document's stat plus a cheap fingerprint
    of the environment names that matter — the file is written by another
    process (the Settings page, or the supervisor) often enough that a
    process-lifetime cache would serve a stale port.
    """
    global _cache
    path = settings_path()
    try:
        stat = path.stat()
        stamp: tuple[Any, ...] = (str(path), stat.st_mtime_ns, stat.st_size)
    except OSError:
        stamp = (str(path), 0, 0)
    stamp = stamp + tuple(os.environ.get(name, "") for spec in SETTINGS for name in spec.env)
    if _cache is not None and _cache[0] == stamp:
        return _cache[1]
    value = load_settings()
    _cache = (stamp, value)
    return value


def forget_cached_settings() -> None:
    """Drop the cache. Tests and the PUT route call this; nothing else has to."""
    global _cache
    _cache = None


# ── the API payload ─────────────────────────────────────────────────────────


def describe(
    *,
    env: Mapping[str, str] | None = None,
    document: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """What GET /api/settings answers: every key, its effective value, and
    where that value came from. Never a secret — see :func:`_reject_secret_names`."""
    resolved = resolve(env=env, document=document)
    rows = []
    for spec in SETTINGS:
        entry = resolved[spec.key]
        rows.append(
            {
                "key": spec.key,
                "section": spec.section,
                "field": spec.field,
                "kind": spec.kind,
                "value": spec.serialize(entry.value),
                "default": spec.serialize(spec.default_value()),
                "source": entry.source,
                "restart_required": spec.restart_required,
                "env": list(spec.env),
                "env_override": entry.env_name,
                "summary": spec.summary,
                **({"invalid": entry.invalid} if entry.invalid else {}),
                **({"minimum": spec.minimum, "maximum": spec.maximum} if spec.kind == "int" and spec.maximum else {}),
            }
        )
    return {
        "version": SETTINGS_FORMAT,
        "path": str(settings_path()),
        "readable": document_is_readable(),
        "sections": [{"id": key, "label": label} for key, label in SECTION_LABELS.items()],
        "settings": rows,
    }


def apply(
    values: Mapping[str, Any],
    *,
    reset: tuple[str, ...] | list[str] = (),
    path: Path | None = None,
) -> dict[str, Any]:
    """Validate a change, write the document, and say what it will take.

    Returns the same payload as :func:`describe` plus ``restart_required`` (the
    keys whose new value only lands on the next start) and ``pinned`` (keys an
    environment variable is still overriding — the one outcome a person cannot
    fix from this page, so it is named rather than silently ignored).
    """
    unknown = [key for key in (*values.keys(), *reset) if key not in SETTINGS_BY_KEY]
    if unknown:
        raise SettingsError(f"This machine has no setting called {unknown[0]}.")

    before = resolve(document=read_document(path))
    stored = dict(read_document(path))
    coerced: dict[str, Any] = {}
    for key, raw in values.items():
        spec = SETTINGS_BY_KEY[key]
        coerced[key] = spec.coerce(raw)
        stored[key] = spec.serialize(coerced[key])
    for key in reset:
        stored.pop(key, None)

    written = write_document(stored, path)
    forget_cached_settings()
    after = resolve(document=read_document(path))

    changed = [key for key in (*values.keys(), *reset) if before[key].value != after[key].value]
    return {
        **describe(document=read_document(path)),
        "path": str(written),
        "changed": changed,
        "restart_required": sorted(key for key in changed if SETTINGS_BY_KEY[key].restart_required),
        "pinned": sorted(key for key in values if after[key].source == "env"),
    }


# ── the supervisor's half ───────────────────────────────────────────────────


def exported_env(document: Mapping[str, Any] | None = None) -> dict[str, str]:
    """The document as environment variables, for processes that only read env.

    The gateway, the bridge and ComfyUI never see this file; the supervisor
    exports it for them. Only keys the document actually sets are exported, so
    a value nobody chose never becomes an override on a machine that inherited
    a real one.
    """
    stored = read_document() if document is None else document
    exported: dict[str, str] = {}
    for spec in SETTINGS:
        if spec.key not in stored:
            continue
        try:
            value = spec.coerce(stored[spec.key])
        except SettingsError:
            continue
        if spec.kind == "bool":
            exported[spec.env[0]] = "1" if value else "0"
        else:
            exported[spec.env[0]] = str(value)
    return exported


def _docs() -> str:
    lines = [
        "# Settings",
        "",
        "Generated from `src/hivemind_content_studio/settings.py` — run",
        "`python -m hivemind_content_studio.settings --docs > docs/SETTINGS.md` after changing the schema.",
        "",
        "Every row here is changeable in the app: **Settings** in the Advanced group, or ⌘,.",
        "The document is written to `<media state>/content-studio/settings.json`",
        "(`CONTENT_STUDIO_SETTINGS_FILE` moves it) and the bash supervisor exports the same",
        "document for the servers that only read environment variables.",
        "",
        "Precedence is **environment > document > default**, and the Settings page reports which",
        "one each value came from, so a variable pinned in `stack-local.env` is visible rather",
        "than mysterious.",
        "",
        "Secrets are not here and cannot be: keys, tokens and passwords live in PassBook, and",
        "`settings.py` refuses any credential-shaped key at import.",
        "",
    ]
    for section, label in SECTION_LABELS.items():
        lines += [f"## {label} (`{section}`)", "", "| Key | Default | Restart | Environment override | What it does |", "| --- | --- | --- | --- | --- |"]
        for spec in SETTINGS:
            if spec.section != section:
                continue
            default = spec.default_value()
            shown = spec.doc_default or (("on" if default else "off") if spec.kind == "bool" else str(default))
            lines.append(
                f"| `{spec.key}` | `{shown}` | {'yes' if spec.restart_required else 'no'} "
                f"| `{'`, `'.join(spec.env)}` | {spec.summary} |"
            )
        lines.append("")
    lines += [
        "## Still environment-only",
        "",
        "These are not user settings and have no row above. They are named here so nobody has to",
        "guess which of the ~87 environment variables in this package a person is expected to set.",
        "",
        "| Variable | Who sets it | Why it is not a setting |",
        "| --- | --- | --- |",
        "| `CONTENT_STUDIO_ROOT`, `CONTENT_STUDIO_FRONTEND_DIST` | installer | Decided by the build; a wrong value is a broken install, not a preference. |",
        "| `CONTENT_STUDIO_WEBAUTHN_RP_ID`, `CONTENT_STUDIO_WEBAUTHN_ORIGINS` | installer | Set with the port the shell actually bound; changing one alone orphans every enrolled passkey. |",
        "| `HIVEMIND_MEDIA_STATE_DIR`, `COMFY_PRIVATE_ROOT` | installer | The document itself lives under these, so they cannot be set from inside it. |",
        "| `HIVE_HOME` | installer | PassBook's store. Owned by PassBook, shared with every app on the machine. |",
        "| `CONTENT_STUDIO_ENABLE_LIVE_PUBLISH`, `CONTENT_STUDIO_ALLOW_PRIVATE_GENERATION_DOWNLOADS` | developer | Safety switches that exist to be off in the shipped app. |",
        "| `CONTENT_STUDIO_MAX_GENERATION_BYTES`, `ZIMG_OUTPUT_ENCRYPTION_ITER` | developer | Tuning with no honest unit to show a person. |",
        "| `COMFY_LANES`, `ZIMG_ACCELERATOR_PROFILE`, `ZIMG_KLEIN_*_MEMORY_GB` | developer | Bench and lane experiments; the Models page reports what actually answered. |",
        "| `*_API_KEY`, `*_TOKEN`, `POSTIZ_API_KEY`, `UPLOAD_POST_*` | PassBook | Credentials. Never in this document — see PassBook in the Advanced group. |",
        "",
    ]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description="This machine's studio settings.")
    parser.add_argument("--json", action="store_true", help="print the effective settings and their sources")
    parser.add_argument("--env", action="store_true", help="print shell exports for the values this document sets")
    parser.add_argument("--docs", action="store_true", help="print docs/SETTINGS.md")
    args = parser.parse_args(argv)
    if args.docs:
        print(_docs(), end="")
    elif args.env:
        for name, value in exported_env().items():
            print(f"export {name}={shlex.quote(value)}")
    else:
        print(json.dumps(describe(), indent=2))
    return 0


if __name__ == "__main__":  # pragma: no cover - CLI entry
    raise SystemExit(main())
