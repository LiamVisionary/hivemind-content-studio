// Hub view markup, ported from the former 8765 studio SPA (ui/index.html).
// IDs and data-attributes are load-bearing: hubApp.js drives these exact nodes.

export const CREATE_VIEW = `
        <section class="view" data-view="create">
          <div class="native-mode-rail" id="native-studio-modes" role="tablist" aria-label="Studio tool">
            <button class="native-mode-button is-active" type="button" role="tab" aria-selected="true" data-studio-mode="create"><span>＋</span><b>Create</b><small>Images, video, and complete media</small></button>
            <button class="native-mode-button" type="button" role="tab" aria-selected="false" data-studio-mode="edit"><span>↗</span><b>Edit</b><small>Transform ordered references</small></button>
            <button class="native-mode-button" type="button" role="tab" aria-selected="false" data-studio-mode="animate"><span>▶</span><b>Animate</b><small>Turn an idea or frame into motion</small></button>
            <button class="native-mode-button" type="button" role="tab" aria-selected="false" data-studio-mode="workflow"><span>⌘</span><b>Workflow</b><small>Build the complete production</small></button>
          </div>

          <section class="simple-studio" id="simple-studio" aria-labelledby="simple-heading">
            <div class="simple-stage">
              <header class="simple-hero">
                <span class="simple-orbit" aria-hidden="true"><i></i><i></i><i></i></span>
                <p class="section-kicker">Agent-directed production</p>
                <h2 id="simple-heading">What do you want to make?</h2>
                <p id="simple-hero-copy">Your selected brain expands the brief, chooses the right pieces, and creates a durable production run.</p>
              </header>

              <div class="simple-thread" id="simple-thread" aria-live="polite"></div>

              <form class="simple-composer" id="simple-composer">
                <div class="simple-attachments" id="simple-attachments"></div>
                <section class="loaded-canvas-setup is-hidden" id="loaded-canvas-setup" aria-label="Loaded Canvas generation setup"></section>
                <label class="simple-prompt-label" for="simple-prompt">Production prompt</label>
                <textarea id="simple-prompt" rows="3" maxlength="20000" placeholder="Create a 20-second product launch ad with a hard pattern interrupt, three cinematic scenes, and a direct CTA…"></textarea>
                <div class="simple-composer-footer">
                  <div class="simple-tools">
                    <button class="composer-tool attach-tool" id="simple-attach" type="button" aria-label="Attach reference images"><span aria-hidden="true">＋</span><b>Images</b></button>
                    <input id="simple-image-input" type="file" accept="image/*,.avif,.heic,.heif" multiple hidden />
                    <details class="composer-options composer-templates" id="simple-templates">
                      <summary aria-label="Start from a production template">▤ <span>Templates</span></summary>
                      <div class="composer-options-menu templates-menu" id="templates-menu"><p class="ingredients-empty">Loading templates…</p></div>
                    </details>
                    <details class="composer-options composer-ingredients" id="simple-ingredients">
                      <summary aria-label="Insert a favorited prompt">✦ <span>Ingredients</span></summary>
                      <div class="composer-options-menu ingredients-menu" id="ingredients-menu"><p class="ingredients-empty">Favorite a prompt in History to reuse it here.</p></div>
                    </details>
                    <div class="route-picker brain-route-picker" data-route-picker="brain">
                      <input id="simple-brain" type="hidden" />
                      <button class="route-picker-trigger" type="button" data-route-trigger="brain" aria-haspopup="dialog" aria-expanded="false" aria-controls="brain-route-popover">
                        <span>Brain</span><b data-route-trigger-label="brain">Loading models…</b><em class="route-auth-chip is-hidden" data-route-trigger-auth="brain"></em><i aria-hidden="true">⌄</i>
                      </button>
                      <div class="route-popover is-hidden" id="brain-route-popover" data-route-popover="brain" role="dialog" aria-label="Choose LLM brain">
                        <label class="route-search"><span aria-hidden="true">⌕</span><input type="search" data-route-search="brain" placeholder="Search models &amp; providers" autocomplete="off" /></label>
                        <div class="route-picker-list" data-route-list="brain" role="menu"></div>
                      </div>
                    </div>
                    <div class="route-picker" data-route-picker="image">
                      <input id="simple-image-route" type="hidden" value="automatic" />
                      <button class="route-picker-trigger" type="button" data-route-trigger="image" aria-haspopup="dialog" aria-expanded="false" aria-controls="image-route-popover">
                        <span>Image</span><b data-route-trigger-label="image">Automatic</b><em class="route-auth-chip is-automatic" data-route-trigger-auth="image">Auto</em><i aria-hidden="true">⌄</i>
                      </button>
                      <div class="route-popover is-hidden" id="image-route-popover" data-route-popover="image" role="dialog" aria-label="Choose image provider and model">
                        <label class="route-search"><span aria-hidden="true">⌕</span><input type="search" data-route-search="image" placeholder="Search image models &amp; providers" autocomplete="off" /></label>
                        <div class="route-picker-list" data-route-list="image" role="menu"></div>
                      </div>
                    </div>
                    <div class="route-picker" data-route-picker="video">
                      <input id="simple-video-route" type="hidden" value="automatic" />
                      <button class="route-picker-trigger" type="button" data-route-trigger="video" aria-haspopup="dialog" aria-expanded="false" aria-controls="video-route-popover">
                        <span>Video</span><b data-route-trigger-label="video">Automatic</b><em class="route-auth-chip is-automatic" data-route-trigger-auth="video">Auto</em><i aria-hidden="true">⌄</i>
                      </button>
                      <div class="route-popover is-hidden" id="video-route-popover" data-route-popover="video" role="dialog" aria-label="Choose video provider and model">
                        <label class="route-search"><span aria-hidden="true">⌕</span><input type="search" data-route-search="video" placeholder="Search video models &amp; providers" autocomplete="off" /></label>
                        <div class="route-picker-list" data-route-list="video" role="menu"></div>
                      </div>
                    </div>
                    <details class="composer-options" id="simple-options">
                      <summary aria-label="Production options">☷ <span>Options</span></summary>
                      <div class="composer-options-menu">
                        <label class="option-toggle"><span><b>Prompt helper</b><small>Expand and improve my direction</small></span><input id="simple-prompt-helper" type="checkbox" checked /><i></i></label>
                        <label class="option-toggle"><span><b>Walk-through</b><small>Ask first, then wait for confirmation</small></span><input id="simple-walkthrough" type="checkbox" /><i></i></label>
                        <label class="seed-option"><span><b>Seed mode</b><small>Choose how the next generation advances</small></span><select id="simple-seed-mode"><option value="randomize">Randomize</option><option value="fixed">Fixed</option><option value="increment">Increment</option><option value="decrement">Decrement</option></select></label>
                        <label class="seed-option"><span><b>Seed</b><small>The exact numeric seed, including the last random seed</small></span><input id="simple-seed" type="number" min="-3" max="9007199254740991" step="1" value="-1" /></label>
                      </div>
                    </details>
                  </div>
                  <button class="simple-send" id="simple-submit" type="submit" aria-label="Plan production"><span>Plan production</span><i aria-hidden="true">↑</i></button>
                </div>
                <p class="simple-capability-note" id="simple-capability-note">Up to 30 ordered reference images. Automatic lets the brain choose compatible roles and providers.</p>
              </form>
            </div>
          </section>

          <div class="advanced-studio is-hidden" id="advanced-studio">
          <form id="create-run-form" class="create-layout">
            <div class="creation-column">
              <section class="editor-intro">
                <p class="section-kicker">Start with the idea</p>
                <label class="hero-field">
                  <span>What are we making?</span>
                  <input id="title" name="title" maxlength="180" required placeholder="A launch ad for our new product" autocomplete="off" />
                </label>
                <label class="field">
                  <span>Creative direction <em>optional</em></span>
                  <textarea id="concept" name="concept" rows="3" maxlength="5000" placeholder="The argument, story, offer, or outcome that should land."></textarea>
                </label>
              </section>

              <section class="editor-section">
                <div class="section-heading">
                  <div><p class="section-kicker">Choose a format</p><h2>Production lane</h2></div>
                  <span class="selection-readout" id="lane-selection">Loading lanes…</span>
                </div>
                <div class="lane-grid" id="lane-grid" role="radiogroup" aria-label="Production lane">
                  <div class="skeleton skeleton-card" role="status" aria-label="Loading production lanes"></div>
                  <div class="skeleton skeleton-card"></div>
                  <div class="skeleton skeleton-card"></div>
                </div>
              </section>

              <section class="editor-section source-section is-hidden" id="source-section">
                <div class="section-heading"><div><p class="section-kicker">Bring the source</p><h2 id="source-heading">Source media</h2></div></div>
                <label class="field">
                  <span>URL or approved local path</span>
                  <input id="source" name="source" maxlength="4000" placeholder="https://…" autocomplete="off" />
                </label>
                <label class="field compact-field" id="creator-field">
                  <span>Creator or owner <em>optional</em></span>
                  <input id="creator" name="creator" maxlength="300" placeholder="Account or rights owner" autocomplete="off" />
                </label>
              </section>

              <section class="editor-section" id="scene-editor-section">
                <div class="section-heading">
                  <div><p class="section-kicker">Shape the flow</p><h2>Scenes</h2></div>
                  <button class="quiet-button" id="add-scene-button" type="button">＋ Add scene</button>
                </div>
                <div class="scene-list" id="scene-list"></div>
              </section>

              <section class="advanced-stack" aria-label="Advanced configuration">
                <p class="section-kicker advanced-kicker">Advanced</p>

                <details class="advanced-panel" id="production-details">
                  <summary><span><b>Production settings</b><small>Audience, runtime, format, pacing</small></span><i>＋</i></summary>
                  <div class="advanced-body grid-two">
                    <label class="field"><span>Audience</span><input id="audience" maxlength="1000" placeholder="Who this is for" /></label>
                    <label class="field"><span>Goal</span><input id="goal" maxlength="1000" placeholder="What should happen after watching" /></label>
                    <label class="field"><span>Aspect ratio</span><select id="aspect-ratio"></select></label>
                    <label class="field"><span>Target runtime</span><div class="unit-input"><input id="runtime-seconds" type="number" min="1" max="7200" /><span>sec</span></div></label>
                    <label class="field field-span"><span>Tone</span><input id="tone" maxlength="500" placeholder="Direct, warm, cinematic, dry…" /></label>
                    <div class="faceless-options field-span is-hidden" id="faceless-options">
                      <label class="field"><span>Media source</span><select id="media-source"><option value="pexels">Pexels</option><option value="pixabay">Pixabay</option><option value="local">Owned local media</option></select></label>
                      <label class="field"><span>Batch count</span><select id="video-count"><option>1</option><option>2</option><option>3</option><option>4</option><option>5</option></select></label>
                      <label class="field"><span>Clip cadence</span><select id="clip-duration"><option value="2">2 seconds</option><option value="3" selected>3 seconds</option><option value="4">4 seconds</option><option value="5">5 seconds</option><option value="6">6 seconds</option><option value="8">8 seconds</option></select></label>
                    </div>
                  </div>
                </details>

                <details class="advanced-panel" id="provider-details">
                  <summary><span><b>Providers &amp; routing</b><small>Local, fleet, hosted, or BYOK</small></span><i>＋</i></summary>
                  <div class="advanced-body">
                    <div class="provider-selectors grid-two" id="provider-selectors"><div class="skeleton skeleton-line"></div></div>
                    <p class="fine-print">Only providers advertising the required capability appear here. Readiness and budget policy still apply at execution time.</p>
                  </div>
                </details>

                <details class="advanced-panel" id="voice-details">
                  <summary><span><b>Voice, audio &amp; captions</b><small>Narration, delivery, subtitles, music</small></span><i>＋</i></summary>
                  <div class="advanced-body grid-two">
                    <label class="switch-field"><span><b>Voiceover</b><small>Generate narration for voiced lanes</small></span><input id="voice-enabled" type="checkbox" checked /><i></i></label>
                    <label class="switch-field"><span><b>Subtitles</b><small>Render readable captions</small></span><input id="subtitles-enabled" type="checkbox" checked /><i></i></label>
                    <label class="field"><span>Delivery</span><input id="voice-delivery" maxlength="300" placeholder="Calm, quick, confident" /></label>
                    <label class="field"><span>Voice ID <em>optional</em></span><input id="voice-id" maxlength="200" placeholder="Use provider default" /></label>
                    <label class="field"><span>Caption position</span><select id="subtitle-position"><option value="bottom">Bottom</option><option value="center">Center</option><option value="top">Top</option></select></label>
                    <label class="field"><span>Caption size</span><div class="unit-input"><input id="subtitle-size" type="number" value="56" min="20" max="140" /><span>px</span></div></label>
                  </div>
                </details>

                <details class="advanced-panel" id="distribution-details">
                  <summary><span><b>Distribution</b><small>Destinations, caption, CTA</small></span><i>＋</i></summary>
                  <div class="advanced-body">
                    <fieldset class="platform-fieldset"><legend>Destinations</legend><div class="platform-grid" id="platform-grid"></div></fieldset>
                    <div class="grid-two">
                      <label class="field"><span>Caption <em>optional</em></span><textarea id="publish-caption" rows="3" maxlength="5000"></textarea></label>
                      <label class="field"><span>Call to action <em>optional</em></span><textarea id="publish-cta" rows="3" maxlength="500"></textarea></label>
                    </div>
                    <p class="fine-print">Creating a run never publishes. Distribution remains behind evaluation, rights approval, dry run, and the live-publish gate.</p>
                  </div>
                </details>

                <details class="advanced-panel" id="operator-details">
                  <summary><span><b>Operator controls</b><small>Privacy, budget, protected actions</small></span><i>＋</i></summary>
                  <div class="advanced-body grid-two">
                    <label class="field"><span>Privacy</span><select id="privacy"></select></label>
                    <label class="field"><span>Maximum generation spend</span><div class="unit-input currency"><span>$</span><input id="max-cost" type="number" value="0" min="0" max="10000" step="0.01" /></div></label>
                    <label class="field field-span"><span>Operator token <em>held in memory only</em></span><input id="operator-token" type="password" autocomplete="off" placeholder="Needed only for cancel, retry, and approval decisions" /></label>
                  </div>
                </details>
              </section>
            </div>

            <aside class="launch-rail">
              <div class="launch-card">
                <p class="section-kicker">Production brief</p>
                <div class="launch-format"><span id="launch-lane-mark">01</span><div><b id="launch-lane-label">First-frame ad</b><small id="launch-lane-description">Loading production details…</small></div></div>
                <dl class="launch-summary">
                  <div><dt>Format</dt><dd id="launch-aspect">9:16</dd></div>
                  <div><dt>Runtime</dt><dd id="launch-runtime">15 sec</dd></div>
                  <div><dt>Scenes</dt><dd id="launch-scenes">1</dd></div>
                  <div><dt>Budget</dt><dd id="launch-budget">$0 local</dd></div>
                </dl>
                <button class="primary-button" id="create-run-button" type="submit"><span>Create production</span><i aria-hidden="true">→</i></button>
                <p class="launch-note">Creates a durable run and stops at the first agent, provider, evaluation, or approval boundary.</p>
              </div>
              <div class="recent-card" id="recent-run-card"><div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line short"></div></div>
            </aside>
          </form>
          </div>
        </section>`;

