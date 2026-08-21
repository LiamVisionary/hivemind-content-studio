"""One state subtree per account, and the request-scoped resolver for it.

## Why the filesystem is the boundary

The obvious way to add accounts is an `account_id` column and a `WHERE` clause
on every query. That makes isolation a property you have to remember 62 times —
and the one route that forgets leaks another person's library with no error
anywhere. So instead each account gets its own directory, its own SQLite files
and its own media roots:

    <state>/accounts/<id>/vault.sqlite3
                         /prompt-history.sqlite3
                         /studio-state.sqlite3
                         /canvas-history.sqlite3
                         /uploads/media-studio-references/
                         /generated/media-studio/

A route holding account 2's stores has no handle that can name account 1's rows.
Forgetting the scope is not a silent leak; it is an unbound name.

The directory is keyed on the account id ALONE, never the display name: a
workspace can be renamed at any time and its data has to stay put.

## The second leg

Directory separation is authorization, and authorization can be bypassed by a
bug. So it is not the only thing standing between two people: every account also
has its OWN zero-knowledge vault under this subtree, whose master key is derived
in that person's browser (e2eVault.js). Media is sealed to that account's public
key. If a path traversal ever did reach the wrong subtree, what it would find is
ciphertext this server has never been able to read.

That is the difference between this and the donor's profiles, which are a
`profileId` column over shared plaintext.
"""

from __future__ import annotations

import os
import shutil
import sqlite3
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

from .accounts import Account, AccountStore
from .canvas_history import CanvasHistoryStore
from .private_access import PrivateFieldCipher, read_vault_public_key
from .prompt_history import PromptHistoryStore
from .studio_state import StudioStateStore
from .vault_store import VaultStore

# The legacy single-owner layout, and where each piece lands inside account 1.
# SQLite sidecars (-wal, -shm) travel with their database or the move loses
# committed-but-uncheckpointed writes.
LEGACY_LAYOUT: tuple[tuple[str, str], ...] = (
    ("owner-vault.sqlite3", "vault.sqlite3"),
    ("prompt-history.sqlite3", "prompt-history.sqlite3"),
    ("studio-state.sqlite3", "studio-state.sqlite3"),
    ("canvas-history.sqlite3", "canvas-history.sqlite3"),
    ("uploads/media-studio-references", "uploads/media-studio-references"),
    ("generated/media-studio", "generated/media-studio"),
)
SQLITE_SIDECARS = ("-wal", "-shm")


@dataclass(frozen=True)
class AccountPaths:
    """Every path a single account's data may live at."""

    account_id: int
    root: Path
    vault_db: Path
    prompt_history_db: Path
    studio_state_db: Path
    canvas_history_db: Path
    references_root: Path
    outputs_root: Path

    @classmethod
    def under(cls, state_dir: Path, account_id: int) -> "AccountPaths":
        root = Path(state_dir).expanduser().resolve() / "accounts" / str(int(account_id))
        return cls(
            account_id=int(account_id),
            root=root,
            vault_db=root / "vault.sqlite3",
            prompt_history_db=root / "prompt-history.sqlite3",
            studio_state_db=root / "studio-state.sqlite3",
            canvas_history_db=root / "canvas-history.sqlite3",
            references_root=root / "uploads" / "media-studio-references",
            outputs_root=root / "generated" / "media-studio",
        )

    def ensure(self) -> "AccountPaths":
        self.references_root.mkdir(parents=True, exist_ok=True)
        self.outputs_root.mkdir(parents=True, exist_ok=True)
        return self


class NoAccountInScope(RuntimeError):
    """Raised when account-scoped state is reached with nobody signed in.

    Deliberately an error rather than a default. A resolver that quietly fell
    back to the first account would turn every missed authorization check into a
    silent cross-account read, which is exactly the failure this module exists
    to make impossible.
    """


