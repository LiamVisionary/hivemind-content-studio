from __future__ import annotations

import json
from pathlib import Path

import pytest

from hivemind_content_studio.hivemindos_hosted_media import _dashboard_token, generate_hosted_media_asset


class FakeResponse:
    def __init__(self, payload: dict):
        self.payload = payload
        self.status = 200
        self.headers = {}

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self) -> bytes:
        return json.dumps(self.payload).encode("utf-8")


def test_dashboard_token_can_be_discovered_from_the_local_hivemind_env_file(tmp_path: Path, monkeypatch) -> None:
    env_file = tmp_path / ".env.local"
    env_file.write_text('HIVEMINDOS_DASHBOARD_DEVICE_TOKEN="local-token"\n', encoding="utf-8")
    monkeypatch.delenv("HIVEMINDOS_DASHBOARD_DEVICE_TOKEN", raising=False)
    monkeypatch.setenv("HIVEMINDOS_ENV_FILE", str(env_file))

    assert _dashboard_token() == "local-token"


def test_hosted_media_quotes_then_generates_and_polls_on_the_public_gateway(tmp_path: Path, monkeypatch) -> None:
    """The rail is the public Worker, not the desktop app.

    This module used to post every action to
    ``http://127.0.0.1:5020/api/hivemindos/media``, so hosted generation was
    dead whenever HivemindOS was closed — which, on a machine that only runs
    the studio, is always. Nothing about the rail needed the app; it needed
    the app's credit token, and the studio resolves one itself.
    """
    monkeypatch.setattr(
        "hivemind_content_studio.hivemindos_models.credit_token", lambda: "hmos_credit_demo")
    calls: list[dict] = []

    def opener(request, timeout):
        body = json.loads(request.data) if request.data else None
        calls.append({"url": request.full_url, "method": request.get_method(), "headers": dict(request.header_items()), "body": body, "timeout": timeout})
        if request.full_url.endswith("/quote"):
            return FakeResponse({"ok": True, "quote": {"priceUsd": 0.5, "category": "Text to Image"}})
        if request.full_url.endswith("/generate"):
            return FakeResponse({"ok": True, "job": {"id": "media_job12345678", "status": "processing"}, "billing": {"reservedUsd": 0.5}})
        return FakeResponse({"ok": True, "job": {"id": "media_job12345678", "status": "finalized", "outputs": ["https://cdn.example/output.png"], "billing": {"debitedUsd": 0.5, "markupBps": 2500}}})

    downloaded: list[tuple[str, Path]] = []
    result = generate_hosted_media_asset(
        model="flux-dev",
        payload={"prompt": "Clean product frame"},
        output=tmp_path / "frame.png",
        agent_id="content-company-agent",
        maximum_debit_usd=0.5,
        idempotency_key="run-1:keyframe:1",
        opener=opener,
        sleeper=lambda _seconds: None,
        downloader=lambda url, path: downloaded.append((url, path)) or path.write_bytes(b"image"),
    )

    assert [call["url"].rsplit("/api/media/managed", 1)[1] for call in calls] == [
        "/quote", "/generate", "/jobs/media_job12345678",
    ]
    assert all(call["url"].startswith("https://") for call in calls), "the rail is not on localhost"
    assert calls[1]["body"] == {"model": "flux-dev", "input": {"prompt": "Clean product frame"}, "maximumDebitUsd": 0.5}
    assert calls[1]["headers"]["X-hivemindos-credit-token"] == "hmos_credit_demo"
    assert calls[1]["headers"]["Idempotency-key"] == "run-1:keyframe:1"
    # Cloudflare 403s urllib's default agent; every call names the product.
    assert all("HivemindContentStudio" in call["headers"]["User-agent"] for call in calls)
    assert "X-hivemindos-device-token" not in calls[1]["headers"], "the device token is the app's, not the rail's"
    assert all("MUAPI" not in json.dumps(call) for call in calls)
    assert downloaded == [("https://cdn.example/output.png", tmp_path / "frame.png")]
    assert result["provider"] == "hivemindos-hosted-media"
    assert result["source_url"] == "https://cdn.example/output.png"
    assert result["billing"]["markupBps"] == 2500


