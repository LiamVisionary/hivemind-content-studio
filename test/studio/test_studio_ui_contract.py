from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
UI_ROOT = ROOT / "src" / "hivemind_content_studio" / "ui"


def test_ui_uses_progressive_disclosure_for_advanced_configuration() -> None:
    html = (UI_ROOT / "index.html").read_text(encoding="utf-8")

    assert 'id="studio-shell"' in html
    assert 'id="create-run-form"' in html
    assert html.count("<details") >= 4
    assert "Providers &amp; routing" in html
    assert "Voice, audio &amp; captions" in html
    assert "Distribution" in html
    assert "Operator controls" in html


def test_simple_mode_is_default_and_reuses_the_chat_composer_media_card_contract() -> None:
    html = (UI_ROOT / "index.html").read_text(encoding="utf-8")
    javascript = (UI_ROOT / "studio.js").read_text(encoding="utf-8")

    assert 'id="simple-composer"' in html
    assert 'id="simple-brain"' in html
    assert 'id="simple-image-route"' in html
    assert 'id="simple-video-route"' in html
    assert 'id="simple-prompt-helper" type="checkbox" checked' in html
    assert 'id="simple-walkthrough"' in html
    assert 'id="simple-image-input"' in html and "multiple" in html
    assert 'id="advanced-studio"' in html
    assert "switchCreateMode('simple')" in javascript
    assert "generation-card" in javascript
    assert "state.simpleAttachments" in javascript


def test_simple_runs_use_hivemind_application_generation_cards_not_a_run_summary_card() -> None:
    javascript = (UI_ROOT / "studio.js").read_text(encoding="utf-8")
    css = (UI_ROOT / "studio.css").read_text(encoding="utf-8")

    assert "buildRunGenerationCards" in javascript
    assert "renderApplicationGenerationCard" in javascript
    assert 'data-generation-kind="${esc(card.kind)}"' in javascript
    assert "generationArtifactUrl" in javascript
    assert "data-generation-preview" in javascript
    assert "application-generation-progress" in javascript
    assert "application-generation-source" in javascript
    assert ".application-generation-card" in css
    assert ".application-generation-canvas" in css
    assert ".application-generation-image-grid" in css
    assert "function renderRunGenerationCard(" not in javascript


def test_simple_route_pickers_use_searchable_auth_grouped_provider_popovers() -> None:
    html = (UI_ROOT / "index.html").read_text(encoding="utf-8")
    javascript = (UI_ROOT / "studio.js").read_text(encoding="utf-8")
    css = (UI_ROOT / "studio.css").read_text(encoding="utf-8")

    assert html.count('class="route-picker') >= 3
    assert 'data-route-search="brain"' in html
    assert 'data-route-search="image"' in html
    assert 'data-route-search="video"' in html
    assert '<select id="simple-brain"' not in html
    assert "ROUTE_AUTH_SECTIONS" in javascript
    assert "API key" in javascript and "OAuth" in javascript and "Local & managed" in javascript
    assert "data-provider-toggle" in javascript
    assert "routePickerMatches" in javascript
    assert "event.key === 'Escape'" in javascript
    assert ".route-popover" in css
    assert ".route-auth-section.is-api" in css
    assert ".route-auth-section.is-oauth" in css


def test_ui_is_same_origin_and_does_not_use_browser_storage_for_durable_state() -> None:
    javascript = (UI_ROOT / "studio.js").read_text(encoding="utf-8")

    assert "fetch(path" in javascript
    assert "api('/api/catalog')" in javascript
    assert "api('/api/runs'" in javascript
    assert "localStorage" not in javascript
    assert "sessionStorage" not in javascript
    assert "http://127.0.0.1" not in javascript


def test_ui_has_live_loading_feedback_and_reduced_motion_support() -> None:
    css = (UI_ROOT / "studio.css").read_text(encoding="utf-8")
    javascript = (UI_ROOT / "studio.js").read_text(encoding="utf-8")

    assert "@media (prefers-reduced-motion: reduce)" in css
    assert ".skeleton" in css
    assert ".spinner" in css
    assert "aria-busy" in javascript
    assert "Creating…" in javascript


def test_duplicate_as_variant_preserves_advanced_configuration() -> None:
    javascript = (UI_ROOT / "studio.js").read_text(encoding="utf-8")

    assert "selectLane(run.lane, { resetDefaults: false })" in javascript
    assert "brief.aspect_ratio" in javascript
    assert "brief.voice?.voice_id" in javascript
    assert "brief.clip_duration_seconds" in javascript
    assert "run.providers || brief.providers" in javascript


