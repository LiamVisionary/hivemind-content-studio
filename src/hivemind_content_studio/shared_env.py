"""This app's adapter onto PassBook.

PassBook is the standard for sharing one credential store between the apps on a
machine; it lives in `packages/passbook` as a dependency-free single file (plus
a Node twin), so other projects can drop it in unchanged. This module is the
thin binding: it names this app, keeps the function names the rest of the studio
already imports, and adds nothing of its own.

On a machine running HivemindOS the store PassBook resolves is the hive env —
the same `~/.hivemindos/.env` that `hive-env-check` and `hive-env-run` already
read. That is the point: PassBook does not introduce a second store, it agrees
on the one that is already there.

Two rules that matter more than the code:

  * one store per machine — `$HIVE_HOME`, else `~/.hivemindos/.env`. This app
    never creates a private env, so installing it alongside HivemindOS or any
    other Hive app converges on one file rather than forking credentials.
  * the hive env is a DEFAULT, never an override. A value exported into the
    process, or set in this project, always wins.
"""

from __future__ import annotations

import sys
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any

_STANDARD = Path(__file__).resolve().parents[2] / "packages" / "passbook"
if str(_STANDARD) not in sys.path:
    sys.path.insert(0, str(_STANDARD))

import passbook  # noqa: E402  — the vendored standard, resolved above

APP_ID = "hivemind-content-studio"
APP_NAME = "Hivemind Content Studio"

DEFAULT_HIVE_ENV_FILES = (Path("~/.hivemindos/.env"),)


def parse_env_file(env_file: str | Path) -> dict[str, str]:
    path = Path(env_file).expanduser()
    if not path.is_file():
        return {}
    try:
        return passbook.parse_env_text(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError):
        return {}


def configured_hive_env_files(environment: Mapping[str, str] | None = None) -> tuple[Path, ...]:
    """Which files this process treats as the shared env.

    `HIVE_ENV_FILES` overrides the lot; it exists so the test suite can point at
    a path that does not exist and neutralise the fallback entirely.
    """
    import os

    source = environment or os.environ
    configured = source.get("HIVE_ENV_FILES", "")
    if configured:
        return tuple(Path(item).expanduser() for item in configured.split(os.pathsep) if item.strip())
    return (passbook.env_path(source),)


def load_shared_hive_env(
    *,
    env_files: Iterable[str | Path] | None = None,
    process_env: Mapping[str, str] | None = None,
) -> dict[str, str]:
    import os

    environment = process_env or os.environ
    values: dict[str, str] = {}
    for env_file in env_files or configured_hive_env_files(environment):
        values.update(parse_env_file(env_file))
    values.update({key: value for key, value in environment.items() if value})
    return values


def apply_shared_hive_env() -> set[str]:
    """Fill missing process variables from the shared env. Returns key NAMES."""
    import os

    shared: dict[str, str] = {}
    for env_file in configured_hive_env_files():
        shared.update(parse_env_file(env_file))
    filled: set[str] = set()
    for key, value in shared.items():
        if value and key not in os.environ:
            os.environ[key] = value
            filled.add(key)
    return filled


def join_hive_env() -> dict[str, Any]:
    """Adopt the machine's shared credential store, creating it if absent.

    Called once at startup. On a machine that already has HivemindOS this finds
    the existing store and registers as a participant; on a machine that has
    nothing it creates the canonical store at the same path, so a HivemindOS
    install later adopts what this app made rather than starting a second one.
    """
    import os

    # HIVE_ENV_FILES means this process has been pointed at a different env on
    # purpose — a test run, a sandbox, a second instance. Registering would
    # write into the machine's REAL hive root from a process that was told not
    # to touch it, which is exactly what the suite sets that variable to prevent.
    if os.environ.get("HIVE_ENV_FILES"):
        return {"ok": True, "provisioned": False, "adopted": False, "linked": False,
                "reason": "HIVE_ENV_FILES is set; this process is not joining the machine store"}
    return passbook.ensure(app=APP_ID, name=APP_NAME)


