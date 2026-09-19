"""Accounts, sessions and passkeys.

The WebAuthn tests drive a real software authenticator: a P-256 (and separately
an RSA) key that signs exactly what a browser authenticator signs, so the whole
verification path — challenge, origin, RP ID hash, flags, counter, signature —
is exercised without a browser. A test that only checked the happy path would
not notice the verifier accepting a forged assertion, so each rejection is
asserted individually.
"""

from __future__ import annotations

import hashlib
import json

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa

from hivemind_content_studio.accounts import (
    ES256,
    RS256,
    AccountAccess,
    AccountStore,
    LoginThrottle,
    RelyingParty,
    WebAuthnError,
    authentication_options,
    b64url,
    hash_password,
    is_legacy_password_hash,
    registration_options,
    slugify,
    unb64url,
    verify_assertion,
    verify_password,
    verify_registration,
)

ORIGIN = "http://127.0.0.1:8765"
PARTY = RelyingParty(rp_id="127.0.0.1", origins=(ORIGIN,))


@pytest.fixture()
def store(tmp_path) -> AccountStore:
    return AccountStore(tmp_path / "accounts.sqlite3")


class SoftAuthenticator:
    """Signs like a platform authenticator, so the verifier gets real input."""

    def __init__(self, *, rp_id: str = "127.0.0.1", algorithm: int = ES256):
        self.algorithm = algorithm
        self.rp_id = rp_id
        self.sign_count = 0
        if algorithm == ES256:
            self.key = ec.generate_private_key(ec.SECP256R1())
        else:
            self.key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self.credential_id = b64url(b"credential-" + rp_id.encode("ascii"))

    @property
    def spki(self) -> str:
        return b64url(
            self.key.public_key().public_bytes(
                encoding=serialization.Encoding.DER,
                format=serialization.PublicFormat.SubjectPublicKeyInfo,
            )
        )

    def client_data(self, challenge: str, *, kind: str, origin: str = ORIGIN) -> str:
        return b64url(json.dumps({"type": kind, "challenge": challenge, "origin": origin}).encode("utf-8"))

    def authenticator_data(self, *, rp_id: str | None = None, flags: int = 0x05,
                           sign_count: int | None = None) -> str:
        used = self.rp_id if rp_id is None else rp_id
        counter = self.sign_count if sign_count is None else sign_count
        return b64url(
            hashlib.sha256(used.encode("utf-8")).digest()
            + bytes([flags])
            + int(counter).to_bytes(4, "big")
        )

    def sign(self, authenticator_data: str, client_data_json: str) -> str:
        payload = unb64url(authenticator_data) + hashlib.sha256(unb64url(client_data_json)).digest()
        if self.algorithm == ES256:
            return b64url(self.key.sign(payload, ec.ECDSA(hashes.SHA256())))
        return b64url(self.key.sign(payload, padding.PKCS1v15(), hashes.SHA256()))

    def register(self, store: AccountStore, account, *, prf: bool = False) -> None:
        options = registration_options(store=store, account=account, party=PARTY)
        verify_registration(
            store=store, account_id=account.id, party=PARTY,
            credential_id=self.credential_id, public_key=self.spki, algorithm=self.algorithm,
            client_data_json=self.client_data(options["challenge"], kind="webauthn.create"),
            label="Test key", prf=prf,
        )

    def assert_login(self, store: AccountStore, *, account=None, **overrides) -> int:
        options = authentication_options(store=store, party=PARTY, account=account)
        client_data = overrides.pop(
            "client_data_json", self.client_data(options["challenge"], kind="webauthn.get")
        )
        self.sign_count += 1
        authenticator = overrides.pop("authenticator_data", self.authenticator_data())
        signature = overrides.pop("signature", self.sign(authenticator, client_data))
        return verify_assertion(
            store=store, party=PARTY, credential_id=overrides.pop("credential_id", self.credential_id),
            client_data_json=client_data, authenticator_data=authenticator, signature=signature,
        )


# ── passwords ────────────────────────────────────────────────────────────────

def test_password_hashing_round_trips_and_rejects_near_misses():
    stored = hash_password("correct horse battery staple")
    assert stored.startswith("scrypt$")
    assert verify_password(stored, "correct horse battery staple")
    assert not verify_password(stored, "correct horse battery stapl")
    assert not verify_password(stored, "")
    assert not verify_password(None, "anything")
    # Two hashes of the same password differ: the salt is per-account, so a
    # shared password does not show up as a shared hash.
    assert stored != hash_password("correct horse battery staple")