class AccountWorkspaces:
    """Opens and caches the per-account stores.

    Store objects are cached because each one holds a SQLite connection factory
    and re-creating them per request would re-run the schema bootstrap on every
    call. The cache is keyed by account id and guarded by a lock, since FastAPI
    serves requests for different accounts concurrently.
    """

    def __init__(self, state_dir: str | Path, *, cipher: PrivateFieldCipher):
        self.state_dir = Path(state_dir).expanduser().resolve()
        self.cipher = cipher
        self._lock = threading.Lock()
        self._vaults: dict[int, VaultStore] = {}
        self._prompt_history: dict[int, PromptHistoryStore] = {}
        self._studio_state: dict[int, StudioStateStore] = {}
        self._canvas_history: dict[int, CanvasHistoryStore] = {}

    def paths(self, account_id: int) -> AccountPaths:
        return AccountPaths.under(self.state_dir, account_id).ensure()

    def vault(self, account_id: int) -> VaultStore:
        with self._lock:
            store = self._vaults.get(int(account_id))
            if store is None:
                store = VaultStore(self.paths(account_id).vault_db)
                self._vaults[int(account_id)] = store
        return store

    def vault_public_key(self, account_id: int) -> str | None:
        """This account's RSA public key for server-side sealing, or None until
        they have created a vault in-browser. Never a secret."""
        return read_vault_public_key(self.paths(account_id).vault_db)

    def prompt_history(self, account_id: int) -> PromptHistoryStore:
        with self._lock:
            store = self._prompt_history.get(int(account_id))
            if store is None:
                scoped = int(account_id)
                store = PromptHistoryStore(
                    self.paths(scoped).prompt_history_db,
                    cipher=self.cipher,
                    # Bound to THIS account, so a prompt is only ever sealed to
                    # the vault of the workspace it was written in.
                    vault_key=lambda: self.vault_public_key(scoped),
                )
                self._prompt_history[scoped] = store
        return store

    def studio_state(self, account_id: int) -> StudioStateStore:
        with self._lock:
            store = self._studio_state.get(int(account_id))
            if store is None:
                store = StudioStateStore(self.paths(account_id).studio_state_db, cipher=self.cipher)
                self._studio_state[int(account_id)] = store
        return store

    def canvas_history(self, account_id: int) -> CanvasHistoryStore:
        with self._lock:
            store = self._canvas_history.get(int(account_id))
            if store is None:
                store = CanvasHistoryStore(self.paths(account_id).canvas_history_db, cipher=self.cipher)
                self._canvas_history[int(account_id)] = store
        return store

    def forget(self, account_id: int) -> None:
        """Drop cached handles, so a deleted workspace holds no open files."""
        with self._lock:
            for cache in (self._vaults, self._prompt_history, self._studio_state, self._canvas_history):
                cache.pop(int(account_id), None)

    def destroy(self, account_id: int) -> None:
        """Delete a workspace's entire subtree. Irreversible by design: the
        vault goes with it, so nothing left behind would be readable anyway."""
        self.forget(account_id)
        root = AccountPaths.under(self.state_dir, account_id).root
        if root.is_dir():
            shutil.rmtree(root)