export const CANVAS_VIEW = `
        <section class="view tool-view" data-view="canvas">
          <iframe id="canvas-frame" title="ComfyUI workflow canvas" data-tool-surface="canvas" allow="clipboard-read; clipboard-write; fullscreen"></iframe>
        </section>`;

export const MODELS_VIEW = `
        <section class="view tool-view" data-view="models">
          <iframe id="models-frame" title="Local model manager" data-tool-surface="models" allow="clipboard-read; clipboard-write; fullscreen"></iframe>
        </section>`;

export const RUNS_VIEW = `
        <section class="view" data-view="runs">
          <div class="view-toolbar">
            <div><p class="section-kicker">Durable production</p><h2>Runs</h2></div>
            <div class="segmented-control" id="run-filters" aria-label="Filter runs"><button class="is-active" data-status-filter="">All</button><button data-status-filter="active">Active</button><button data-status-filter="completed">Complete</button></div>
          </div>
          <div class="runs-layout">
            <div class="run-list" id="run-list"><div class="skeleton skeleton-run"></div><div class="skeleton skeleton-run"></div></div>
            <aside class="run-detail" id="run-detail"><div class="empty-detail"><span>◫</span><b>Select a run</b><small>Inspect its scenes, steps, artifacts, and next action.</small></div></aside>
          </div>
        </section>`;