def hive_env_status() -> dict[str, Any]:
    """Key names, participating apps, and any packaging problem. No secrets."""
    return passbook.status()


def set_hive_env_values(values: Mapping[str, str], *, overwrite: bool = False) -> dict[str, Any]:
    """Write credentials to the shared store. Additive; returns key NAMES."""
    return passbook.set_values(values, overwrite=overwrite)


def request_credential(name: str, *, reason: str = "") -> str:
    """One credential, by name, through the scoped door.

    Everything in the studio that needs a provider key comes through here, so
    the process asks for what it needs rather than inheriting the whole store,
    and every read leaves a receipt naming the key (never the value). When a
    broker is running, this is also the call that goes through it.
    """
    import os

    # Naming the files here is a redirect, and it costs two things: the broker
    # is skipped, and so is workspace scoping — `configured_hive_env_files()`
    # resolves to the machine store alone. So do it only when this process HAS
    # been redirected, which is what HIVE_ENV_FILES means and is how the suite
    # keeps a developer's real credentials out of a test run. Left on always, it
    # would quietly read past a workspace and past the broker both.
    redirected = configured_hive_env_files() if os.environ.get("HIVE_ENV_FILES") else None
    granted = passbook.request(
        [name], app=APP_ID, reason=reason,
        workspace_id=passbook.workspace(),
        stores=redirected,
    )
    return granted.get(name, "")


def enable_access_stamps(*, actor_did: str = "") -> bool:
    """Record every credential read to the machine's tamper-evident ledger.

    The ledger is hash-chained in GitLawb's own proof format, so an access
    cannot be edited or removed without breaking every row after it, and
    GitLawb's verifier reads it. Optional: a machine without the companion
    module simply keeps no ledger.
    """
    try:
        import passbook_stamp
    except ImportError:
        return False
    passbook.set_recorder(
        passbook_stamp.recorder(APP_ID, workspace=passbook.workspace(), actor_did=actor_did)
    )
    return True


def access_ledger(*, limit: int = 100) -> dict[str, Any]:
    """The recent credential accesses, and whether the chain still adds up."""
    try:
        import passbook_stamp
    except ImportError:
        return {"available": False, "rows": [], "detail": "Access stamping is not installed."}
    verification = passbook_stamp.verify_chain()
    return {
        "available": True,
        "rows": passbook_stamp.read_stamps(limit=limit),
        "intact": verification["ok"],
        "detail": verification["detail"],
    }


def broker_status() -> dict[str, Any]:
    """Whether reads go through the broker, and what that is worth.

    The `limits` string travels with the status on purpose. A panel that showed
    "protected" without it would be teaching the owner something false, and this
    is precisely the feature where a false impression is the harm.
    """
    try:
        import passbook_broker
    except ImportError:
        return {"available": False, "running": False,
                "detail": "The broker is not installed on this machine."}
    state = passbook_broker.status()
    return {"available": True, **{key: state[key] for key in
            ("running", "mode", "apps", "path", "policy_path", "limits")}}


def access_state() -> dict[str, Any]:
    """The rules, the open unlocks, and anything waiting on the owner."""
    try:
        import passbook_access
        import passbook_broker
    except ImportError:
        return {"available": False, "detail": "Access modes are not installed."}
    policy = passbook_access.read_policy()
    live = passbook_broker.status()
    return {
        "available": True,
        "running": live["running"],
        "default_mode": policy["default"].get("mode", passbook_access.DEFAULT_MODE),
        "modes": list(passbook_access.GRANT_MODES),
        "presets": list(passbook_access.DURATION_PRESETS),
        "apps": policy["apps"],
        "sessions": passbook_access.sessions(),
        "pending": live.get("pending", []),
        "limits": live.get("limits", ""),
    }


def open_unlock(*, duration: str, keys: Iterable[str] = (), app: str = "",
                reason: str = "", approved_by: str = "owner") -> dict[str, Any]:
    """Hold access open for a stated period. Returns the unlock; never a value."""
    try:
        import passbook_access
    except ImportError:
        return {"ok": False, "detail": "Access modes are not installed."}
    try:
        return {"ok": True, **passbook_access.open_session(
            duration=duration, keys=keys, app=app, reason=reason, approved_by=approved_by)}
    except ValueError as error:
        return {"ok": False, "detail": str(error)}


