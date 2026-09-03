from __future__ import annotations

import os
from pathlib import Path
from types import SimpleNamespace

from fastapi.testclient import TestClient

from hivemind_content_studio import shared_env
from hivemind_content_studio.control_api import build_control_app
from hivemind_content_studio.shared_env import apply_shared_hive_env


def _machine_store_request(monkeypatch, answer: dict[str, str]) -> list[list[str]]:
    """Point `request_credential` at a fake broker instead of the machine's.

    The autouse `HIVE_ENV_FILES` fixture is undone on purpose: the refusal
    memory only guards the machine-store path, so exercising it means walking
    that path — with the transport replaced, per the suite's own rule that the
    credential read is the boundary, not the variable.
    """
    calls: list[list[str]] = []

    def fake_request(keys, **kwargs):
        calls.append(list(keys))
        return dict(answer)

    monkeypatch.delenv("HIVE_ENV_FILES", raising=False)
    monkeypatch.setattr(shared_env.passbook, "request", fake_request)
    monkeypatch.setattr(shared_env.passbook, "workspace", lambda *a, **k: "test-workspace")
    monkeypatch.setattr(shared_env, "_refused", {})
    return calls


def test_shared_hive_env_fills_missing_values_without_overriding_process_env(tmp_path: Path, monkeypatch) -> None:
    env_file = tmp_path / "hive.env"
    env_file.write_text(
        "MUAPI_API_KEY=shared-muapi-secret\n"
        "ELEVENLABS_API_KEY='shared-eleven-secret'\n"
        "export UPLOAD_POST_USERNAME=shared-user\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("HIVE_ENV_FILES", str(env_file))
    monkeypatch.setenv("MUAPI_API_KEY", "process-muapi-secret")
    monkeypatch.delenv("ELEVENLABS_API_KEY", raising=False)
    monkeypatch.delenv("UPLOAD_POST_USERNAME", raising=False)

    loaded_keys = apply_shared_hive_env()

    assert os.environ["MUAPI_API_KEY"] == "process-muapi-secret"
    assert os.environ["ELEVENLABS_API_KEY"] == "shared-eleven-secret"
    assert os.environ["UPLOAD_POST_USERNAME"] == "shared-user"
    assert loaded_keys == {"ELEVENLABS_API_KEY", "UPLOAD_POST_USERNAME"}


def test_frontend_provider_catalog_uses_shared_env_but_never_returns_secrets(tmp_path: Path, monkeypatch) -> None:
    env_file = tmp_path / "hive.env"
    secrets = {
        "MUAPI_API_KEY": "shared-muapi-secret",
        "HIGGSFIELD_API_KEY_ID": "shared-higgs-id",
        "HIGGSFIELD_API_KEY_SECRET": "shared-higgs-secret",
        "ELEVENLABS_API_KEY": "shared-eleven-secret",
        "UPLOAD_POST_API_KEY": "shared-upload-secret",
        "UPLOAD_POST_USERNAME": "shared-user",
    }
    env_file.write_text("\n".join(f"{key}={value}" for key, value in secrets.items()) + "\n", encoding="utf-8")
    monkeypatch.setenv("HIVE_ENV_FILES", str(env_file))
    for key in secrets:
        monkeypatch.delenv(key, raising=False)

    response = TestClient(build_control_app(control_token="control-secret", operator_token="operator-secret")).get("/api/catalog")

    assert response.status_code == 200
    payload = response.json()
    providers = {
        provider["id"]: provider
        for role_providers in payload["providers_by_role"].values()
        for provider in role_providers
    }
    assert providers["muapi"]["available"] is True
    assert providers["higgsfield-cloud"]["available"] is True
    assert providers["elevenlabs"]["available"] is True
    assert providers["upload-post"]["available"] is True
    response_text = response.text
    assert all(secret not in response_text for secret in secrets.values())


def test_a_refused_credential_is_asked_about_once_per_backoff_window(monkeypatch) -> None:
    """A key the machine refuses must not be re-asked on every status poll.

    The studio's readiness polls come back every few seconds and each one used
    to reach the broker again, so one ungranted key filled the machine's access
    ledger with thousands of identical DENIED rows an hour. One ask per window,
    doubling to the cap, is the contract.
    """
    calls = _machine_store_request(monkeypatch, answer={})
    clock = {"now": 1000.0}
    monkeypatch.setattr(shared_env, "time", SimpleNamespace(monotonic=lambda: clock["now"]))

    assert shared_env.request_credential("UNGRANTED_KEY") == ""
    assert shared_env.request_credential("UNGRANTED_KEY") == ""
    assert len(calls) == 1, "a refusal inside its window must be answered from memory"

    clock["now"] += shared_env._REFUSAL_BACKOFF_START_SECONDS + 1
    assert shared_env.request_credential("UNGRANTED_KEY") == ""
    assert len(calls) == 2, "an expired window means one fresh ask"

    clock["now"] += shared_env._REFUSAL_BACKOFF_START_SECONDS + 1
    assert shared_env.request_credential("UNGRANTED_KEY") == ""
    assert len(calls) == 2, "the second refusal doubled the window"

    clock["now"] += shared_env._REFUSAL_BACKOFF_START_SECONDS
    assert shared_env.request_credential("UNGRANTED_KEY") == ""
    assert len(calls) == 3

    # The wait never grows past the ceiling, so a later grant is noticed
    # within five minutes no matter how long the key sat refused.
    for _ in range(10):
        clock["now"] += shared_env._REFUSAL_BACKOFF_CAP_SECONDS + 1
        shared_env.request_credential("UNGRANTED_KEY")
    assert shared_env._refused["UNGRANTED_KEY"][1] == shared_env._REFUSAL_BACKOFF_CAP_SECONDS


def test_a_grant_clears_the_refusal_memory_and_grants_are_never_cached(monkeypatch) -> None:
    answer: dict[str, str] = {}
    calls = _machine_store_request(monkeypatch, answer)
    clock = {"now": 1000.0}
    monkeypatch.setattr(shared_env, "time", SimpleNamespace(monotonic=lambda: clock["now"]))

    assert shared_env.request_credential("LATER_GRANTED_KEY") == ""
    clock["now"] += shared_env._REFUSAL_BACKOFF_START_SECONDS + 1

    answer["LATER_GRANTED_KEY"] = "granted-value"
    assert shared_env.request_credential("LATER_GRANTED_KEY") == "granted-value"
    assert "LATER_GRANTED_KEY" not in shared_env._refused

    # Granted reads keep going to the broker — a rotation shows up on the very
    # next ask, and every read keeps leaving its receipt.
    answer["LATER_GRANTED_KEY"] = "rotated-value"
    assert shared_env.request_credential("LATER_GRANTED_KEY") == "rotated-value"
    assert len(calls) == 3


def test_a_sealed_value_is_a_refusal_for_the_backoff_memory(monkeypatch) -> None:
    calls = _machine_store_request(monkeypatch, answer={"SEALED_KEY": "hive-sealed:v2:ciphertext"})

    assert shared_env.request_credential("SEALED_KEY") == ""
    assert shared_env.request_credential("SEALED_KEY") == ""
    assert len(calls) == 1, "a value this machine cannot open is absent, and absent backs off"


def test_redirected_processes_never_consult_or_feed_the_refusal_memory(monkeypatch, tmp_path: Path) -> None:
    """`HIVE_ENV_FILES` means a test or sandbox reading its own files — cheap,
    brokerless, ledgerless — and the suite depends on every call being fresh."""
    monkeypatch.setattr(shared_env, "_refused", {})
    monkeypatch.setenv("HIVE_ENV_FILES", str(tmp_path / "own.env"))

    assert shared_env.request_credential("ANY_KEY") == ""
    assert shared_env._refused == {}

    (tmp_path / "own.env").write_text("ANY_KEY=now-present\n", encoding="utf-8")
    assert shared_env.request_credential("ANY_KEY") == "now-present"
