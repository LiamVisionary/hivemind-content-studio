"""Hosted SAM3 masking client: the money path and the refusals.

Every test here drives the real module against a fake opener — the point is
what the studio SENDS and how it reads what comes back, not whether Cloudflare
is up.
"""

from __future__ import annotations

import base64
import io
import json

import pytest

from hivemind_content_studio import hivemindos_sam3
from hivemind_content_studio.hivemindos_models import HivemindosModelsError


class _Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


class _HttpError(Exception):
    def __init__(self, code: int, payload: dict):
        self.code = code
        self._payload = payload

    def read(self):
        return json.dumps(self._payload).encode()


def _opener(script):
    """Answer each request from `script`, and record what was asked."""
    calls = []

    def opener(request, timeout=None):  # noqa: ARG001
        body = json.loads(request.data.decode()) if request.data else None
        calls.append({"url": request.full_url, "method": request.get_method(),
                      "headers": dict(request.headers), "body": body})
        answer = script[min(len(calls) - 1, len(script) - 1)]
        if isinstance(answer, _HttpError):
            import urllib.error
            raise urllib.error.HTTPError(request.full_url, answer.code, "", {}, io.BytesIO(answer.read()))
        return _Response(json.dumps(answer).encode())

    opener.calls = calls
    return opener


@pytest.fixture()
def clip(tmp_path):
    path = tmp_path / "shot.mp4"
    path.write_bytes(b"\x00\x01\x02fake-mp4-bytes")
    return path


@pytest.fixture(autouse=True)
def _connected(monkeypatch):
    monkeypatch.setattr(hivemindos_sam3, "credit_token", lambda: "hmos_credit_" + "x" * 24)


def test_a_finished_mask_comes_back_as_bytes_with_what_it_cost(clip, monkeypatch):
    """The studio is handed the mask itself, not a URL — the graph loads BYTES,
    and a URL would make the lane fetch from a third party mid-render."""
    mask = base64.b64encode(b"mask-clip-bytes").decode()
    opener = _opener([
        {"ok": True, "mask": {"id": "sam3_abc", "status": "queued"}},
        {"ok": True, "mask": {"id": "sam3_abc", "status": "running"}},
        {"ok": True, "mask": {"id": "sam3_abc", "status": "complete", "frames": 121,
                              "chargedUsd": 0.05, "maskVideoUrl": f"data:video/mp4;base64,{mask}"}},
    ])
    result = hivemindos_sam3.mask_video(
        video=clip, frames=121, width=1280, height=720,
        opener=opener, sleeper=lambda _s: None,
    )
    assert result["mask_base64"] == mask
    assert result["charged_usd"] == 0.05

    submit = opener.calls[0]
    assert submit["method"] == "POST" and submit["url"].endswith("/v1/masks")
    # The clip goes up inline, and the numbers the price is quoted from ride with it.
    assert submit["body"]["video_base64"] == base64.b64encode(clip.read_bytes()).decode()
    assert submit["body"]["frames"] == 121
    # The credit token authenticates it — and is a HEADER, never a query param.
    assert submit["headers"].get("X-hivemindos-credit-token", "").startswith("hmos_credit_")
    assert "hmos_credit" not in submit["url"]
    # Idempotency is not optional: without a key a retry reserves twice.
    assert submit["body"]["idempotency_key"]


def test_a_low_balance_is_reported_with_the_action_that_fixes_it(clip):
    """402 is the one failure a person can actually fix, and "payment required"
    is not the sentence that tells them how."""
    opener = _opener([_HttpError(402, {"ok": False, "error": "Balance is too low for this mask."})])
    with pytest.raises(HivemindosModelsError) as caught:
        hivemindos_sam3.mask_video(video=clip, frames=121, width=1280, height=720,
                                   opener=opener, sleeper=lambda _s: None)
    assert caught.value.remedy == "top-up"
    assert "too low" in str(caught.value)


def test_a_disconnected_account_is_told_to_connect_before_anything_uploads(clip, monkeypatch):
    monkeypatch.setattr(hivemindos_sam3, "credit_token", lambda: "")
    opener = _opener([{"ok": True}])
    with pytest.raises(HivemindosModelsError) as caught:
        hivemindos_sam3.mask_video(video=clip, frames=121, width=1280, height=720, opener=opener)
    assert caught.value.remedy == "connect"
    # The clip never left the machine.
    assert opener.calls == []