def close_unlock(session_id: str = "") -> dict[str, Any]:
    try:
        import passbook_access
    except ImportError:
        return {"ok": False, "detail": "Access modes are not installed."}
    return passbook_access.close_session(session_id)


def resolve_request(request_id: str, *, approve: bool, remember: str = "",
                    approved_by: str = "owner") -> dict[str, Any]:
    """Answer a request that is waiting on a person."""
    try:
        import passbook_broker
    except ImportError:
        return {"ok": False, "detail": "The broker is not installed."}
    if not passbook_broker.running():
        return {"ok": False, "detail": "The broker is not running, so nothing is waiting."}
    answer = passbook_broker._ask({
        "op": "resolve", "id": request_id, "approve": approve,
        "remember": remember, "by": approved_by}) or {}
    return answer if answer.get("ok") else {"ok": False, "detail": answer.get("detail") or "That request is no longer waiting."}


def set_access_mode(*, app: str, key: str = "", mode: str,
                    window: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """Set how one key, or one app, is answered."""
    try:
        import passbook_access
    except ImportError:
        return {"ok": False, "detail": "Access modes are not installed."}
    if mode not in passbook_access.GRANT_MODES:
        return {"ok": False, "detail": f"Mode must be one of {', '.join(passbook_access.GRANT_MODES)}."}
    policy = passbook_access.read_policy()
    entry = policy["apps"].setdefault(app or "*", {})
    rule: dict[str, Any] = {"mode": mode}
    if mode == "window":
        if not window or not window.get("from") or not window.get("to"):
            return {"ok": False, "detail": "A window needs a start and an end, as HH:MM."}
        rule["window"] = dict(window)
    if key:
        entry.setdefault("keys", {})[key] = rule
    else:
        entry["default"] = rule
    passbook_access.write_policy(policy)
    return {"ok": True, "app": app or "*", "key": key, "mode": mode}


def machine_links(*, limit: int = 50) -> dict[str, Any]:
    """Which machines this one lends keys to, or borrows them from. Names only.

    Approving and accepting stay on the command line on purpose: both need a
    fingerprint compared against another machine's screen, which a panel on one
    machine cannot do. What a panel CAN do usefully is show what is currently
    lent and take it back, so that is all this exposes.
    """
    try:
        import passbook_link
    except ImportError:
        return {"available": False, "lent": [], "borrowed": [],
                "detail": "Machine linking is not installed."}
    if not passbook_link.available():
        return {"available": False, "lent": [], "borrowed": [],
                "detail": "Machine linking needs a runtime that setup has not provided yet. "
                          "Run `passbook install` on this machine."}
    state = passbook_link.grants()
    return {
        "available": True,
        "did": state["did"],
        "fingerprint": passbook_link.describe_identity()["fingerprint"],
        "lent": state["lent"][-limit:],
        "borrowed": state["borrowed"][-limit:],
        "detail": "",
    }


def revoke_machine_link(did: str) -> dict[str, Any]:
    """Stop lending to a machine. Returns the keys that must still be rotated."""
    try:
        import passbook_link
    except ImportError:
        return {"ok": False, "rotate": [], "detail": "Machine linking is not installed."}
    return passbook_link.revoke(did)


def sealing_status() -> dict[str, Any]:
    """How much of the shared store is encrypted at rest."""
    try:
        import passbook_seal
    except ImportError:
        return {"supported": False, "detail": "Encryption at rest is not installed."}
    return passbook_seal.status()


def seal_store() -> dict[str, Any]:
    """Encrypt every plaintext value in the shared store, in place."""
    try:
        import passbook_seal
    except ImportError:
        return {"ok": False, "detail": "Encryption at rest is not installed."}
    return passbook_seal.seal_store()


ContainerisedHomeError = passbook.ContainerisedHomeError
