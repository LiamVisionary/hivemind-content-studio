"""`GET /api/doctor` — the one answer the Models page reads.

Three claims, one test each:

1. the shape is stable, because the store cards read it field by field to write
   a hardware-fit line ("fits your 36 GB Mac" / "needs a rented GPU");
2. it is owner-gated, because it names this machine's folders and what is
   installed on it;
3. it never carries a secret — asserted against a real credential-shaped value
   planted in the environment, not against a naming convention.

The deadline is the fourth claim and it is checked directly: a section that
hangs must not hold the page.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from hivemind_content_studio import doctor as doctor_module
from hivemind_content_studio import settings as settings_module
from hivemind_content_studio.control_api import build_control_app
from hivemind_content_studio.hardware import hardware_profile, model_inventory
from hivemind_content_studio.orchestrator import ContentOrchestrator
from hivemind_content_studio.private_access import OwnerAccess, PrivateFieldCipher
from hivemind_content_studio.run_store import RunStore

OWNER_PASSWORD = "owner-passphrase"
PLANTED_SECRET = "sk-planted-doctor-secret-9f21c4"


@pytest.fixture()
def machine(tmp_path: Path, monkeypatch):
    """A machine with its own settings document and its own models root."""
    models_root = tmp_path / "comfy" / "ComfyUI"
    (models_root / "models" / "checkpoints").mkdir(parents=True)
    (models_root / "models" / "checkpoints" / "z_image_turbo-Q4_K.gguf").write_bytes(b"weights")
    (models_root / "models" / "checkpoints" / "notes.txt").write_text("not a weight")
    (models_root / "models" / "loras").mkdir()
    (models_root / "models" / "loras" / "a-style.safetensors").write_bytes(b"lora")
    monkeypatch.setenv("CONTENT_STUDIO_SETTINGS_FILE", str(tmp_path / "settings.json"))
    monkeypatch.setenv("COMFY_DIR", str(models_root))
    monkeypatch.setenv("OPENAI_API_KEY", PLANTED_SECRET)
    settings_module.forget_cached_settings()
    doctor_module.forget_doctor_cache()
    yield models_root
    settings_module.forget_cached_settings()
    doctor_module.forget_doctor_cache()


def _app(tmp_path: Path):
    cipher = PrivateFieldCipher.from_secret(b"test-private-state-secret")
    return build_control_app(
        orchestrator=ContentOrchestrator(RunStore(tmp_path / "state.sqlite3")),
        control_token="control-secret",
        operator_token="operator-secret",
        owner_access=OwnerAccess.for_testing(password=OWNER_PASSWORD, cipher=cipher),
        private_cipher=cipher,
    )


@pytest.fixture()
def client(tmp_path: Path, machine) -> TestClient:
    client = TestClient(_app(tmp_path))
    assert client.post("/api/accounts/unlock", json={"account_id": 1, "password": OWNER_PASSWORD}).status_code == 200
    return client


def test_the_report_carries_the_four_things_a_store_card_reads(client, machine):
    payload = client.get("/api/doctor").json()

    assert set(payload) >= {"ok", "checks", "providers", "runtime", "hardware", "models", "version"}
    # The CLI's own checks, unchanged — this route merges them, it does not
    # grow a second copy of them.
    assert {"python", "ffmpeg", "ffprobe"} <= set(payload["checks"])

    hardware = payload["hardware"]
    assert set(hardware) >= {"platform", "arch", "ram_gb", "accelerator", "models_root", "free_disk_gb"}
    assert hardware["models_root"] == str(machine)
    assert hardware["accelerator"]["class"] in {"apple-silicon", "nvidia", "cpu"}
    # The two numbers the fit line is written from have to be numbers.
    assert hardware["ram_gb"] is None or hardware["ram_gb"] > 0
    assert hardware["free_disk_gb"] is None or hardware["free_disk_gb"] >= 0

    # Weights you could pick in a studio. A LoRA is an accessory to a model,
    # not a model, and a stray .txt is not inventory.
    assert payload["models"]["runnable"] == 1
    assert payload["models"]["root_exists"] is True


def test_the_report_is_owner_gated(tmp_path: Path, machine):
    locked = TestClient(_app(tmp_path))
    assert locked.get("/api/doctor").status_code == 401


def test_no_credential_value_reaches_the_report(client):
    body = json.dumps(client.get("/api/doctor").json())
    # The planted key is set, so the providers section reports it as CONFIGURED
    # — the test is that the value itself never travels.
    assert PLANTED_SECRET not in body
    assert "sk-" not in body


def test_a_hung_probe_does_not_hold_the_page(monkeypatch, machine):
    def never() -> dict:
        time.sleep(30)
        return {"ok": True}

    monkeypatch.setattr(
        doctor_module,
        "_section_builders",
        lambda: {"checks": never, "runtime": dict, "hardware": hardware_profile, "models": model_inventory},
    )
    doctor_module.forget_doctor_cache()
    started = time.monotonic()
    report = doctor_module.collect_report(deadline_seconds=0.4)
    elapsed = time.monotonic() - started

    assert elapsed < 5.0, "the deadline, not the slowest probe, decides when this answers"
    # Nothing was ever computed for that section, so it says so rather than
    # reporting a machine that failed its checks.
    assert report["checks"] == {}
    assert report["ok"] is False
    assert report["models"]["runnable"] == 1


def test_a_second_ask_is_served_from_the_cache(client):
    client.get("/api/doctor")
    started = time.monotonic()
    again = client.get("/api/doctor")
    assert again.status_code == 200
    assert time.monotonic() - started < 1.0