def test_a_failed_mask_says_nothing_was_charged(clip):
    """The gateway refunds a failed run in full. The studio has to SAY so, or
    the owner assumes they paid for the failure."""
    opener = _opener([
        {"ok": True, "mask": {"id": "sam3_abc", "status": "queued"}},
        {"ok": True, "mask": {"id": "sam3_abc", "status": "failed", "error": "no subject was found"}},
    ])
    with pytest.raises(HivemindosModelsError) as caught:
        hivemindos_sam3.mask_video(video=clip, frames=121, width=1280, height=720,
                                   opener=opener, sleeper=lambda _s: None)
    assert "Nothing was charged" in str(caught.value)
    assert caught.value.remedy == "retry"


def test_an_approved_ceiling_over_the_cap_is_refused_locally(clip):
    """A studio bug must not be able to approve more than a mask is ever worth."""
    opener = _opener([{"ok": True}])
    with pytest.raises(ValueError):
        hivemindos_sam3.mask_video(video=clip, frames=121, width=1280, height=720,
                                   maximum_debit_usd=50, opener=opener)
    assert opener.calls == []


def test_the_service_being_off_is_a_sentence_with_an_alternative(clip):
    opener = _opener([_HttpError(503, {"ok": False, "error": "Hosted SAM3 masking is not enabled."})])
    with pytest.raises(HivemindosModelsError) as caught:
        hivemindos_sam3.mask_video(video=clip, frames=121, width=1280, height=720,
                                   opener=opener, sleeper=lambda _s: None)
    assert "own lane" in str(caught.value) and "by hand" in str(caught.value)


def test_a_quote_costs_nothing_and_sends_no_footage():
    opener = _opener([{"ok": True, "quote": {"consumerPriceUsd": 0.05, "frames": 121}}])
    quote = hivemindos_sam3.quote(frames=121, width=1280, height=720, opener=opener)
    assert quote["consumerPriceUsd"] == 0.05
    assert "video_base64" not in (opener.calls[0]["body"] or {})
    # A quote is not an authenticated act — it must not need a token to answer.
    assert "X-hivemindos-credit-token" not in opener.calls[0]["headers"]


def test_status_never_raises_when_the_service_is_unreachable():
    """The dialog asks this on open. An exception there would take the dialog
    down over a service the user may not even want."""
    def opener(_request, timeout=None):  # noqa: ARG001
        raise OSError("no route to host")
    assert hivemindos_sam3.status(opener=opener) == {
        "available": False, "configured": False, "connected": True,
    }


def test_every_request_names_itself_or_cloudflare_answers_403(clip):
    """A missing User-Agent is a 403 nobody would guess from the symptom.

    MEASURED 2026-09-01 against the sibling restore-gateway, deployed on the same
    workers.dev account: Cloudflare answers 403 to urllib's default
    `Python-urllib/3.11` in front of our OWN worker, before the request reaches a
    line of its code. The symptom is a service that is permanently "could not be
    reached" while every unit test passes and curl works. This client has never
    been deployed, so it had never hit it.
    """
    mask = base64.b64encode(b"m").decode()
    opener = _opener([
        {"ok": True, "mask": {"id": "sam3_abc", "status": "queued"}},
        {"ok": True, "mask": {"id": "sam3_abc", "status": "complete", "frames": 1,
                              "chargedUsd": 0.05, "maskVideoUrl": f"data:video/mp4;base64,{mask}"}},
    ])
    hivemindos_sam3.mask_video(
        video=clip, frames=1, width=64, height=64, opener=opener, sleeper=lambda _s: None)
    assert opener.calls
    for call in opener.calls:
        agent = call["headers"].get("User-agent", "")
        assert agent, f"{call['url']} was sent without a User-Agent"
        assert "urllib" not in agent.lower()


def test_the_health_check_names_itself_too(clip):
    opener = _opener([{"ok": True, "enabled": True, "configured": True}])
    hivemindos_sam3.status(opener=opener)
    assert "urllib" not in opener.calls[0]["headers"].get("User-agent", "").lower()