class RunClaims:
    """Which workspace each shared-store run belongs to.

    Runs are the one store that stays machine-wide — ids are minted by the
    orchestrator and agents resume them by id across processes — so this is
    the documented exception to the files-not-WHERE-clauses rule above: a
    single map from run id to account id, written at creation time, the only
    moment anyone knows who asked. A run with no claim predates accounts or
    was started by a machine caller; both belong to the owner.
    """

    def __init__(self, path: str | Path):
        self.path = Path(path).expanduser().resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.execute("PRAGMA journal_mode = WAL")
            connection.execute(
                "CREATE TABLE IF NOT EXISTS run_claims ("
                " run_id TEXT PRIMARY KEY,"
                " account_id INTEGER NOT NULL,"
                " created_at TEXT NOT NULL)"
            )

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=30)
        connection.execute("PRAGMA busy_timeout = 30000")
        return connection

    def claim(self, run_id: str, account_id: int) -> None:
        # First claim wins: a claim names the run's creator, and the creator
        # is whoever was in scope when the run id first existed.
        with self._connect() as connection:
            connection.execute(
                "INSERT INTO run_claims(run_id, account_id, created_at) VALUES(?, ?, ?)"
                " ON CONFLICT(run_id) DO NOTHING",
                (
                    str(run_id),
                    int(account_id),
                    datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
                ),
            )

    def account_for(self, run_id: str) -> int | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT account_id FROM run_claims WHERE run_id = ?", (str(run_id),)
            ).fetchone()
        return int(row[0]) if row else None

    def accounts_for(self, run_ids: list[str]) -> dict[str, int]:
        """One query for a whole listing, not one connection per row."""
        cleaned = [str(run_id) for run_id in run_ids if run_id]
        if not cleaned:
            return {}
        marks = ",".join("?" for _ in cleaned)
        with self._connect() as connection:
            rows = connection.execute(
                f"SELECT run_id, account_id FROM run_claims WHERE run_id IN ({marks})", cleaned
            ).fetchall()
        return {str(run_id): int(account_id) for run_id, account_id in rows}


def _move(source: Path, target: Path) -> bool:
    if not source.exists() or target.exists():
        return False
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(source), str(target))
    for suffix in SQLITE_SIDECARS:
        sidecar = source.with_name(source.name + suffix)
        if sidecar.exists():
            shutil.move(str(sidecar), str(target.with_name(target.name + suffix)))
    return True


def migrate_legacy_state(
    state_dir: str | Path, account_id: int, *, skip: Iterable[str] = ()
) -> list[str]:
    """Move the pre-accounts single-owner state into one account's subtree.

    Returns what was moved. Idempotent: anything already migrated, or absent, is
    skipped, so this is safe to call on every boot. Files are MOVED rather than
    copied — a copy would leave a second readable original of content whose
    whole point is that only one vault can open it.

    `skip` names legacy entries an embedding app has already opened itself. A
    store handed to us is bound to the path its owner chose, and moving that
    file out from under an open connection leaves SQLite silently creating a
    fresh empty database at the old name.
    """
    root = Path(state_dir).expanduser().resolve()
    paths = AccountPaths.under(root, account_id)
    excluded = set(skip)
    moved: list[str] = []
    for legacy_name, scoped_name in LEGACY_LAYOUT:
        if legacy_name in excluded:
            continue
        if _move(root / legacy_name, paths.root / scoped_name):
            moved.append(legacy_name)
    # Leave the now-empty legacy parents behind only if something else uses them.
    for parent in ("uploads", "generated"):
        candidate = root / parent
        if candidate.is_dir() and not any(candidate.iterdir()):
            candidate.rmdir()
    return moved


def bootstrap_accounts(
    *,
    store: AccountStore,
    state_dir: str | Path,
    legacy_password_hash: str | None = None,
    skip_migration: Iterable[str] = (),
) -> Account:
    """Guarantee an owner account exists, adopting any pre-accounts state.

    On the first boot after this feature lands there is a studio full of the
    owner's work and no accounts table. That content becomes account 1, and the
    owner keeps signing in with the password they already use — the legacy
    SHA-256 digest is carried over verbatim and upgraded to scrypt the first
    time it is used (see accounts.verify_password).
    """
    existing = store.list_accounts()
    owner = next((account for account in existing if account.is_owner), None)
    if owner is None:
        owner = existing[0] if existing else store.create(
            name=os.environ.get("CONTENT_STUDIO_OWNER_NAME", "Owner").strip() or "Owner",
            password=None,
            password_hash=legacy_password_hash,
            is_owner=True,
        )
    migrate_legacy_state(state_dir, owner.id, skip=skip_migration)
    AccountPaths.under(state_dir, owner.id).ensure()
    return owner
