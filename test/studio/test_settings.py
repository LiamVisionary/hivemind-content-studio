"""The machine's settings: one allow-list, one document, and an honest source.

Three claims are load-bearing here and each has a test that would fail loudly
if it stopped being true:

1. the round trip never returns a secret, and cannot be made to hold one;
2. every value says where it came from, including the case that matters —
   an environment variable pinning something different from the document;
3. the loopback ports the control plane used to hard-code are gone from the
   package, so moving the gateway is a setting rather than a code change.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from hivemind_content_studio import settings as settings_module
from hivemind_content_studio.control_api import build_control_app
from hivemind_content_studio.orchestrator import ContentOrchestrator
from hivemind_content_studio.private_access import OwnerAccess, PrivateFieldCipher
from hivemind_content_studio.run_store import RunStore
from hivemind_content_studio.settings import (
    SETTINGS,
    SETTINGS_BY_KEY,
    SettingsError,
    apply,
    describe,
    exported_env,
    load_settings,
    resolve,
    settings_path,
)

OWNER_PASSWORD = "owner-passphrase"
PACKAGE = Path(__file__).resolve().parents[2] / "src" / "hivemind_content_studio"


@pytest.fixture()
def document(tmp_path: Path, monkeypatch) -> Path:
    path = tmp_path / "settings.json"
    monkeypatch.setenv("CONTENT_STUDIO_SETTINGS_FILE", str(path))
    settings_module.forget_cached_settings()
    yield path
    settings_module.forget_cached_settings()


@pytest.fixture()
def client(tmp_path: Path, monkeypatch, document: Path) -> TestClient:
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))
    cipher = PrivateFieldCipher.from_secret(b"test-private-state-secret")
    app = build_control_app(
        orchestrator=ContentOrchestrator(RunStore(tmp_path / "state.sqlite3")),
        control_token="control-secret",
        operator_token="operator-secret",
        owner_access=OwnerAccess.for_testing(password=OWNER_PASSWORD, cipher=cipher),
        private_cipher=cipher,
    )
    client = TestClient(app)
    assert client.post("/api/accounts/unlock", json={"account_id": 1, "password": OWNER_PASSWORD}).status_code == 200
    return client


# ── the schema itself ────────────────────────────────────────────────────────

def test_no_setting_can_be_a_secret(document: Path):
    """Structural, not a review rule: the schema refuses credential-shaped keys."""
    credential = re.compile(r"key|token|secret|password|passphrase|credential", re.IGNORECASE)
    for spec in SETTINGS:
        assert not credential.search(spec.key), spec.key
        for name in spec.env:
            assert not credential.search(name), name

    # And the guard is live, not decorative.
    with pytest.raises(RuntimeError, match="PassBook"):
        settings_module._reject_secret_names(
            (
                settings_module.Setting(
                    key="network.api_key", kind="text", env=("SOME_API_KEY",),
                    default="x", restart_required=False, summary="",
                ),
            )
        )


def test_every_key_carries_a_default_validation_and_a_restart_flag(document: Path):
    for spec in SETTINGS:
        assert spec.default_value() is not None
        assert isinstance(spec.restart_required, bool)
        assert spec.summary.strip(), spec.key
    with pytest.raises(SettingsError, match="whole number"):
        SETTINGS_BY_KEY["network.control_port"].coerce("eight thousand")
    with pytest.raises(SettingsError, match="between 1024 and 65535"):
        SETTINGS_BY_KEY["network.control_port"].coerce(80)
    with pytest.raises(SettingsError, match="http"):
        SETTINGS_BY_KEY["network.gateway_url"].coerce("gateway.local:8787")
    with pytest.raises(SettingsError, match="on or off"):
        SETTINGS_BY_KEY["privacy.output_encryption"].coerce("maybe")
    with pytest.raises(SettingsError, match="no folder"):
        SETTINGS_BY_KEY["paths.models_root"].coerce("/Volumes/Typo/Models/ComfyUI")


# ── the round trip ───────────────────────────────────────────────────────────

def test_the_round_trip_reports_the_right_source_and_never_a_secret(client, document, monkeypatch, tmp_path):
    before = client.get("/api/settings")
    assert before.status_code == 200
    rows = {row["key"]: row for row in before.json()["settings"]}
    assert rows["paths.models_root"]["source"] == "default"
    assert rows["network.control_port"]["restart_required"] is True
    assert rows["reaper.grace_seconds"]["restart_required"] is False

    external = tmp_path / "Volumes" / "Models"
    external.mkdir(parents=True)
    saved = client.put("/api/settings", json={"values": {"paths.models_root": str(external)}})
    assert saved.status_code == 200, saved.text
    payload = saved.json()
    # A restart-required key says so instead of pretending it took effect.
    assert payload["restart_required"] == ["paths.models_root"]
    assert payload["changed"] == ["paths.models_root"]
    assert json.loads(document.read_text())["values"]["paths.models_root"] == str(external)

    after = {row["key"]: row for row in client.get("/api/settings").json()["settings"]}
    assert after["paths.models_root"]["value"] == str(external)
    assert after["paths.models_root"]["source"] == "file"
    # And the document is what the running process now reads.
    assert load_settings().paths.models_root == external

    # Nothing credential-shaped survives a trip through the API, whatever is in
    # the environment around it.
    monkeypatch.setenv("MUAPI_API_KEY", "sk-should-never-appear")
    body = json.dumps(client.get("/api/settings").json())
    assert "sk-should-never-appear" not in body
    assert not re.search(r"api_key|password|token", body, re.IGNORECASE)


def test_an_environment_variable_that_disagrees_is_named_rather_than_silent(document, monkeypatch):
    apply({"network.gateway_url": "http://127.0.0.1:9787"})
    monkeypatch.setenv("ZIMG_GATEWAY_URL", "http://gateway.local:8787")
    rows = {r["key"]: r for r in describe()["settings"]}
    pinned = rows["network.gateway_url"]
    assert pinned["value"] == "http://gateway.local:8787"
    assert pinned["source"] == "env" and pinned["env_override"] == "ZIMG_GATEWAY_URL"

    # The supervisor exports the document into the environment for the children;
    # that must NOT read back as somebody overriding the user's own choice.
    monkeypatch.setenv("ZIMG_GATEWAY_URL", "http://127.0.0.1:9787")
    same = {r["key"]: r for r in describe()["settings"]}["network.gateway_url"]
    assert same["source"] == "file" and same["env_override"] == ""


def test_a_value_this_machine_cannot_use_is_refused_with_a_sentence(client, document):
    refused = client.put("/api/settings", json={"values": {"network.control_port": "80"}})
    assert refused.status_code == 400
    assert "between 1024 and 65535" in refused.json()["detail"]
    unknown = client.put("/api/settings", json={"values": {"paths.somewhere_else": "/tmp"}})
    assert unknown.status_code == 400 and "no setting called" in unknown.json()["detail"]
    # A refusal leaves the document exactly as it was.
    assert not document.exists() or "control_port" not in document.read_text()


def test_reset_returns_a_key_to_its_default(client, document):
    client.put("/api/settings", json={"values": {"reaper.grace_seconds": 900}})
    assert load_settings().reaper.grace_seconds == 900
    reset = client.put("/api/settings", json={"reset": ["reaper.grace_seconds"]})
    assert reset.status_code == 200
    rows = {row["key"]: row for row in reset.json()["settings"]}
    assert rows["reaper.grace_seconds"]["value"] == 60
    assert rows["reaper.grace_seconds"]["source"] == "default"


def test_settings_are_owner_only(tmp_path, document, monkeypatch):
    cipher = PrivateFieldCipher.from_secret(b"test-private-state-secret")
    app = build_control_app(
        orchestrator=ContentOrchestrator(RunStore(tmp_path / "state.sqlite3")),
        control_token="control-secret",
        operator_token="operator-secret",
        owner_access=OwnerAccess.for_testing(password=OWNER_PASSWORD, cipher=cipher),
        private_cipher=cipher,
    )
    locked = TestClient(app)
    assert locked.get("/api/settings").status_code == 401
    assert locked.put("/api/settings", json={"values": {"reaper.autoreap": False}}).status_code == 401


def test_a_broken_document_boots_on_defaults_and_says_so(document: Path):
    document.write_text("{not json at all")
    payload = describe()
    assert payload["readable"] is False
    assert {row["source"] for row in payload["settings"]} <= {"default", "env"}


# ── the supervisor's half ────────────────────────────────────────────────────

def test_only_chosen_keys_are_exported_to_the_children(document: Path):
    assert exported_env() == {}
    apply({"lanes.ltx": True, "reaper.autoreap": False})
    assert exported_env() == {"COMFY_ENABLE_LTX_LANE": "1", "HIVEMIND_RENTAL_AUTOREAP": "0"}


def test_the_document_lives_with_the_machine_state(monkeypatch, tmp_path):
    monkeypatch.delenv("CONTENT_STUDIO_SETTINGS_FILE", raising=False)
    monkeypatch.setenv("HIVEMIND_MEDIA_STATE_DIR", str(tmp_path / "media-studio"))
    assert settings_path() == (tmp_path / "media-studio" / "content-studio" / "settings.json").resolve()


# ── the literals this replaced ───────────────────────────────────────────────

def test_the_hard_coded_loopback_literals_are_gone():
    """The five ports the control plane used to resolve by convention.

    A literal here is not a style problem: it is the reason a person with
    ComfyUI on 8189, or a gateway on another machine, had no way to say so.
    """
    ports = ("8787", "8788", "8794", "8796", "8188")
    pattern = re.compile(r"(?:127\.0\.0\.1|localhost):(?:" + "|".join(ports) + r")\b")
    offenders = []
    for path in sorted(PACKAGE.rglob("*.py")):
        if path.name == "settings.py":
            continue  # the one place these addresses are allowed to be written down
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if pattern.search(line) and "#" not in line.split(pattern.search(line).group())[0]:
                offenders.append(f"{path.name}:{number}: {line.strip()}")
    assert offenders == [], "these should read from settings.py instead:\n" + "\n".join(offenders)


def test_the_settings_reference_is_generated_from_the_schema():
    reference = PACKAGE.parents[1] / "docs" / "SETTINGS.md"
    assert reference.read_text(encoding="utf-8") == settings_module._docs(), (
        "docs/SETTINGS.md is stale — regenerate it with "
        "`python -m hivemind_content_studio.settings --docs > docs/SETTINGS.md`"
    )


def test_every_section_is_typed_and_reachable(document: Path):
    typed = load_settings()
    assert typed.network.control_port == 8765
    assert typed.privacy.output_encryption is True
    assert typed.lanes.ltx is False
    assert isinstance(typed.paths.models_root, Path)
    # resolve() covers every declared field; a section with an unmapped field
    # would raise here rather than report a value with no provenance.
    assert len(resolve()) == len(SETTINGS)
