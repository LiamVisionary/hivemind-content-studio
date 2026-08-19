"""Per-account state subtrees, the legacy migration, and isolation itself.

The load-bearing test here is the last one: two accounts writing the same
logical thing must not be able to read each other's copy. That is asserted
against the real stores rather than against the path helpers, because a
resolver that returned the right Path and a store that ignored it would pass a
path-only test and still leak.
"""

from __future__ import annotations

import sqlite3

import pytest

from hivemind_content_studio.account_scope import (
    AccountPaths,
    AccountWorkspaces,
    bootstrap_accounts,
    migrate_legacy_state,
)
from hivemind_content_studio.accounts import AccountStore
from hivemind_content_studio.private_access import PrivateFieldCipher


@pytest.fixture()
def cipher() -> PrivateFieldCipher:
    return PrivateFieldCipher.from_secret(b"test-private-state-secret")


@pytest.fixture()
def workspaces(tmp_path, cipher) -> AccountWorkspaces:
    return AccountWorkspaces(tmp_path / "state", cipher=cipher)


def test_each_account_gets_its_own_subtree(tmp_path):
    first = AccountPaths.under(tmp_path, 1)
    second = AccountPaths.under(tmp_path, 2)
    assert first.root != second.root
    assert first.root.name == "1" and second.root.name == "2"
    # Every store and media root sits inside that account's own directory.
    for paths in (first, second):
        for candidate in (paths.vault_db, paths.prompt_history_db, paths.studio_state_db,
                          paths.canvas_history_db, paths.references_root, paths.outputs_root):
            assert candidate.is_relative_to(paths.root)
    # Nothing of one account's is reachable inside the other's root.
    assert not first.vault_db.is_relative_to(second.root)


def test_the_directory_is_keyed_on_id_so_a_rename_keeps_the_data(tmp_path, cipher):
    store = AccountStore(tmp_path / "accounts.sqlite3")
    account = store.create(name="Original", password="p")
    before = AccountPaths.under(tmp_path, account.id).root
    renamed = store.rename(account.id, "Something Else Entirely")
    assert AccountPaths.under(tmp_path, renamed.id).root == before


def test_stores_are_cached_per_account_and_never_shared(workspaces):
    assert workspaces.vault(1) is workspaces.vault(1)
    assert workspaces.vault(1) is not workspaces.vault(2)
    assert workspaces.prompt_history(1) is not workspaces.prompt_history(2)
    assert workspaces.studio_state(1) is not workspaces.studio_state(2)
    assert workspaces.canvas_history(1) is not workspaces.canvas_history(2)


def test_one_account_cannot_read_another_accounts_rows(workspaces):
    """The isolation claim, asserted through the real stores."""
    workspaces.studio_state(1).put("composer", {"prompt": "mine"})
    workspaces.studio_state(2).put("composer", {"prompt": "theirs"})
    assert workspaces.studio_state(1).get("composer") == {"prompt": "mine"}
    assert workspaces.studio_state(2).get("composer") == {"prompt": "theirs"}

    workspaces.vault(1).put_blob("library", "saved-prompts", "account-one-ciphertext")
    assert workspaces.vault(1).get_blob("library", "saved-prompts") == "account-one-ciphertext"
    assert workspaces.vault(2).get_blob("library", "saved-prompts") is None


def test_each_account_has_its_own_vault_identity(workspaces):
    """Two vaults, two master keys. This is what makes a bypassed authorization
    check a non-event rather than a breach."""
    identity = {
        "salt": "s", "wrapped_mk_pass": "a", "wrapped_mk_recovery": "b",
        "public_key": "account-one-public-key", "wrapped_private_key": "d",
    }
    workspaces.vault(1).put_identity(identity)
    assert workspaces.vault(1).has_identity()
    assert not workspaces.vault(2).has_identity()
    assert workspaces.vault_public_key(1) == "account-one-public-key"
    assert workspaces.vault_public_key(2) is None


def test_a_prompt_is_sealed_to_its_own_workspace_vault(workspaces):
    """The seal target is resolved per account, so a prompt written in one
    workspace can never be sealed to another workspace's key."""
    workspaces.vault(1).put_identity({
        "salt": "s", "wrapped_mk_pass": "a", "wrapped_mk_recovery": "b",
        "public_key": "key-one", "wrapped_private_key": "d",
    })
    workspaces.vault(2).put_identity({
        "salt": "s", "wrapped_mk_pass": "a", "wrapped_mk_recovery": "b",
        "public_key": "key-two", "wrapped_private_key": "d",
    })
    assert workspaces.prompt_history(1).vault_key() == "key-one"
    assert workspaces.prompt_history(2).vault_key() == "key-two"