def test_the_existing_owner_sha256_hash_still_signs_in():
    """The shipped owner password is a bare SHA-256 digest. Migration must not
    lock the owner out of their own studio on the first boot after upgrade."""
    legacy = hashlib.sha256(b"owner-passphrase").hexdigest()
    assert is_legacy_password_hash(legacy)
    assert verify_password(legacy, "owner-passphrase")
    assert not verify_password(legacy, "wrong")
    assert not is_legacy_password_hash(hash_password("owner-passphrase"))


# ── throttle ─────────────────────────────────────────────────────────────────

def test_throttle_blocks_after_repeated_failures_and_clears_on_success():
    clock = {"t": 1000.0}
    throttle = LoginThrottle(max_attempts=3, window_seconds=10, block_seconds=60,
                             clock=lambda: clock["t"])
    assert throttle.retry_after("peer") == 0
    throttle.fail("peer")
    throttle.fail("peer")
    assert throttle.fail("peer") > 0
    assert throttle.retry_after("peer") > 0
    clock["t"] += 61
    assert throttle.retry_after("peer") == 0
    throttle.fail("peer")
    throttle.success("peer")
    assert throttle.retry_after("peer") == 0


def test_throttling_one_workspace_does_not_lock_another():
    clock = {"t": 0.0}
    throttle = LoginThrottle(max_attempts=2, clock=lambda: clock["t"])
    throttle.fail("10.0.0.1:2")
    throttle.fail("10.0.0.1:2")
    assert throttle.retry_after("10.0.0.1:2") > 0
    assert throttle.retry_after("10.0.0.1:3") == 0


# ── accounts ─────────────────────────────────────────────────────────────────

def test_accounts_are_created_listed_and_renamed(store):
    owner = store.create(name="Liam", password="owner-pass", is_owner=True)
    second = store.create(name="Studio B", password="other-pass")
    assert owner.id == 1 and owner.is_owner
    assert second.id == 2 and not second.is_owner
    assert [account.name for account in store.list_accounts()] == ["Liam", "Studio B"]
    # Colour is derived from the id, so deleting a sibling never reshuffles it.
    assert owner.colour and second.colour and owner.colour != second.colour
    renamed = store.rename(second.id, "Client work")
    assert renamed.name == "Client work" and renamed.colour == second.colour

    with pytest.raises(ValueError):
        store.create(name="Liam", password="x")
    with pytest.raises(ValueError):
        store.create(name="   ", password="x")


def test_the_public_view_leaks_no_secret(store):
    account = store.create(name="Liam", password="owner-pass", is_owner=True)
    public = account.public()
    assert public["has_password"] is True and public["has_passkey"] is False
    body = json.dumps(public)
    assert "owner-pass" not in body and "scrypt" not in body
    assert "password_hash" not in public and "slug" not in public


def test_a_passwordless_workspace_is_marked_as_such(store):
    account = store.create(name="Open", password=None)
    assert account.has_password is False
    assert store.password_hash(account.id) is None
    store.set_password(account.id, "later")
    assert verify_password(store.password_hash(account.id), "later")


def test_deleting_an_account_takes_its_passkeys_with_it(store):
    account = store.create(name="Temp", password="p")
    SoftAuthenticator().register(store, account)
    assert store.list_passkeys(account.id)
    assert store.delete(account.id)
    assert store.list_passkeys(account.id) == []


def test_slugify_never_escapes_a_directory_name():
    assert slugify("../../etc/passwd") == "etc-passwd"
    assert slugify("Liam's Studio") == "liam-s-studio"
    assert slugify("") == "workspace"
    assert slugify("🎬🎬") == "workspace"
    assert "/" not in slugify("a/b") and ".." not in slugify("..")


# ── sessions ─────────────────────────────────────────────────────────────────

def test_a_session_cookie_proves_exactly_one_account():
    access = AccountAccess(signing_secret=b"s" * 32)
    token = access.issue(7)
    assert access.account_id(token) == 7
    assert access.account_id(None) is None
    assert access.account_id("nonsense") is None


def test_a_cookie_cannot_be_edited_into_another_workspace():
    """The account id is inside the signed payload, not beside it."""
    access = AccountAccess(signing_secret=b"s" * 32)
    token = access.issue(1)
    account_text, expires, nonce, signature = token.split(".", 3)
    forged = f"2.{expires}.{nonce}.{signature}"
    assert access.account_id(forged) is None
    # ...and a different secret cannot mint one either.
    other = AccountAccess(signing_secret=b"t" * 32)
    assert access.account_id(other.issue(1)) is None