def test_latest_run_and_run_history_can_restore_the_simple_composer() -> None:
    javascript = (UI_ROOT / "studio.js").read_text(encoding="utf-8")

    assert "data-use-run-in-composer" in javascript
    assert "loadRunIntoSimpleComposer" in javascript
    assert "entry?.composer" in javascript
    assert "await loadPrompts({ quiet: true })" in javascript
    assert "restoreLatestRunInComposer" in javascript


def test_run_history_restores_reference_images_and_reuses_canonical_artifacts() -> None:
    javascript = (UI_ROOT / "studio.js").read_text(encoding="utf-8")

    assert "restoreRunAttachments" in javascript
    assert "reference_artifacts" in javascript
    assert "sourceRunId" in javascript
    assert "item.file || await fetch(item.url)" in javascript
    assert "renderSimpleAttachments()" in javascript


def test_generation_telemetry_has_a_compact_agent_first_view() -> None:
    html = (UI_ROOT / "index.html").read_text(encoding="utf-8")
    javascript = (UI_ROOT / "studio.js").read_text(encoding="utf-8")
    css = (UI_ROOT / "studio.css").read_text(encoding="utf-8")

    assert 'data-view-target="telemetry"' in html
    assert 'data-view="telemetry"' in html
    assert 'id="telemetry-summary"' in html
    assert "api('/api/telemetry/generations')" in javascript
    assert "renderGenerationTelemetry" in javascript
    assert ".telemetry-summary" in css


def test_unified_studio_has_native_modes_and_embedded_tool_surfaces() -> None:
    html = (UI_ROOT / "index.html").read_text(encoding="utf-8")
    javascript = (UI_ROOT / "studio.js").read_text(encoding="utf-8")
    css = (UI_ROOT / "studio.css").read_text(encoding="utf-8")

    assert '<span>Studio</span>' in html
    assert 'id="native-studio-modes"' in html
    assert 'data-studio-mode="create"' in html
    assert 'data-studio-mode="edit"' in html
    assert 'data-studio-mode="animate"' in html
    assert 'data-studio-mode="workflow"' in html
    assert "selectNativeStudioMode" in javascript
    assert "studioMode: state.studioMode" in javascript
    assert "composer.studioMode" in javascript
    assert ".native-mode-rail" in css
    assert '<span>Explore</span>' in html
    assert '<span>Canvas</span>' in html
    assert '<span>Models</span>' in html
    assert 'data-tool-surface="explore"' in html
    assert 'data-tool-surface="canvas"' in html
    assert 'data-tool-surface="models"' in html
    assert "loadToolSurface" in javascript
    assert "bindLocalAiBridge" in javascript
    assert "api('/api/surfaces')" in javascript
    assert ".tool-view iframe" in css
    assert "workspace-board" not in html
    assert "data-open-workspace" not in javascript
    assert "api('/api/runtime')" not in javascript
    assert "Composite application" not in html


def test_manual_refresh_rechecks_provider_readiness() -> None:
    javascript = (UI_ROOT / "studio.js").read_text(encoding="utf-8")

    assert "if (!state.catalog || !quiet) state.catalog = await api('/api/catalog')" in javascript


def test_provider_view_exposes_safe_oauth_connection_controls() -> None:
    html = (UI_ROOT / "index.html").read_text(encoding="utf-8")
    javascript = (UI_ROOT / "studio.js").read_text(encoding="utf-8")

    assert 'id="oauth-board"' in html
    assert "api('/api/oauth')" in javascript
    assert "`/api/oauth/${provider}/start`" in javascript
    assert "window.open(result.authorize_url" in javascript
    assert "OPENAI_API_KEY" in javascript
    assert "GPT Image" in javascript
    assert "card.ready || card.needsReconnect" in javascript


def test_composer_supports_ingredients_drag_drop_history_and_autoscroll() -> None:
    html = (UI_ROOT / "index.html").read_text(encoding="utf-8")
    javascript = (UI_ROOT / "studio.js").read_text(encoding="utf-8")
    css = (UI_ROOT / "studio.css").read_text(encoding="utf-8")

    assert 'id="simple-ingredients"' in html
    assert 'id="ingredients-menu"' in html
    assert 'accept="image/*,.avif,.heic,.heif"' in html
    assert 'data-view="history"' in html
    assert 'data-view-target="history"' in html
    assert "addEventListener('drop'" in javascript
    assert "dataTransfer" in javascript
    assert "api('/api/simple/prompts')" in javascript
    assert "scrollThreadToLatest" in javascript
    assert "attachmentBrainData" in javascript
    assert ".simple-composer.is-dropping" in css