def test_destroying_a_workspace_removes_the_whole_subtree(workspaces):
    workspaces.studio_state(3).put("composer", {"prompt": "temporary"})
    root = workspaces.paths(3).root
    assert root.is_dir()
    workspaces.destroy(3)
    assert not root.exists()
    # A later account with the same id starts empty rather than resurrecting.
    assert workspaces.studio_state(3).get("composer") == {}


# ── migration off the single-owner layout ────────────────────────────────────

def _legacy_state(tmp_path):
    state = tmp_path / "state"
    (state / "uploads" / "media-studio-references").mkdir(parents=True)
    (state / "generated" / "media-studio").mkdir(parents=True)
    (state / "uploads" / "media-studio-references" / "ref.png.e2e").write_text("sealed")
    (state / "generated" / "media-studio" / "out.mp4.e2e").write_text("sealed")
    for name in ("owner-vault", "prompt-history", "studio-state", "canvas-history"):
        connection = sqlite3.connect(state / f"{name}.sqlite3")
        connection.execute("CREATE TABLE marker(name TEXT)")
        connection.execute("INSERT INTO marker VALUES(?)", (name,))
        connection.commit()
        connection.close()
    return state


def test_the_existing_owner_library_becomes_account_one(tmp_path):
    state = _legacy_state(tmp_path)
    moved = migrate_legacy_state(state, 1)
    assert set(moved) == {
        "owner-vault.sqlite3", "prompt-history.sqlite3", "studio-state.sqlite3",
        "canvas-history.sqlite3", "uploads/media-studio-references", "generated/media-studio",
    }
    paths = AccountPaths.under(state, 1)
    assert paths.vault_db.is_file()
    assert (paths.references_root / "ref.png.e2e").read_text() == "sealed"
    assert (paths.outputs_root / "out.mp4.e2e").read_text() == "sealed"
    # The owner vault kept its content rather than being recreated empty.
    connection = sqlite3.connect(paths.vault_db)
    assert connection.execute("SELECT name FROM marker").fetchone()[0] == "owner-vault"
    connection.close()
    # MOVED, not copied: no second readable original is left behind.
    assert not (state / "owner-vault.sqlite3").exists()
    assert not (state / "uploads" / "media-studio-references").exists()


def test_migration_is_idempotent_and_never_overwrites(tmp_path):
    state = _legacy_state(tmp_path)
    assert migrate_legacy_state(state, 1)
    assert migrate_legacy_state(state, 1) == []
    # A legacy file reappearing later must NOT clobber the migrated one.
    (state / "studio-state.sqlite3").write_text("stale")
    assert migrate_legacy_state(state, 1) == []
    assert (state / "studio-state.sqlite3").read_text() == "stale"


def test_sqlite_sidecars_travel_with_their_database(tmp_path):
    state = _legacy_state(tmp_path)
    (state / "studio-state.sqlite3-wal").write_text("wal")
    (state / "studio-state.sqlite3-shm").write_text("shm")
    migrate_legacy_state(state, 1)
    paths = AccountPaths.under(state, 1)
    assert paths.studio_state_db.with_name("studio-state.sqlite3-wal").read_text() == "wal"
    assert paths.studio_state_db.with_name("studio-state.sqlite3-shm").read_text() == "shm"


def test_bootstrap_creates_an_owner_and_adopts_the_legacy_library(tmp_path):
    state = _legacy_state(tmp_path)
    store = AccountStore(tmp_path / "accounts.sqlite3")
    legacy_hash = "a" * 64
    owner = bootstrap_accounts(store=store, state_dir=state, legacy_password_hash=legacy_hash)
    assert owner.is_owner and owner.id == 1 and owner.has_password
    assert store.password_hash(owner.id) == legacy_hash
    assert AccountPaths.under(state, owner.id).vault_db.is_file()

    # Running again adopts nothing new and does not create a second owner.
    again = bootstrap_accounts(store=store, state_dir=state, legacy_password_hash=legacy_hash)
    assert again.id == owner.id
    assert len(store.list_accounts()) == 1


def test_bootstrap_leaves_an_existing_owner_password_alone(tmp_path):
    state = tmp_path / "state"
    store = AccountStore(tmp_path / "accounts.sqlite3")
    first = bootstrap_accounts(store=store, state_dir=state, legacy_password_hash="b" * 64)
    store.set_password(first.id, "a-real-password-set-later")
    again = bootstrap_accounts(store=store, state_dir=state, legacy_password_hash="b" * 64)
    assert again.id == first.id
    assert store.password_hash(again.id) != "b" * 64