def test_an_expired_cookie_stops_working():
    access = AccountAccess(signing_secret=b"s" * 32, session_seconds=10)
    token = access.issue(1, now=1_000)
    assert access.account_id(token, now=1_005) == 1
    assert access.account_id(token, now=1_011) is None


# ── WebAuthn ─────────────────────────────────────────────────────────────────

def test_a_passkey_registers_and_then_signs_in(store):
    account = store.create(name="Liam", password="p", is_owner=True)
    authenticator = SoftAuthenticator()
    authenticator.register(store, account)

    keys = store.list_passkeys(account.id)
    assert len(keys) == 1 and keys[0]["label"] == "Test key"
    assert authenticator.assert_login(store, account=account) == account.id
    assert store.list_passkeys(account.id)[0]["last_used_at"]


def test_an_rsa_passkey_verifies_too(store):
    account = store.create(name="Liam", password="p")
    authenticator = SoftAuthenticator(algorithm=RS256)
    authenticator.register(store, account)
    assert authenticator.assert_login(store, account=account) == account.id


def test_a_discoverable_sign_in_names_the_workspace_from_the_assertion(store):
    """No account is named up front, so the passkey itself decides which
    workspace opens — the whole point of the tile grid needing no password."""
    first = store.create(name="One", password="p")
    second = store.create(name="Two", password="p")
    key_one, key_two = SoftAuthenticator(), SoftAuthenticator()
    key_two.credential_id = b64url(b"credential-two")
    key_one.register(store, first)
    key_two.register(store, second)

    assert key_one.assert_login(store) == first.id
    assert key_two.assert_login(store) == second.id


def test_one_persons_passkey_never_opens_another_workspace(store):
    """The account id comes from the stored credential, never from the caller."""
    victim = store.create(name="Victim", password="p")
    attacker = store.create(name="Attacker", password="p")
    key = SoftAuthenticator()
    key.register(store, victim)

    # Signing in while naming the attacker's workspace still lands on the
    # credential's own account, and the challenge binding refuses outright.
    with pytest.raises(WebAuthnError, match="different workspace"):
        key.assert_login(store, account=attacker)
    assert key.assert_login(store, account=victim) == victim.id


def test_registering_someone_elses_credential_id_is_refused(store):
    first = store.create(name="One", password="p")
    second = store.create(name="Two", password="p")
    key = SoftAuthenticator()
    key.register(store, first)
    with pytest.raises(WebAuthnError, match="already registered"):
        key.register(store, second)


def test_a_challenge_works_exactly_once(store):
    account = store.create(name="Liam", password="p")
    key = SoftAuthenticator()
    key.register(store, account)

    options = authentication_options(store=store, party=PARTY, account=account)
    client_data = key.client_data(options["challenge"], kind="webauthn.get")
    key.sign_count += 1
    authenticator_data = key.authenticator_data()
    signature = key.sign(authenticator_data, client_data)
    common = dict(store=store, party=PARTY, credential_id=key.credential_id,
                  client_data_json=client_data, authenticator_data=authenticator_data,
                  signature=signature)
    assert verify_assertion(**common) == account.id
    with pytest.raises(WebAuthnError, match="unknown or expired"):
        verify_assertion(**common)


def test_an_assertion_from_another_origin_is_refused(store):
    account = store.create(name="Liam", password="p")
    key = SoftAuthenticator()
    key.register(store, account)
    options = authentication_options(store=store, party=PARTY, account=account)
    hostile = key.client_data(options["challenge"], kind="webauthn.get", origin="https://evil.example")
    authenticator_data = key.authenticator_data()
    with pytest.raises(WebAuthnError, match="origin is not this studio"):
        verify_assertion(
            store=store, party=PARTY, credential_id=key.credential_id, client_data_json=hostile,
            authenticator_data=authenticator_data, signature=key.sign(authenticator_data, hostile),
        )


def test_an_assertion_for_a_different_site_is_refused(store):
    """The RP ID hash is what stops a passkey minted for another host being
    replayed here, even when the origin string happens to match."""
    account = store.create(name="Liam", password="p")
    key = SoftAuthenticator()
    key.register(store, account)
    with pytest.raises(WebAuthnError, match="different site"):
        key.assert_login(store, account=account,
                         authenticator_data=key.authenticator_data(rp_id="evil.example"))


