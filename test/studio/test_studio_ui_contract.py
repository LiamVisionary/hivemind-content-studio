from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
UI_ROOT = ROOT / "src" / "hivemind_content_studio" / "ui"
OPEN_GEN_ROOT = ROOT / "packages" / "open-generative-ai" / "src"


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


def test_ui_is_same_origin_and_uses_session_storage_only_for_tab_scoped_owner_handoff() -> None:
    javascript = (UI_ROOT / "studio.js").read_text(encoding="utf-8")

    assert "fetch(path" in javascript
    assert "api('/api/catalog')" in javascript
    assert "api('/api/runs'" in javascript
    assert "Enter the operator token under Advanced to use protected run controls." not in javascript
    assert "localStorage" not in javascript
    assert "hivemind.ownerPassphrase.once" in javascript
    assert "readOwnerPassphrase" in javascript
    assert "sessionStorage.removeItem(OWNER_PASSPHRASE_STORAGE_KEY)" in javascript
    assert "http://127.0.0.1" not in javascript


def test_root_owner_gate_can_lock_and_handoff_to_canvas_without_url_credentials() -> None:
    html = (UI_ROOT / "index.html").read_text(encoding="utf-8")
    javascript = (UI_ROOT / "studio.js").read_text(encoding="utf-8")

    assert 'id="lock-button"' in html
    assert "api('/api/owner/lock'" in javascript
    assert "api('/api/owner/session'" in javascript
    assert "hivemind-owner-unlock" in javascript
    assert "hivemind-owner-unlock-ready" in javascript
    assert "hivemind-owner-lock" in javascript
    assert "ownerSession: true" in javascript
    assert "ownerAccessFrameForEvent" in javascript
    assert "postMessage" in javascript
    assert "passphrase=" not in javascript


def test_embedded_creative_surfaces_keep_prompts_and_outputs_out_of_persistent_browser_storage() -> None:
    image_studio = (OPEN_GEN_ROOT / "components" / "ImageStudio.js").read_text(encoding="utf-8")
    video_studio = (OPEN_GEN_ROOT / "components" / "VideoStudio.js").read_text(encoding="utf-8")
    private_bridge = (OPEN_GEN_ROOT / "lib" / "hivemindStudio.js").read_text(encoding="utf-8")
    pending_jobs = (OPEN_GEN_ROOT / "lib" / "pendingJobs.js").read_text(encoding="utf-8")

    assert "loadStudioGenerationHistory" in image_studio
    assert "saveStudioGenerationHistory" in image_studio
    assert "loadStudioGenerationHistory" in video_studio
    assert "saveStudioGenerationHistory" in video_studio
    assert "hivemind-owner-lock" in private_bridge
    assert "clearHivemindStudioPrivateState" in private_bridge
    assert "localStorage.removeItem('muapi_history')" in private_bridge
    assert "localStorage.removeItem('video_history')" in private_bridge
    assert "sessionStorage" in pending_jobs
    assert "isHivemindStudioEnabled" in pending_jobs
    assert "[ImageStudio] Full response:" not in image_studio
    assert "[VideoStudio] Hivemind local response:" not in video_studio


def test_media_playback_proxies_never_cache_decrypted_images_or_videos() -> None:
    gateway_root = ROOT / "packages" / "media-gateway"
    python_gateway = (gateway_root / "app.py").read_text(encoding="utf-8")
    next_proxy = (gateway_root / "app" / "comfy" / "[[...path]]" / "route.js").read_text(encoding="utf-8")

    assert '"Cache-Control", "private, no-store, max-age=0"' in python_gateway
    assert "max-age=10800" not in next_proxy
    assert "private, no-store, max-age=0" in next_proxy


def test_history_combines_owner_prompts_with_opaque_canvas_outputs() -> None:
    html = (UI_ROOT / "index.html").read_text(encoding="utf-8")
    javascript = (UI_ROOT / "studio.js").read_text(encoding="utf-8")
    css = (UI_ROOT / "studio.css").read_text(encoding="utf-8")

    assert 'data-history-filter="canvas"' in html
    assert "/api/canvas/history?" in javascript
    assert "canvasHistoryEntryCard" in javascript
    assert "entry.media_url" in javascript
    assert "entry.prompt" not in javascript[javascript.index("function canvasHistoryEntryCard"):javascript.index("function renderPromptHistory")]
    canvas_card = javascript[javascript.index("function canvasHistoryEntryCard"):javascript.index("function renderPromptHistory")]
    assert "data-load-canvas-video" in canvas_card
    assert '<video src="' not in canvas_card
    assert "function loadCanvasVideo" in javascript
    assert ".canvas-history-grid" in css