export const HISTORY_VIEW = `
        <section class="view" data-view="history">
          <div class="view-toolbar">
            <div><p class="section-kicker">Private archive</p><h2>History</h2></div>
            <div class="history-toolbar-controls">
              <div class="segmented-control" id="history-filters" aria-label="Filter history"><button class="is-active" data-history-filter="">All</button><button data-history-filter="prompts">Prompts</button><button data-history-filter="canvas">Canvas</button><button data-history-filter="favorites">Favorites</button></div>
              <div class="canvas-history-filters" id="canvas-history-filters">
                <label><span>Format</span><select id="canvas-format-filter"><option value="">All formats</option></select></label>
                <label><span>Model</span><select id="canvas-model-filter"><option value="">All models</option></select></label>
              </div>
            </div>
          </div>
          <p class="fine-print history-note">Owner-only prompts and Canvas outputs live here. Canvas records are imported without prompt graphs, tokens, filesystem paths, or media copies; encrypted source files remain in their original private storage.</p>
          <div class="prompt-history-list" id="prompt-history-list"><div class="skeleton skeleton-run"></div><div class="skeleton skeleton-run"></div></div>
        </section>`;

export const TELEMETRY_VIEW = `
        <section class="view" data-view="telemetry">
          <div class="view-toolbar">
            <div><p class="section-kicker">Generation operations</p><h2>Telemetry</h2></div>
            <p class="telemetry-privacy">Local metadata only · no prompts, media, credentials, or provider payloads</p>
          </div>
          <div class="telemetry-summary" id="telemetry-summary" role="status" aria-label="Loading generation telemetry">
            <div class="skeleton skeleton-card"></div><div class="skeleton skeleton-card"></div><div class="skeleton skeleton-card"></div><div class="skeleton skeleton-card"></div>
          </div>
          <div class="telemetry-layout">
            <section class="telemetry-panel">
              <div class="section-heading"><div><p class="section-kicker">Routing evidence</p><h3>By provider</h3></div></div>
              <div class="telemetry-provider-list" id="telemetry-providers"><div class="skeleton skeleton-run"></div></div>
            </section>
            <section class="telemetry-panel">
              <div class="section-heading"><div><p class="section-kicker">Latest activity</p><h3>Generation attempts</h3></div></div>
              <div class="telemetry-attempt-list" id="telemetry-attempts"><div class="skeleton skeleton-run"></div></div>
            </section>
          </div>
        </section>`;

