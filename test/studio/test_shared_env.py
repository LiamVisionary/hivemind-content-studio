from __future__ import annotations

import os
from pathlib import Path

from fastapi.testclient import TestClient

from hivemind_content_studio.control_api import build_control_app
from hivemind_content_studio.shared_env import apply_shared_hive_env


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