def test_hosted_media_refuses_to_exceed_the_consumed_approval_maximum(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(
        "hivemind_content_studio.hivemindos_models.credit_token", lambda: "hmos_credit_demo")

    def opener(_request, timeout):
        assert timeout == 120
        return FakeResponse({"ok": True, "quote": {"priceUsd": 0.500001}})

    with pytest.raises(ValueError, match="approved maximum"):
        generate_hosted_media_asset(
            model="flux-dev",
            payload={"prompt": "x"},
            output=tmp_path / "frame.png",
            agent_id="agent",
            maximum_debit_usd=0.5,
            idempotency_key="run-1:keyframe:1",
            opener=opener,
        )


def test_the_catalogue_and_a_quote_need_no_credential_at_all(monkeypatch) -> None:
    """Public on purpose. A picker that could only price the rail after the
    owner connected an account would have nothing to show the person deciding
    whether to."""
    from hivemind_content_studio.hivemindos_hosted_media import hosted_media_catalog, hosted_media_quote

    monkeypatch.setattr(
        "hivemind_content_studio.hivemindos_models.credit_token", lambda: "")
    seen: list[dict] = []

    def opener(request, timeout):
        seen.append({"url": request.full_url, "headers": dict(request.header_items())})
        if request.full_url.endswith("/quote"):
            return FakeResponse({"ok": True, "quote": {"priceUsd": 1.5625, "category": "Text to Video"}})
        return FakeResponse({
            "ok": True, "configured": True, "markupBps": 2500, "maxDebitUsd": 25, "creditSlug": "default",
            "models": [{"id": "flux-schnell", "category": "Text to Image", "priceUsd": 0.002359}],
        })

    catalog = hosted_media_catalog(opener=opener)
    assert catalog["configured"] is True
    assert catalog["markup_bps"] == 2500
    assert [model["id"] for model in catalog["models"]] == ["flux-schnell"]

    quote = hosted_media_quote(model="flux-3-text-to-video", payload={"prompt": "x", "duration": 5}, opener=opener)
    assert quote["priceUsd"] == 1.5625
    assert all("X-hivemindos-credit-token" not in call["headers"] for call in seen)


def test_an_input_upload_is_refused_before_it_leaves_for_a_type_nothing_can_read(monkeypatch) -> None:
    from hivemind_content_studio.hivemindos_hosted_media import upload_input

    monkeypatch.setattr(
        "hivemind_content_studio.hivemindos_models.credit_token", lambda: "hmos_credit_demo")
    with pytest.raises(ValueError, match="cannot be sent"):
        upload_input(b"<script>", content_type="text/html")
    with pytest.raises(ValueError, match="empty"):
        upload_input(b"", content_type="image/png")

    sent: list[dict] = []

    def opener(request, timeout):
        sent.append({"url": request.full_url, "headers": dict(request.header_items()), "bytes": request.data})
        return FakeResponse({"ok": True, "input": {"id": "x.png", "url": "https://gateway.example/api/media/managed/inputs/x.png"}})

    url = upload_input(b"\x89PNG", content_type="image/png", opener=opener)
    assert url == "https://gateway.example/api/media/managed/inputs/x.png"
    assert sent[0]["url"].endswith("/api/media/managed/inputs")
    assert sent[0]["headers"]["Content-type"] == "image/png"
    assert sent[0]["headers"]["X-hivemindos-credit-token"] == "hmos_credit_demo"


def test_a_sealed_store_does_not_yield_ciphertext_as_the_device_token(tmp_path: Path, monkeypatch) -> None:
    """PassBook writes an encrypted value as the literal `hive-sealed:<...>`.

    Reading the store by splitting lines therefore does not fail on a sealed
    store — it succeeds with the ciphertext, which is a non-empty string that
    then travels to the dashboard as the device token. The request comes back
    unauthorised and nothing in the failure names the encryption. So the check
    is not "did we get a token" but "is what we got the sealed text".
    """
    import passbook

    home = tmp_path / "hive"
    monkeypatch.setenv("HIVE_HOME", str(home))
    monkeypatch.delenv("HIVE_ENV_FILES", raising=False)
    monkeypatch.delenv("HIVEMINDOS_DASHBOARD_DEVICE_TOKEN", raising=False)
    monkeypatch.delenv("HIVEMINDOS_ENV_FILE", raising=False)
    monkeypatch.delenv("HIVEMINDOS_PROJECT_ROOT", raising=False)
    passbook.ensure(app="test")

    # What a sealed store looks like on disk, written the way passbook_seal
    # leaves it. The value is deliberately not a real ciphertext; the prefix is
    # the whole point.
    env_path = passbook.env_path()
    env_path.write_text(
        'HIVEMINDOS_DASHBOARD_DEVICE_TOKEN="hive-sealed:v2:notarealciphertext"\n',
        encoding="utf-8",
    )

    token = _dashboard_token()
    assert not token.startswith("hive-sealed:"), (
        f"the sealed text was handed out as a device token: {token[:16]}..."
    )


def test_an_unsealed_store_value_still_reaches_the_caller(tmp_path: Path, monkeypatch) -> None:
    """The fallback has to keep working, or the fix above is just a deletion."""
    import passbook

    monkeypatch.setenv("HIVE_HOME", str(tmp_path / "hive"))
    monkeypatch.delenv("HIVE_ENV_FILES", raising=False)
    monkeypatch.delenv("HIVEMINDOS_DASHBOARD_DEVICE_TOKEN", raising=False)
    monkeypatch.delenv("HIVEMINDOS_ENV_FILE", raising=False)
    monkeypatch.delenv("HIVEMINDOS_PROJECT_ROOT", raising=False)
    passbook.ensure(app="test")
    passbook.set_values({"HIVEMINDOS_DASHBOARD_DEVICE_TOKEN": "from-the-store"})

    assert _dashboard_token() == "from-the-store"


def test_one_model_not_one_endpoint_per_row(monkeypatch) -> None:
    """The picker's row is a MODEL; the gateway's row is an ENDPOINT.

    `flux-3` is four rows upstream — text-to-image, image-to-image,
    text-to-video, image-to-video — which are four prices and one model. Listed
    as four, a reader has to know which suffix means "start from a picture".
    """
    from hivemind_content_studio.hivemindos_hosted_media import (
        consolidate_hosted_models, hosted_category_capability, hosted_model_base, hosted_model_label,
    )

    entries = [
        {"id": "flux-3-text-to-image", "category": "Text to Image", "priceUsd": 0.0625},
        {"id": "flux-3-image-to-image", "category": "Image to Image", "priceUsd": 0.075},
        {"id": "flux-3-text-to-video", "category": "Text to Video", "dynamicPricing": True},
        {"id": "flux-3-image-to-video", "category": "Image to Video", "dynamicPricing": True},
        {"id": "flux-schnell", "category": "Text to Image", "priceUsd": 0.002359, "automaticFallback": True},
        # Filed under a category its NAME contradicts. Real row, live catalogue.
        {"id": "infinitetalk-image-to-video", "category": "Audio to Video"},
        {"id": "infinitetalk-video-to-video", "category": "Video to Video"},
        # Nothing the studio has a home for.
        {"id": "hunyuan3d", "category": "Image to 3D"},
    ]
    rows = consolidate_hosted_models(entries)

    flux_image = next(row for row in rows["image"] if row["id"] == "flux-3")
    flux_video = next(row for row in rows["video"] if row["id"] == "flux-3")
    assert flux_image["label"] == "Flux 3"
    # One row per kind, carrying that kind's capabilities and their endpoints.
    assert flux_image["routes"] == {
        "text-to-image": {"model": "flux-3-text-to-image", "usd": 0.0625},
        "image-to-image": {"model": "flux-3-image-to-image", "usd": 0.075},
    }
    assert sorted(flux_video["routes"]) == ["image-to-video", "text-to-video"]
    # Dynamic pricing carries no figure: the number comes from a live quote.
    assert flux_video["routes"]["text-to-video"]["usd"] is None

    # A model with one endpoint keeps the id the gateway published rather than
    # having a shorter one invented for it.
    assert [row["id"] for row in rows["image"] if row["default"]] == ["flux-schnell"]

    # The capability is read off the CATEGORY, never the suffix.
    assert hosted_category_capability("Audio to Video") == ("video", "audio-to-video")
    assert sorted(next(row for row in rows["video"] if row["id"] == "infinitetalk")["routes"]) == [
        "audio-to-video", "video-to-video",
    ]

    # A category with no studio to run it in is listed nowhere.
    assert all(row["id"] != "hunyuan3d" for row in rows["image"] + rows["video"])

    assert hosted_model_base("flux-kontext-pro-i2i") == "flux-kontext-pro"
    assert hosted_model_base("flux-schnell") == "flux-schnell"
    # The gateway labels nothing, so the label is derived — and acronyms are
    # shouted, or every row reads "Gpt Image 2".
    assert hosted_model_label("gpt-image-2") == "GPT Image 2"
    assert hosted_model_label("ai-captions") == "AI Captions"


def test_which_endpoint_runs_follows_what_is_attached(monkeypatch) -> None:
    from hivemind_content_studio import hivemindos_hosted_media as media

    monkeypatch.setattr(media, "cached_hosted_media_catalog", lambda force=False: ({
        "configured": True, "markup_bps": 2500, "max_debit_usd": 25, "credit_slug": "default",
        "models": [
            {"id": "flux-3-text-to-video", "category": "Text to Video"},
            {"id": "flux-3-image-to-video", "category": "Image to Video"},
            {"id": "ai-captions", "category": "Video to Video"},
        ],
    }, True))

    assert media.hosted_route_for("flux-3", kind="video") == ("flux-3-text-to-video", "text-to-video")
    assert media.hosted_route_for("flux-3", kind="video", attached="image") == ("flux-3-image-to-video", "image-to-video")
    # An endpoint id a caller already resolved is left alone.
    assert media.hosted_route_for("flux-3-image-to-video", kind="video")[0] == "flux-3-image-to-video"
    # A model that cannot start from what is attached says so by name, rather
    # than letting the gateway answer with an unknown-model error.
    with pytest.raises(ValueError, match="AI Captions cannot start from that input"):
        media.hosted_route_for("ai-captions", kind="video")


def test_the_cache_file_holds_prices_and_the_catalogue_without_either_clobbering_the_other(tmp_path, monkeypatch) -> None:
    """Two things share the file and they land at different moments.

    The catalogue is written the instant the gateway answers; the prices a
    minute later, after 146 quotes. A process that saved the catalogue before
    its prices had been read off disk wrote `usd: {}` straight over a good
    file, and every row in the picker went back to having no number.
    """
    from hivemind_content_studio import hivemindos_hosted_media as media

    monkeypatch.setenv("CONTENT_STUDIO_DATA_DIR", str(tmp_path))
    media.forget_hosted_media_catalog()
    media._prices.update({"at": 0.0, "usd": {}, "refused": set()})

    # CONTENT_STUDIO_DATA_DIR really moves the file. It used to not: the path
    # asked load_config() for a `cache_dir` StudioConfig has never had, caught
    # the AttributeError, and fell through to ~/.cache on every machine — so
    # the suite read the developer's own warmed prices.
    assert media.price_cache_path() == tmp_path / "cache" / "hosted-media-prices.json"

    # A warmed run.
    media._prices.update({"at": 123.0, "usd": {"flux-3-text-to-image": 0.0625}, "refused": {"add-image-watermark"}})
    media._last_live_catalog = {"configured": True, "markup_bps": 2500, "max_debit_usd": 25,
                                "credit_slug": "default", "models": [{"id": "flux-3-text-to-image", "category": "Text to Image"}]}
    media._save_price_cache()

    # …and a FRESH process that answers the catalogue first, with no prices
    # loaded yet. It must not write its blank over the file.
    media._prices.update({"at": 0.0, "usd": {}, "refused": set()})
    media._save_price_cache()

    media._prices.update({"at": 0.0, "usd": {}, "refused": set()})
    assert media.hosted_price_usd("flux-3-text-to-image") == 0.0625
    assert media.hosted_endpoint_refused("add-image-watermark") is True

    # And the remembered catalogue is what keeps a slow boot from showing an
    # empty Hivemind tab: the models are not a thing to approximate.
    media._last_live_catalog = None
    assert media._remembered_catalog()["models"][0]["id"] == "flux-3-text-to-image"


def test_a_slow_catalogue_read_is_not_an_outage(tmp_path, monkeypatch) -> None:
    """One missed read must not grey out every model on the rail.

    The catalogue read is the studio's most expensive call — the gateway fans
    out to the upstream to build it — so on a cold boot it races the price
    warm and loses. The first /api/simple/catalog after a restart therefore
    reported the whole hosted account "Unavailable", and the browser kept
    that answer: 128 working models greyed out over one slow second.

    What is known when a read misses: this list ran before, its prices are
    real, and a press quotes the exact request before it spends — so a
    service that IS down surfaces its own error, with its own remedy, at the
    moment it matters.
    """
    from hivemind_content_studio import hivemindos_hosted_media as media

    monkeypatch.setenv("CONTENT_STUDIO_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(
        "hivemind_content_studio.hivemindos_models.credit_token", lambda: "hmos_credit_demo")
    media.forget_hosted_media_catalog()
    media._prices.update({"at": 0.0, "usd": {}, "refused": set()})

    remembered = {"configured": True, "markup_bps": 2500, "max_debit_usd": 25, "credit_slug": "default",
                  "models": [{"id": "flux-schnell", "category": "Text to Image", "priceUsd": 0.002359}]}

    # Nothing has ever answered: the only state that is honestly unreachable.
    monkeypatch.setattr(media, "hosted_media_catalog", lambda **_: (_ for _ in ()).throw(RuntimeError("boom")))
    cold = media.hosted_media_status()
    assert cold["reachable"] is False
    assert "did not answer" in cold["detail"]

    # …but once a list has landed, a later miss keeps offering it.
    media._last_live_catalog = remembered
    media._save_price_cache()
    media.forget_hosted_media_catalog()
    media._prices.update({"at": 0.0, "usd": {}, "refused": set()})
    stale = media.hosted_media_status()
    assert stale["reachable"] is True
    assert [model["id"] for model in stale["models"]] == ["flux-schnell"]
    assert "last published" in stale["detail"]