def test_history_uses_pagination_intersection_observers_filters_and_owner_action_menus() -> None:
    html = (UI_ROOT / "index.html").read_text(encoding="utf-8")
    javascript = (UI_ROOT / "studio.js").read_text(encoding="utf-8")

    assert 'id="canvas-format-filter"' in html
    assert 'id="canvas-model-filter"' in html
    assert 'id="history-delete-dialog"' in html
    assert 'id="simple-seed-mode"' in html
    assert 'id="simple-seed"' in html
    assert "new IntersectionObserver" in javascript
    assert "data-history-load-more" in javascript
    assert "hivemind-owner-history-request" in javascript
    assert "data-load-canvas-studio" in javascript
    assert "data-load-canvas-workflow" in javascript
    assert "data-copy-canvas-prompt" in javascript
    assert "data-delete-canvas-output" in javascript
    assert "navigator.clipboard.writeText" in javascript
    assert "confirm: true" in javascript


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
    assert 'data-view-target="explore"' in html
    assert '<span>Planner</span>' in html
    assert 'id="native-studio-modes"' in html
    assert 'data-studio-mode="create"' in html
    assert 'data-studio-mode="edit"' in html
    assert 'data-studio-mode="animate"' in html
    assert 'data-studio-mode="workflow"' in html
    assert "selectNativeStudioMode" in javascript
    assert "studioMode: state.studioMode" in javascript
    assert "composer.studioMode" in javascript
    assert ".native-mode-rail" in css
    assert "navigate(location.hash.slice(1) || 'explore')" in javascript
    assert "hivemindStudio=1" in javascript
    assert "hivemind-explore-insert-prompt" in javascript
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


def test_explore_core_embeds_hivemind_workflows_and_preserves_local_generation_paths() -> None:
    main = (OPEN_GEN_ROOT / "main.js").read_text(encoding="utf-8")
    bridge = (OPEN_GEN_ROOT / "lib" / "hivemindStudio.js").read_text(encoding="utf-8")
    video = (OPEN_GEN_ROOT / "components" / "VideoStudio.js").read_text(encoding="utf-8")

    assert "installHivemindExploreDock" in main
    assert "fetch('/api/simple/catalog'" in bridge
    assert "media-studio-mcp" in bridge
    assert "hivemind-media:" in bridge
    assert "fetch('/api/media-studio/video'" in bridge
    assert "sessionStorage" in bridge
    assert "localStorage.removeItem('muapi_history')" in bridge
    assert "localStorage.removeItem('video_history')" in bridge
    assert "localStorage.setItem(VIDEO_SELECTION_KEY" not in bridge
    assert "localStorage.setItem(OPTIONS_KEY" not in bridge
    assert "isHivemindVideoModelId" in video
    assert "generateHivemindVideo" in video
    assert "const generationModels = imageMode ? allI2V : [...hivemindI2V, ...allT2V]" in video
    assert "allI2V = [...hivemindI2V, ...i2vModels, ...localI2V]" in video
    assert "selectHivemindWorkflowModel(m.id)" in video
    assert "uploadFileToHivemindStudio" in video
    assert "redactPrivateHistoryEntry" in video
    assert "prompt_private: true" in video
    assert "localAI.uploadFileToWan2gp" in video


def test_video_generation_has_progress_and_reversible_result_navigation() -> None:
    video = (OPEN_GEN_ROOT / "components" / "VideoStudio.js").read_text(encoding="utf-8")
    css = (OPEN_GEN_ROOT / "styles" / "global.css").read_text(encoding="utf-8")

    assert 'generationProgressView.id = \'video-generation-progress\'' in video
    assert 'data-progress-mode="indeterminate"' in video
    assert "showGenerationProgress(lastSubmittedContext)" in video
    assert "const generationContexts = new Map()" in video
    assert "imageUrl: uploadedImageUrl" in video
    assert "endImageUrl: uploadedEndImageUrl" in video
    assert "backToSetupBtn.onclick" in video
    assert "restoreGenerationContext(viewedGenerationContext)" in video
    assert "regenerateBtn.onclick = () => generateBtn.click();" not in video
    assert "video-generation-progress-slide" in css
    assert 'data-progress-mode="determinate"' in css
    assert "video-generation-stage" in video
    assert "z-50 flex items-start justify-center" in video
    assert "align-items: flex-start" in css
    assert "padding-top: clamp(2.5rem, 8vh, 5rem)" in css
    assert "promptWrapper.classList.add('hidden', 'opacity-0', 'pointer-events-none')" in video
    assert "data-video-completion-ping" in video
    assert "VIDEO_COMPLETION_PING_KEY" in video
    assert "sessionStorage.setItem(VIDEO_COMPLETION_PING_KEY" in video
    assert "localStorage.setItem(VIDEO_COMPLETION_PING_KEY" not in video
    assert "primeCompletionPing()" in video
    assert "if (pingWhenComplete) void playCompletionPing();" in video
    assert "const completedGeneration" in video
    assert "if (completedGeneration) void playCompletionPing();" in video
    assert "resultVideo.pause();\n        generateBtn.click();" in video
    assert "resetToPromptBar();\n        generateBtn.click();" not in video
    assert "VIDEO_PREFERENCES_KEY" in video
    assert "normalizeVideoPreferences" in video
    assert "modelId: selectedModel,\n            duration: selectedDuration" in video
    assert "localStorage.setItem(VIDEO_PREFERENCES_KEY" in video
    assert "const restoredPreference = restorePersistedVideoPreferences();" in video
    assert "if (!restoredPreference)" in video

    html = (UI_ROOT / "index.html").read_text(encoding="utf-8")
    assert 'allow="autoplay; clipboard-read; clipboard-write; fullscreen; microphone; camera"' in html
