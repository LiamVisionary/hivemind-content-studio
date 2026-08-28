# SPDX-License-Identifier: Apache-2.0
"""Ciphertext must never leave the store as a credential.

PassBook writes an encrypted value as the literal text `hive-sealed:<...>`. That
string is the trap in this whole area, because it is NON-EMPTY: it survives
every `if not value` guard, so a reader that does not know about it does not
fail — it succeeds, with ciphertext, and hands that to a provider as a bearer
token. What comes back is a 401 that blames the account.

That is not hypothetical. Sending `hive-sealed:...` to the ChatGPT backend
returns, verbatim:

    Could not parse your authentication token. Please try signing in again.

which the studio wrapped as "ChatGPT (sign-in) refused this sign-in" and
answered with a reconnect button. Signing in again writes a token that is
sealed, and the next process start fails identically. Nothing in that loop ever
names the encryption, so the loop does not terminate.

The rule these tests hold is PassBook's own: a value this machine cannot open is
ABSENT. Never ciphertext, never a crash.
"""

from __future__ import annotations

import os

import pytest

from hivemind_content_studio import provider_models, shared_env

SEALED = "hive-sealed:v2:notarealciphertext"

# Captured at collection, before conftest's `_isolate_provider_accounts` swaps
# them for stubs that return nothing. That fixture exists so no test can spend a
# developer's real account, and it is right — but these tests are ABOUT what
# those two functions do, so they have to be the real ones here. The isolation
# is preserved by the sealed store below: every value in it is ciphertext this
# machine cannot open, so a restored reader still has nothing real to hand out.
_REAL_CREDENTIAL = provider_models.credential
_REAL_STORED_NAMES = provider_models.stored_names


@pytest.fixture
def real_reads(monkeypatch):
    monkeypatch.setattr(provider_models, "credential", _REAL_CREDENTIAL)
    monkeypatch.setattr(provider_models, "stored_names", _REAL_STORED_NAMES)


@pytest.fixture
def sealed_store(tmp_path, monkeypatch):
    """A store whose values are all sealed, and a process that cannot open it."""
    store = tmp_path / "sealed.env"
    store.write_text(
        f'OPENAI_OAUTH_ACCESS_TOKEN="{SEALED}"\n'
        f'OPENAI_OAUTH_REFRESH_TOKEN="{SEALED}"\n'
        f'OPENAI_API_KEY="{SEALED}"\n'
        f'A_PLAINTEXT_KEY=this-one-is-readable\n',
        encoding="utf-8",
    )
    monkeypatch.setenv("HIVE_ENV_FILES", str(store))
    for name in ("OPENAI_OAUTH_ACCESS_TOKEN", "OPENAI_OAUTH_REFRESH_TOKEN", "OPENAI_API_KEY"):
        monkeypatch.delenv(name, raising=False)
    return store


# ── the reader ──────────────────────────────────────────────────────────────


def test_reading_the_store_drops_what_it_cannot_open(sealed_store):
    values = shared_env.parse_env_file(sealed_store)
    assert "OPENAI_OAUTH_ACCESS_TOKEN" not in values
    assert not any(str(v).startswith("hive-sealed:") for v in values.values())


def test_a_plaintext_value_in_the_same_file_still_arrives(sealed_store):
    """Sealing is gradual. Dropping the sealed ones must not drop the rest."""
    values = shared_env.parse_env_file(sealed_store)
    assert values["A_PLAINTEXT_KEY"] == "this-one-is-readable"


# ── the process environment ─────────────────────────────────────────────────


def test_startup_does_not_put_ciphertext_into_the_environment(sealed_store, monkeypatch):
    """`apply_shared_hive_env` runs at app startup and writes into os.environ.

    This is where the bug entered: once ciphertext is in the process
    environment, every later read prefers it over the broker that could have
    opened it properly.
    """
    shared_env.apply_shared_hive_env()
    assert not os.environ.get("OPENAI_OAUTH_ACCESS_TOKEN", "").startswith("hive-sealed:")


def test_load_shared_hive_env_never_reports_a_sealed_value(sealed_store):
    values = shared_env.load_shared_hive_env()
    assert not any(str(v).startswith("hive-sealed:") for v in values.values())


# ── the point of spending ───────────────────────────────────────────────────


def test_a_poisoned_environment_is_still_not_spent(sealed_store, real_reads, monkeypatch):
    """Belt and braces: the process environment can be poisoned by a PARENT
    that read the store the wrong way, which is not something this app can fix
    upstream. So the last gate before the wire refuses ciphertext too."""
    monkeypatch.setenv("OPENAI_API_KEY", SEALED)
    assert not provider_models.credential("OPENAI_API_KEY").startswith("hive-sealed:")


def test_a_real_exported_value_still_wins(sealed_store, real_reads, monkeypatch):
    """The guard must not break the precedence rule it sits inside: an explicit
    export outranks the store, and that is how a project overrides the fleet."""
    monkeypatch.setenv("OPENAI_API_KEY", "exported-by-the-project")
    assert provider_models.credential("OPENAI_API_KEY") == "exported-by-the-project"


# ── what the owner is told ──────────────────────────────────────────────────


def test_a_locked_vault_is_not_reported_as_a_missing_account(sealed_store, real_reads):
    """The two states are indistinguishable at the call site and have opposite
    repairs. Saying "not connected" for a locked vault sends the owner to
    re-authenticate an account that was never broken."""
    provider = provider_models.BY_ID["chatgpt"]
    with pytest.raises(provider_models.ProviderModelsError) as failure:
        provider_models.grant_token(provider)

    message = str(failure.value)
    assert "sealed" in message and "locked" in message, message
    assert "passbook signin" in message.lower(), message
    assert "is not connected yet" not in message, message


def test_a_genuinely_absent_account_still_says_not_connected(tmp_path, real_reads, monkeypatch):
    """The other half of the same distinction — and the reason it cannot just
    always blame the vault."""
    empty = tmp_path / "empty.env"
    empty.write_text("", encoding="utf-8")
    monkeypatch.setenv("HIVE_ENV_FILES", str(empty))
    for name in ("OPENAI_OAUTH_ACCESS_TOKEN", "OPENAI_OAUTH_REFRESH_TOKEN"):
        monkeypatch.delenv(name, raising=False)

    provider = provider_models.BY_ID["chatgpt"]
    with pytest.raises(provider_models.ProviderModelsError) as failure:
        provider_models.grant_token(provider)
    assert "is not connected yet" in str(failure.value)
