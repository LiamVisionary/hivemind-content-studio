# SPDX-License-Identifier: Apache-2.0
"""LM Studio as a local LLM provider.

The idea is from upstream PR harry0703/MoneyPrinterTurbo#1255, rebuilt here
rather than merged — that PR could not apply to this fork, and it also carried
seven unrelated voice `.wav` files.

LM Studio and Ollama are the same shape of problem: an OpenAI-compatible server
listening on loopback, whose address depends on whether this process is inside
a container. So they share one resolver and differ only in port.
"""

from __future__ import annotations

from app.config import config
from app.models import llm_provider


def test_lmstudio_is_in_the_registry():
    spec = {p.provider_id: p for p in llm_provider.LLM_PROVIDER_REGISTRY}["lmstudio"]
    assert spec.default_label == "LM Studio"


def test_a_key_is_never_required():
    """LM Studio does not check credentials. Demanding one would block the
    common case — a model loaded locally — behind a field with no answer."""
    spec = {p.provider_id: p for p in llm_provider.LLM_PROVIDER_REGISTRY}["lmstudio"]
    assert spec.requires_api_key is False


def test_the_key_field_is_still_offered():
    """Not required is not the same as not useful. Once the server is exposed
    past loopback it is normally behind a proxy that wants a token, and that
    has to be settable without hand-editing config.toml."""
    spec = {p.provider_id: p for p in llm_provider.LLM_PROVIDER_REGISTRY}["lmstudio"]
    assert spec.show_api_key is True


def test_the_default_address_is_lm_studios_port(monkeypatch):
    monkeypatch.setattr(config, "is_running_in_container", lambda: False)
    assert config.get_default_lmstudio_base_url() == "http://localhost:1234/v1"


def test_ollama_keeps_its_own_port_through_the_shared_resolver(monkeypatch):
    """The refactor must not make the two services share an address."""
    monkeypatch.setattr(config, "is_running_in_container", lambda: False)
    assert config.get_default_ollama_base_url() == "http://localhost:11434/v1"


def test_in_a_container_it_reaches_the_host_not_itself(monkeypatch):
    """`localhost` inside a container is the container. A local model server on
    the host is unreachable that way, and the failure reads as "no model"."""
    monkeypatch.setattr(config, "is_running_in_container", lambda: True)
    monkeypatch.setattr(config, "_can_resolve_hostname", lambda _: True)
    assert config.get_default_lmstudio_base_url() == "http://host.docker.internal:1234/v1"


def test_a_container_with_no_host_gateway_name_falls_back_to_its_gateway_ip(monkeypatch):
    monkeypatch.setattr(config, "is_running_in_container", lambda: True)
    monkeypatch.setattr(config, "_can_resolve_hostname", lambda _: False)
    monkeypatch.setattr(config, "get_container_default_gateway_ip", lambda: "172.17.0.1")
    assert config.get_default_lmstudio_base_url() == "http://172.17.0.1:1234/v1"


def test_the_example_config_documents_the_loopback_trap():
    """LM Studio binds 127.0.0.1 by default, so a container cannot reach it even
    through the host gateway. Someone hitting that gets a connection error and
    no clue that a checkbox in the app is the fix."""
    text = open("config.example.toml", encoding="utf-8").read()
    assert "lmstudio_base_url" in text
    assert "Serve on Local Network" in text or "--bind 0.0.0.0" in text


def test_an_unconfigured_lmstudio_reaches_the_default_rather_than_being_refused(monkeypatch):
    """The check that matters. `requires_base_url` is True for this provider, so
    if the runtime default were resolved AFTER validation, a working local setup
    would be refused for a base_url the user should never have to type."""
    from app.services import llm

    monkeypatch.setattr(config, "is_running_in_container", lambda: False)
    seen = {}

    class _FakeClient:
        def __init__(self, **kw):
            seen.update(kw)
            self.chat = type("C", (), {"completions": type("D", (), {
                "create": staticmethod(lambda **_: type("R", (), {"choices": [
                    type("X", (), {"message": type("M", (), {"content": "ok"})()})()]})())})()})()

    monkeypatch.setattr(llm, "OpenAI", _FakeClient, raising=False)
    app_config = {
        "llm_provider": "lmstudio",
        "lmstudio_model_name": "some-local-model",
        "lmstudio_api_key": "",
        "lmstudio_base_url": "",
    }
    llm._generate_response("hello", app_config=app_config)
    assert seen.get("base_url") == "http://localhost:1234/v1"
    assert seen.get("api_key") == "lm-studio", "the SDK requires a non-empty key"