export const PROVIDERS_VIEW = `
        <section class="view" data-view="providers">
          <div class="view-toolbar"><div><p class="section-kicker">Capability routing</p><h2>Providers</h2></div><div class="provider-legend"><span><i class="ready"></i>Ready</span><span><i></i>Needs setup</span></div></div>
          <section class="oauth-section" aria-labelledby="connected-accounts-heading">
            <div class="section-heading"><div><p class="section-kicker">Server-side authentication</p><h3 id="connected-accounts-heading">Connected accounts</h3></div><p>OAuth stays inside HivemindOS. This studio receives status only.</p></div>
            <div class="oauth-board" id="oauth-board"><div class="skeleton skeleton-card"></div><div class="skeleton skeleton-card"></div></div>
          </section>
          <div class="section-heading provider-heading"><div><p class="section-kicker">Generation routes</p><h3>Capability providers</h3></div></div>
          <div class="provider-board" id="provider-board"><div class="skeleton skeleton-card"></div><div class="skeleton skeleton-card"></div></div>
        </section>`;

export const HUB_CHROME = `
    <dialog class="history-delete-dialog" id="history-delete-dialog">
      <form method="dialog">
        <header><span aria-hidden="true">!</span><div><p class="section-kicker">Permanent deletion</p><h3 id="history-delete-title">Delete this output?</h3></div></header>
        <p id="history-delete-copy">This removes every local trace of this generated output and cannot be undone.</p>
        <div><button type="button" data-cancel-history-delete>Cancel</button><button class="danger" type="button" data-confirm-history-delete>Delete permanently</button></div>
      </form>
    </dialog>
    <div class="toast-region" id="toast-region" aria-live="polite"></div>`;