def test_an_assertion_without_user_presence_is_refused(store):
    account = store.create(name="Liam", password="p")
    key = SoftAuthenticator()
    key.register(store, account)
    with pytest.raises(WebAuthnError, match="user presence"):
        key.assert_login(store, account=account, authenticator_data=key.authenticator_data(flags=0x00))


def test_a_forged_signature_is_refused(store):
    account = store.create(name="Liam", password="p")
    key = SoftAuthenticator()
    key.register(store, account)
    # A signature from a DIFFERENT key over the right payload: this is the check
    # that makes the passkey a key rather than a claim.
    impostor = SoftAuthenticator()
    options = authentication_options(store=store, party=PARTY, account=account)
    client_data = key.client_data(options["challenge"], kind="webauthn.get")
    authenticator_data = key.authenticator_data()
    with pytest.raises(WebAuthnError, match="did not verify"):
        verify_assertion(
            store=store, party=PARTY, credential_id=key.credential_id, client_data_json=client_data,
            authenticator_data=authenticator_data,
            signature=impostor.sign(authenticator_data, client_data),
        )


def test_a_replayed_counter_is_refused_but_a_frozen_one_is_allowed(store):
    """A counter that goes backwards means a cloned authenticator. A counter
    pinned at zero is what most platform passkeys actually do, and refusing
    those would lock out every Apple device."""
    account = store.create(name="Liam", password="p")
    key = SoftAuthenticator()
    key.register(store, account)
    key.sign_count = 5
    assert key.assert_login(store, account=account) == account.id
    with pytest.raises(WebAuthnError, match="counter went backwards"):
        key.assert_login(store, account=account, authenticator_data=key.authenticator_data(sign_count=3))

    frozen = SoftAuthenticator()
    frozen.credential_id = b64url(b"credential-frozen")
    frozen.register(store, account)
    for _ in range(3):
        assert frozen.assert_login(
            store, account=account, authenticator_data=frozen.authenticator_data(sign_count=0)
        ) == account.id


def test_a_registration_ceremony_of_the_wrong_type_is_refused(store):
    account = store.create(name="Liam", password="p")
    key = SoftAuthenticator()
    options = registration_options(store=store, account=account, party=PARTY)
    with pytest.raises(WebAuthnError, match="not 'webauthn.create'"):
        verify_registration(
            store=store, account_id=account.id, party=PARTY, credential_id=key.credential_id,
            public_key=key.spki, algorithm=ES256,
            client_data_json=key.client_data(options["challenge"], kind="webauthn.get"),
        )


def test_registration_options_exclude_keys_already_held(store):
    account = store.create(name="Liam", password="p")
    key = SoftAuthenticator()
    key.register(store, account)
    options = registration_options(store=store, account=account, party=PARTY)
    assert [entry["id"] for entry in options["excludeCredentials"]] == [key.credential_id]
    assert {entry["alg"] for entry in options["pubKeyCredParams"]} == {ES256, RS256}
    # The user handle is derived, not the account name in the clear.
    assert account.name not in options["user"]["id"]


def test_a_junk_public_key_is_refused_at_registration(store):
    account = store.create(name="Liam", password="p")
    with pytest.raises(ValueError, match="readable SPKI"):
        store.add_passkey(account_id=account.id, credential_id="c", public_key=b64url(b"not-a-key"),
                          algorithm=ES256)


def test_relying_party_falls_back_to_the_requests_own_origin(monkeypatch):
    monkeypatch.delenv("CONTENT_STUDIO_WEBAUTHN_RP_ID", raising=False)
    monkeypatch.delenv("CONTENT_STUDIO_WEBAUTHN_ORIGINS", raising=False)
    party = RelyingParty.for_request(host="studio.tail1234.ts.net", scheme="https")
    assert party.rp_id == "studio.tail1234.ts.net"
    assert party.accepts("https://studio.tail1234.ts.net")
    assert not party.accepts("https://evil.example")

    monkeypatch.setenv("CONTENT_STUDIO_WEBAUTHN_RP_ID", "pinned.example")
    monkeypatch.setenv("CONTENT_STUDIO_WEBAUTHN_ORIGINS", "https://pinned.example,http://localhost:8765")
    pinned = RelyingParty.for_request(host="studio.tail1234.ts.net", scheme="https")
    assert pinned.rp_id == "pinned.example"
    assert pinned.accepts("http://localhost:8765")
    assert not pinned.accepts("https://studio.tail1234.ts.net")
