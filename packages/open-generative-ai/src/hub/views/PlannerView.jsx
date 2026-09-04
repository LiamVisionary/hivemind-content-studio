// Planner (the 'create' view) — the agent-directed production composer. A brain
// expands the brief, routes the pieces, and creates a durable run. Two surfaces
// share one toolbar: the simple studio (thread + docked composer, for
// create/edit/animate) and the advanced workflow form (full production brief).
//
// All logic lives in hubData: submit/plan/run, route pickers, attachments,
// generation cards, composer restore, advanced-form state. This file is the
// redesigned skin — no page hero, workspace-first, one honey accent, route
// pickers as labelled ChipButton+Menu rows (not chip soup).
import { useEffect, useRef, useState } from 'react';
import { registerPromptInserter } from '../../app/promptTarget.js';
import { useMediaSrc } from '../../hooks/hooks.js';
import { Icon } from '../../ui/icons.jsx';
import { ChipButton, Menu, MenuHeading, MenuItem } from '../../ui/Menu.jsx';
import { runFailureRemedy } from '../../lib/failureRemedy.js';
import {
  Button, Card, EmptyState, Field, IconButton, NativeSelect, Pill, SectionLabel,
  Segmented, Spinner, TextArea, TextInput, Toggle, cx,
} from '../../ui/kit.jsx';
import {
  addScene, addSimpleImages, attachmentRole, buildRunGenerationCards, capabilityNote,
  clearLoadedCanvasSetup, clearRestoredComposer, createSimpleRun, createWorkflowRun, hubState,
  humanize, insertPromptIntoComposer,
  lane, MEDIA_SOURCE_OPTIONS, mediaSourceKind, providerLabel, providerRolesForLane,
  registerHubFocus, registerThreadScroller,
  removeScene, removeSimpleImage, ROUTE_AUTH_SECTIONS, routePickerMatches, routePickerProviders,
  runDisplayTitle, selectedRoutePickerItem, setComposer, setMediaRoute, setProviderRole, setRouteValue,
  setSelectedLane, setSelectedRunId, setStudioMode, setWorkflow, STUDIO_MODES, submitSimplePrompt,
  TEMPLATE_CATEGORY_LABELS, titleCase, togglePlatform, updateScene, useHub,
} from '../hubData.js';
import { GenerationCard } from '../components/GenerationCard.jsx';
import { HubToolbar } from '../components/HubToolbar.jsx';

const MODE_OPTIONS = Object.entries(STUDIO_MODES).map(([value, mode]) => ({ value, label: mode.label }));

// Grouped once at module scope so the select keeps a stable option order —
// "Stock footage" / "Owned" / "Generated" is the decision the user is making.
const MEDIA_SOURCE_GROUPS = Object.entries(
  MEDIA_SOURCE_OPTIONS.reduce((groups, option) => {
    (groups[option.group] ||= []).push(option);
    return groups;
  }, {}),
);

function openRun(runId) {
  setSelectedRunId(runId);
  // navigateHub through the app router keeps the rail + URL in sync.
  window.dispatchEvent(new CustomEvent('navigate', { detail: { page: 'runs' } }));
}

/* ------------------------------------------------------------------ */
/* Route picker (labelled chip + grouped menu)                        */
/* ------------------------------------------------------------------ */

// `value`/`onChange` let a caller bind the picker to something other than the
// simple-mode route for that kind — the faceless media route stores its own
// selection on the workflow form while reusing this exact control.
function RoutePickerList({ kind, close, value, onChange }) {
  const [query, setQuery] = useState('');
  useHub();
  const providers = routePickerProviders(kind);
  const current = value ?? hubState.routes[kind];
  const commit = onChange ?? ((next) => setRouteValue(kind, next));
  const q = query.trim().toLowerCase();

  return (
    <>
      <div className="sticky top-0 z-10 -mx-1.5 -mt-1.5 mb-1 border-b border-line1 bg-bg1 p-1.5">
        <div className="flex items-center gap-2 rounded-md border border-line1 bg-bg2 px-2.5 focus-within:border-honey/60">
          <Icon name="search" size={13} className="shrink-0 text-ink3" />
          <input
            type="search"
            autoFocus
            value={query}
            placeholder={`Search ${kind === 'brain' ? 'models & providers' : `${kind} models`}`}
            onChange={(e) => setQuery(e.target.value)}
            className="h-8 w-full border-none bg-transparent text-xs text-ink1 outline-none placeholder:text-ink3"
          />
        </div>
      </div>

      {kind !== 'brain' ? (
        <MenuItem selected={current === 'automatic'} onClick={() => { commit('automatic'); close(); }}>
          Automatic — the brain chooses
        </MenuItem>
      ) : null}

      {providers.map((provider) => {
        const models = provider.models.filter((model) => routePickerMatches(provider, model, q));
        if (!models.length) return null;
        const auth = ROUTE_AUTH_SECTIONS[provider.authSection];
        return (
          <div key={`${provider.id}:${provider.authSection}`}>
            <MenuHeading>
              {provider.label} · {auth.label}{provider.available ? '' : ' · unavailable'}
            </MenuHeading>
            {models.map((model) => (
              <MenuItem
                key={model.value}
                selected={model.value === current}
                disabled={model.disabled}
                title={model.disabled ? model.disabledReason : undefined}
                onClick={() => { commit(model.value); close(); }}
              >
                {model.label}
              </MenuItem>
            ))}
          </div>
        );
      })}
      {providers.every((provider) => !provider.models.filter((m) => routePickerMatches(provider, m, q)).length) ? (
        <p className="px-2.5 py-4 text-center text-xs text-ink3">No matching providers or models.</p>
      ) : null}
    </>
  );
}

function RoutePicker({ kind, label, icon, route, onRouteChange, up = true }) {
  const s = useHub();
  const selected = selectedRoutePickerItem(kind, route);
  const providers = routePickerProviders(kind);
  // "Loading models…" is only true while the catalog is still on its way. Once
  // it has loaded with no brains (or the API is down) the honest word is
  // "Unavailable" — a chip that says loading forever is a lie.
  const brainPlaceholder = providers.length
    ? 'Select a model'
    : (s.simpleCatalog || s.apiOnline === false) ? 'Unavailable' : 'Loading models…';
  const value = selected
    ? `${selected.provider.label} · ${selected.model.label}`
    : kind === 'brain' ? brainPlaceholder : 'Automatic';
  return (
    <Menu
      up={up}
      width="w-[340px]"
      panelClassName="max-h-[min(440px,60vh)]"
      trigger={(open, toggle) => (
        <ChipButton
          icon={icon}
          label={label}
          value={value}
          active={open}
          onClick={toggle}
          disabled={kind === 'brain' && !providers.length}
          title={kind === 'brain' && !providers.length && brainPlaceholder === 'Unavailable'
            ? 'No LLM brain is advertised by the studio API — connect a provider under Providers, or check that the API is running.'
            : undefined}
        />
      )}
    >
      {(close) => <RoutePickerList kind={kind} close={close} value={route} onChange={onRouteChange} />}
    </Menu>
  );
}

/* ------------------------------------------------------------------ */
/* Composer sub-surfaces                                              */
/* ------------------------------------------------------------------ */

function AttachmentThumb({ item, index, total }) {
  const src = useMediaSrc(item.url);
  const role = attachmentRole(index, total);
  const name = item.name || item.file?.name || `Reference ${index + 1}`;
  return (
    <span className="group relative inline-flex shrink-0 flex-col overflow-hidden rounded-md border border-line1 bg-bg2">
      <span className="h-14 w-14 overflow-hidden bg-bg3">
        <img src={src} alt={`${name} preview`} className="h-full w-full object-cover" />
      </span>
      <span className="px-1 py-0.5 text-center text-[9px] font-medium text-ink3">{role}</span>
      <button
        type="button"
        onClick={() => removeSimpleImage(index)}
        aria-label={`Remove ${name}`}
        className="absolute right-0.5 top-0.5 grid h-4 w-4 place-items-center rounded-sm bg-bg1/80 text-ink3 transition-colors hover:text-ink1"
      >
        <Icon name="x" size={10} />
      </button>
    </span>
  );
}

function LoadedCanvasSetup({ loaded }) {
  const src = useMediaSrc(loaded.entry.media_url);
  const isVideo = loaded.entry.media_type?.startsWith('video/');
  const { setup } = loaded;
  return (
    <Card className="flex gap-3 p-2.5">
      <span className="h-20 w-20 shrink-0 overflow-hidden rounded-md border border-line1 bg-bg3">
        {isVideo
          ? <video src={src} muted playsInline className="h-full w-full object-cover" />
          : <img src={src} alt="Loaded Canvas output" className="h-full w-full object-cover" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <SectionLabel>Exact Canvas setup</SectionLabel>
            <div className="truncate text-[13px] font-semibold text-ink1">Loaded generation</div>
          </div>
          <IconButton icon="x" label="Remove loaded setup" size="sm" onClick={clearLoadedCanvasSetup} />
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1.5 text-[11px]">
          <span className="rounded-sm bg-bg1 px-1.5 py-0.5 text-ink2">
            <b className="text-ink3">Model </b>{(setup.models || []).join(', ') || 'Recorded in workflow'}
          </span>
          {(setup.seeds || []).map((seed) => (
            <span key={seed.label} className="rounded-sm bg-bg1 px-1.5 py-0.5 font-mono text-ink2">
              {seed.label}: {seed.value} · {titleCase(seed.mode)}
            </span>
          ))}
          {(setup.settings || []).slice(0, 12).map((setting) => (
            <span key={setting.name} className="rounded-sm bg-bg1 px-1.5 py-0.5 font-mono text-ink2">
              {setting.name}: {setting.value}
            </span>
          ))}
        </div>
      </div>
    </Card>
  );
}

function ToggleRow({ label, hint, checked, onChange }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md px-1 py-1.5">
      <span className="min-w-0">
        <span className="block text-[13px] font-medium text-ink1">{label}</span>
        <span className="block text-[11px] text-ink3">{hint}</span>
      </span>
      <Toggle label={label} checked={checked} onChange={onChange} />
    </div>
  );
}

function OptionsMenu() {
  const s = useHub();
  const { composer } = s;
  return (
    <Menu
      up
      width="w-[300px]"
      trigger={(open, toggle) => (
        <ChipButton icon="sliders" label="Options" value="" chevron active={open} onClick={toggle} />
      )}
    >
      <div className="flex flex-col gap-1 p-1">
        <ToggleRow
          label="Prompt helper"
          hint="Expand and improve my direction"
          checked={composer.promptHelper}
          onChange={(v) => setComposer({ promptHelper: v })}
        />
        <ToggleRow
          label="Walk-through"
          hint="Ask first, then wait for confirmation"
          checked={composer.walkthrough}
          onChange={(v) => setComposer({ walkthrough: v })}
        />
        <Field label="Seed mode">
          <NativeSelect value={composer.seedMode} onChange={(e) => setComposer({ seedMode: e.target.value })}>
            <option value="randomize">Randomize</option>
            <option value="fixed">Fixed</option>
            <option value="increment">Increment</option>
            <option value="decrement">Decrement</option>
          </NativeSelect>
        </Field>
        <Field label="Seed" hint="-1 picks a random seed">
          <TextInput
            type="number"
            className="font-mono"
            min="-3"
            max="9007199254740991"
            step="1"
            value={composer.seed}
            onChange={(e) => setComposer({ seed: e.target.value })}
          />
        </Field>
      </div>
    </Menu>
  );
}

function TemplatesMenu() {
  const s = useHub();
  const templates = s.simpleCatalog?.templates || [];
  const categories = [...new Set(templates.map((entry) => entry.category))];
  return (
    <Menu
      up
      width="w-[320px]"
      trigger={(open, toggle) => <ChipButton icon="layers" label="Templates" value="" active={open} onClick={toggle} />}
    >
      {(close) => (
        templates.length ? (
          categories.map((category) => (
            <div key={category}>
              <MenuHeading>{TEMPLATE_CATEGORY_LABELS[category] || titleCase(category)}</MenuHeading>
              {templates.filter((entry) => entry.category === category).map((entry) => (
                <MenuItem key={entry.id} onClick={() => { insertPromptIntoComposer(entry.prompt); close(); }}>
                  <span className="flex flex-col">
                    <strong className="text-[13px] text-ink1">{entry.title}</strong>
                    <small className="truncate text-[11px] text-ink3">{entry.description}</small>
                  </span>
                </MenuItem>
              ))}
            </div>
          ))
        ) : (
          <p className="px-2.5 py-4 text-center text-xs text-ink3">No production templates are installed.</p>
        )
      )}
    </Menu>
  );
}

function IngredientsMenu() {
  const s = useHub();
  const favorites = s.prompts.filter((entry) => entry.favorite);
  return (
    <Menu
      up
      width="w-[320px]"
      trigger={(open, toggle) => <ChipButton icon="sparkles" label="Ingredients" value="" active={open} onClick={toggle} />}
    >
      {(close) => (
        favorites.length ? (
          favorites.map((entry) => (
            <MenuItem key={entry.prompt_id} icon="sparkles" onClick={() => { insertPromptIntoComposer(entry.prompt); close(); }}>
              {entry.prompt.length > 140 ? `${entry.prompt.slice(0, 140)}…` : entry.prompt}
            </MenuItem>
          ))
        ) : (
          <p className="px-2.5 py-4 text-center text-xs text-ink3">Favorite a prompt in History to reuse it here.</p>
        )
      )}
    </Menu>
  );
}

/* ------------------------------------------------------------------ */
/* Thread                                                            */
/* ------------------------------------------------------------------ */

function PlanCard({ plan, createdRunId }) {
  const [busy, setBusy] = useState(false);
  const draft = plan.draft || {};
  const confirm = async () => {
    setBusy(true);
    try { await createSimpleRun(plan); } finally { setBusy(false); }
  };
  const scenes = Array.isArray(draft.scenes) ? draft.scenes : [];
  return (
    <div className="mt-2 flex flex-col gap-3 rounded-lg border border-line1 bg-bg2 p-3">
      <div className="flex items-center gap-2.5">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-honey-tint text-honey">
          <Icon name="sparkles" size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <SectionLabel>Production plan</SectionLabel>
          <div className="truncate text-[13px] font-semibold text-ink1">{draft.title || 'Draft ready'}</div>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5 text-[11px]">
        {[titleCase(draft.lane || 'automatic'), draft.aspect_ratio || 'Auto', `${scenes.length || 'Auto'} scene${scenes.length === 1 ? '' : 's'}`].map((chip, i) => (
          <span key={i} className="rounded-sm bg-bg1 px-1.5 py-0.5 text-ink2">{chip}</span>
        ))}
      </div>
      {draft.concept || plan.message ? <p className="text-[13px] leading-relaxed text-ink2">{draft.concept || plan.message}</p> : null}
      {scenes.length ? (
        <div className="flex flex-wrap gap-1.5">
          {scenes.map((scene, index) => (
            <span key={index} className="inline-flex items-center gap-1.5 rounded-sm bg-bg1 px-1.5 py-1 text-[11px] text-ink2">
              <b className="font-mono text-ink3">{String(index + 1).padStart(2, '0')}</b>
              {scene.title || scene.beat || `Scene ${index + 1}`}
            </span>
          ))}
        </div>
      ) : null}
      {plan.mode === 'confirmation' ? (
        createdRunId ? (
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone="ok" dot>Production created</Pill>
            <Button size="sm" variant="ghost" icon="arrowRight" onClick={() => openRun(createdRunId)}>
              Open run
            </Button>
          </div>
        ) : (
          <Button
            variant="primary"
            size="sm"
            loading={busy}
            onClick={() => { void confirm(); }}
            className="self-start"
          >
            {'Confirm & create production'}
          </Button>
        )
      ) : null}
    </div>
  );
}

/**
 * The repair a failed thread turn named, and the evidence behind it.
 *
 * The bubble used to be red text and nothing else: no retry, no "connect an
 * account", and the raw text as the sentence. This gives the sentence its fix
 * and demotes the technical tail to a Details row.
 */
function FailureActions({ detail = '', action = null, onRetry = null }) {
  if (!detail && !action && !onRetry) return null;
  return (
    <>
      {action || onRetry ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {action ? (
            <Button size="sm" variant="primary" onClick={() => void runFailureRemedy(action)}>{action.label}</Button>
          ) : null}
          {onRetry ? (
            <Button size="sm" icon="refresh" onClick={onRetry}>Try again</Button>
          ) : null}
        </div>
      ) : null}
      {detail ? (
        <details className="mt-2">
          <summary className="cursor-pointer list-none text-[11px] font-medium text-ink3 hover:text-ink2">
            Details
          </summary>
          <div className="mt-1 max-h-40 overflow-y-auto break-words font-mono text-[11px] leading-relaxed text-ink3 [overflow-wrap:anywhere]">
            {detail}
          </div>
        </details>
      ) : null}
    </>
  );
}

function ThreadItem({ item }) {
  if (item.kind === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-lg rounded-br-sm bg-honey-tint px-3.5 py-2.5 text-[14px] leading-relaxed text-ink1">
          {item.text}
        </div>
      </div>
    );
  }
  if (item.kind === 'assistant') {
    return (
      <div className="flex gap-2.5">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-honey-tint text-honey">
          <Icon name="logo" size={17} />
        </span>
        <div className="min-w-0 flex-1">
          <p className={cx('whitespace-pre-wrap text-[14px] leading-relaxed', item.error ? 'text-danger' : 'text-ink1')}>
            {item.message}
          </p>
          {/* A refusal that named its repair carries the button here, beside
              the sentence — not on a page two clicks away. */}
          {item.error ? <FailureActions detail={item.detail} action={item.action} /> : null}
          {Array.isArray(item.questions) && item.questions.length ? (
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-[13px] text-ink2">
              {item.questions.map((question, i) => <li key={i}>{question}</li>)}
            </ol>
          ) : null}
          {item.plan ? <PlanCard plan={item.plan} createdRunId={item.createdRunId} /> : null}
        </div>
      </div>
    );
  }
  if (item.kind === 'loading') {
    return (
      <div className="flex items-center gap-2.5 rounded-lg border border-line1 bg-bg2 p-3.5 text-[13px] text-ink2">
        <Spinner size={15} className="text-honey" />
        Creating the durable production run…
      </div>
    );
  }
  if (item.kind === 'runError') {
    return (
      <div className="rounded-lg border border-line1 bg-bg2 p-3.5">
        <div className="flex items-center gap-2 text-danger">
          <Icon name="warning" size={15} />
          <b className="text-[13px]">Could not create the run</b>
        </div>
        <p className="mt-1 text-[13px] leading-relaxed text-danger">{item.message}</p>
        <FailureActions detail={item.detail} action={item.action} />
      </div>
    );
  }
  if (item.kind === 'runCards') {
    const run = hubState.runs.find((r) => r.run_id === item.runId) || item.snapshot;
    if (!run) return null;
    const cards = buildRunGenerationCards(run);
    if (!cards.length) return null;
    return (
      <div className="flex flex-col gap-3">
        {cards.map((card) => <GenerationCard key={card.id} run={run} card={card} onOpenRun={openRun} />)}
      </div>
    );
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Simple studio (thread + composer)                                 */
/* ------------------------------------------------------------------ */

function SimpleStudio({ threadRef, promptRef, fileRef }) {
  const s = useHub();
  const mode = STUDIO_MODES[s.studioMode] || STUDIO_MODES.create;
  const attachments = s.simpleAttachments;

  // Auto-grow the prompt textarea (same 150/250px caps as the old composer).
  useEffect(() => {
    const el = promptRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, window.innerWidth < 768 ? 150 : 250)}px`;
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={threadRef} className="custom-scrollbar min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 p-4 md:p-5">
          {s.thread.length === 0 && s.apiOnline === false && !s.simpleCatalog ? (
            // Boot never reached the API: say so instead of inviting a prompt
            // the brain chip cannot serve.
            <EmptyState
              icon="plug"
              title="The studio is not running"
              hint="The Planner needs the studio on this machine. It retries on its own once the studio is running — or use the refresh button in the top bar."
              className="flex-1"
            />
          ) : s.thread.length === 0 ? (
            <EmptyState icon="sparkles" title={mode.heading} hint={mode.copy} className="flex-1" />
          ) : (
            s.thread.map((item) => <ThreadItem key={item.id} item={item} />)
          )}
        </div>
      </div>

      <div className="shrink-0 border-t border-line1 bg-bg1 p-3">
        <form
          className="mx-auto flex w-full max-w-3xl flex-col gap-2"
          onSubmit={(e) => { e.preventDefault(); void submitSimplePrompt(); }}
        >
          {s.loadedCanvasSetup ? <LoadedCanvasSetup loaded={s.loadedCanvasSetup} /> : null}

          {s.composerRestoredFrom ? (
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink3">
              <Pill tone="neutral" dot>Restored from your last run</Pill>
              <button type="button" onClick={clearRestoredComposer} className="font-medium text-ink2 underline-offset-2 hover:text-ink1 hover:underline">
                Clear
              </button>
            </div>
          ) : null}

          {attachments.length ? (
            <div className="flex flex-wrap gap-2">
              {attachments.map((item, index) => (
                <AttachmentThumb key={item.url} item={item} index={index} total={attachments.length} />
              ))}
            </div>
          ) : null}

          <div className="flex flex-col gap-2 rounded-lg border border-line1 bg-bg2 p-2.5 transition-colors focus-within:border-honey/40">
            <textarea
              ref={promptRef}
              rows={1}
              maxLength={20000}
              placeholder={mode.placeholder}
              value={s.composer.prompt}
              onChange={(e) => setComposer({ prompt: e.target.value })}
              onKeyDown={(e) => {
                // ⌘/Ctrl+Enter submits, like the studios; plain Enter keeps newlines.
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void submitSimplePrompt(); }
              }}
              className="max-h-[150px] min-h-[40px] w-full resize-none overflow-y-auto border-none bg-transparent px-1 pt-1 text-[15px] leading-relaxed text-ink1 outline-none placeholder:text-ink3 md:max-h-[250px]"
            />

            <div className="flex flex-wrap items-center gap-1.5">
              <input
                ref={fileRef}
                type="file"
                accept="image/*,.avif,.heic,.heif"
                multiple
                hidden
                onChange={(e) => { addSimpleImages(e.target.files); e.target.value = ''; }}
              />
              <ChipButton
                icon="image"
                label={mode.attachment}
                value={attachments.length ? `${attachments.length}/30` : ''}
                chevron={false}
                active={attachments.length > 0}
                onClick={() => fileRef.current?.click()}
              />
              <TemplatesMenu />
              <IngredientsMenu />
              <RoutePicker kind="brain" label="Brain" icon="cpu" />
              <RoutePicker kind="image" label="Image" icon="image" />
              <RoutePicker kind="video" label="Video" icon="video" />
              <OptionsMenu />

              <div className="min-w-2 flex-1" />

              <Button
                type="submit"
                variant="primary"
                size="lg"
                loading={s.simpleBusy}
                disabled={!s.composer.prompt.trim()}
                title="⌘/Ctrl+Enter"
                className="min-w-[130px]"
              >
                {s.simpleBusy ? (s.simpleBusyLabel || 'Planning') : mode.submit}
              </Button>
            </div>
          </div>
          <p className="px-1 text-[11px] leading-relaxed text-ink3">{capabilityNote()}</p>
        </form>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Advanced workflow form                                             */
/* ------------------------------------------------------------------ */

function SceneEditor() {
  const s = useHub();
  return (
    <div className="flex flex-col gap-2">
      {s.scenes.map((scene, index) => (
        <Card key={index} className="flex flex-col gap-2 p-3">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-ink3">{String(index + 1).padStart(2, '0')}</span>
            <TextInput
              value={scene.title}
              placeholder="Scene title"
              aria-label={`Scene ${index + 1} title`}
              onChange={(e) => updateScene(index, 'title', e.target.value)}
              className="min-w-0 flex-1 font-medium"
            />
            <span className="flex items-center gap-1 text-xs text-ink3">
              <span className="w-20 shrink-0">
                <TextInput
                  type="number"
                  min="0.5"
                  max="300"
                  step="0.5"
                  value={scene.duration_seconds}
                  aria-label={`Scene ${index + 1} duration`}
                  onChange={(e) => updateScene(index, 'duration_seconds', e.target.value)}
                  className="font-mono"
                />
              </span>
              sec
            </span>
            <IconButton
              icon="trash"
              label={`Remove scene ${index + 1}`}
              size="sm"
              disabled={s.scenes.length === 1}
              onClick={() => removeScene(index)}
            />
          </div>
          <TextInput
            value={scene.beat}
            placeholder="What happens in this scene?"
            aria-label={`Scene ${index + 1} beat`}
            onChange={(e) => updateScene(index, 'beat', e.target.value)}
          />
          <div className="grid gap-2 md:grid-cols-2">
            <Field label="On-screen copy"><TextInput value={scene.overlay} onChange={(e) => updateScene(index, 'overlay', e.target.value)} /></Field>
            <Field label="Voice line"><TextInput value={scene.voice} onChange={(e) => updateScene(index, 'voice', e.target.value)} /></Field>
            <Field label="Image direction"><TextArea rows={2} value={scene.image_prompt} onChange={(e) => updateScene(index, 'image_prompt', e.target.value)} /></Field>
            <Field label="Motion direction"><TextArea rows={2} value={scene.motion_prompt} onChange={(e) => updateScene(index, 'motion_prompt', e.target.value)} /></Field>
          </div>
        </Card>
      ))}
      <Button size="sm" icon="plus" onClick={addScene} className="self-start">Add scene</Button>
    </div>
  );
}

function AdvancedForm({ titleRef }) {
  const s = useHub();
  const selected = lane();
  const w = s.workflow;
  const catalog = s.catalog;
  const [busy, setBusy] = useState(false);
  if (!catalog) {
    return <div className="grid flex-1 place-items-center p-8"><Spinner size={22} className="text-ink2" /></div>;
  }
  const roles = providerRolesForLane();
  const budget = Number(w.maxCost || 0);
  const recent = s.runs[0];

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    await createWorkflowRun();
    setBusy(false);
  };

  return (
    <form onSubmit={submit} className="custom-scrollbar min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto grid w-full max-w-5xl gap-5 p-4 md:grid-cols-[1fr_300px] md:p-5">
        <div className="flex flex-col gap-6">
          {/* Idea */}
          <section className="flex flex-col gap-3">
            <SectionLabel>Start with the idea</SectionLabel>
            <Field label="What are we making?">
              {/* React 19 passes ref as a plain prop, so the kit TextInput takes
                  it directly — the workflowTitle focus hook (duplicateRun) works. */}
              <TextInput
                ref={titleRef}
                maxLength={180}
                required
                placeholder="A launch ad for our new product"
                value={w.title}
                onChange={(e) => setWorkflow({ title: e.target.value })}
              />
            </Field>
            <Field label="Creative direction (optional)">
              <TextArea rows={3} maxLength={5000} placeholder="The argument, story, offer, or outcome that should land."
                value={w.concept} onChange={(e) => setWorkflow({ concept: e.target.value })} />
            </Field>
          </section>

          {/* Lane */}
          <section className="flex flex-col gap-3">
            <div className="flex items-end justify-between gap-2">
              <SectionLabel>Production lane</SectionLabel>
              <span className="text-xs text-ink3">{selected?.eyebrow || 'Choose a format'}</span>
            </div>
            <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(160px,1fr))]">
              {catalog.lanes.map((item, index) => {
                const on = item.id === s.selectedLane;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setSelectedLane(item.id)}
                    className={cx(
                      'flex flex-col gap-1 rounded-lg border p-3 text-left transition-colors duration-150',
                      on ? 'border-honey/50 bg-honey-tint' : 'border-line1 bg-bg2 hover:border-line2 hover:bg-bg3',
                    )}
                  >
                    <span className="font-mono text-[11px] text-ink3">{String(index + 1).padStart(2, '0')}</span>
                    <b className="text-[13px] font-semibold text-ink1">{item.label}</b>
                    <small className="text-[11px] text-ink3">{item.eyebrow}</small>
                  </button>
                );
              })}
            </div>
          </section>

          {/* Source */}
          {selected?.supports.source ? (
            <section className="flex flex-col gap-3">
              <SectionLabel>{s.selectedLane === 'clip' ? 'Long-form source' : 'Existing media'}</SectionLabel>
              <Field label="URL or approved local path">
                <TextInput maxLength={4000} required placeholder="https://…" value={w.source} onChange={(e) => setWorkflow({ source: e.target.value })} />
              </Field>
              {s.selectedLane === 'clip' ? (
                <Field label="Creator or owner (optional)">
                  <TextInput maxLength={300} placeholder="Account or rights owner" value={w.creator} onChange={(e) => setWorkflow({ creator: e.target.value })} />
                </Field>
              ) : null}
            </section>
          ) : null}

          {/* Scenes */}
          {selected?.supports.scenes ? (
            <section className="flex flex-col gap-3">
              <SectionLabel>Scenes</SectionLabel>
              <SceneEditor />
            </section>
          ) : null}

          {/* Production settings */}
          <section className="flex flex-col gap-3">
            <SectionLabel>Production settings</SectionLabel>
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Audience"><TextInput maxLength={1000} placeholder="Who this is for" value={w.audience} onChange={(e) => setWorkflow({ audience: e.target.value })} /></Field>
              <Field label="Goal"><TextInput maxLength={1000} placeholder="What should happen after watching" value={w.goal} onChange={(e) => setWorkflow({ goal: e.target.value })} /></Field>
              <Field label="Aspect ratio">
                <NativeSelect value={w.aspectRatio} onChange={(e) => setWorkflow({ aspectRatio: e.target.value })}>
                  {(catalog.aspect_ratios || []).map((ar) => <option key={ar} value={ar}>{ar}</option>)}
                </NativeSelect>
              </Field>
              <Field label="Target runtime (sec)">
                <TextInput type="number" min="1" max="7200" className="font-mono" value={w.runtimeSeconds} onChange={(e) => setWorkflow({ runtimeSeconds: e.target.value })} />
              </Field>
              <Field label="Tone" className="md:col-span-2"><TextInput maxLength={500} placeholder="Direct, warm, cinematic, dry…" value={w.tone} onChange={(e) => setWorkflow({ tone: e.target.value })} /></Field>
            </div>
            {selected?.supports.media_source ? (
              <>
                <div className="grid gap-3 md:grid-cols-3">
                  <Field label="Media source">
                    <NativeSelect value={w.mediaSource} onChange={(e) => setWorkflow({ mediaSource: e.target.value })}>
                      {MEDIA_SOURCE_GROUPS.map(([group, options]) => (
                        <optgroup key={group} label={group}>
                          {options.map((option) => (
                            <option key={option.value} value={option.value}>{option.label}</option>
                          ))}
                        </optgroup>
                      ))}
                    </NativeSelect>
                  </Field>
                  <Field label="Batch count">
                    <NativeSelect value={w.videoCount} onChange={(e) => setWorkflow({ videoCount: e.target.value })}>
                      {[1, 2, 3, 4, 5].map((n) => <option key={n} value={String(n)}>{n}</option>)}
                    </NativeSelect>
                  </Field>
                  <Field label="Clip cadence">
                    <NativeSelect value={w.clipDuration} onChange={(e) => setWorkflow({ clipDuration: e.target.value })}>
                      {[2, 3, 4, 5, 6, 8].map((n) => <option key={n} value={String(n)}>{n} seconds</option>)}
                    </NativeSelect>
                  </Field>
                </div>
                {mediaSourceKind(w.mediaSource) ? (
                  <div className="flex flex-col gap-2 rounded-lg border border-line1 bg-bg2/50 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <RoutePicker
                        up={false}
                        kind={mediaSourceKind(w.mediaSource)}
                        icon={mediaSourceKind(w.mediaSource) === 'video' ? 'video' : 'image'}
                        label={mediaSourceKind(w.mediaSource) === 'video' ? 'Clip model' : 'Still model'}
                        route={w.mediaRoute}
                        onRouteChange={setMediaRoute}
                      />
                    </div>
                    <p className="text-xs text-ink3">
                      {mediaSourceKind(w.mediaSource) === 'video'
                        ? 'One generated clip per beat. Same models as the Video studio — local, API, or an attached rental.'
                        : 'One generated still per beat, animated into the timeline. Same models as the Image studio — local, API, or an attached rental.'}
                    </p>
                  </div>
                ) : null}
              </>
            ) : null}
          </section>

          {/* Providers */}
          <section className="flex flex-col gap-3">
            <SectionLabel>Providers & routing</SectionLabel>
            {roles.length ? (
              <div className="grid gap-3 md:grid-cols-2">
                {roles.map((role) => (
                  <Field key={role} label={titleCase(role)}>
                    <NativeSelect value={w.providerRoles[role] || ''} onChange={(e) => setProviderRole(role, e.target.value)}>
                      <option value="">Automatic</option>
                      {(catalog.providers_by_role[role] || []).map((provider) => (
                        <option key={provider.id} value={provider.id}>
                          {providerLabel(provider.id)}{provider.available ? ' · ready' : ''}
                        </option>
                      ))}
                    </NativeSelect>
                  </Field>
                ))}
              </div>
            ) : (
              <p className="text-xs text-ink3">This step does not choose a generation provider.</p>
            )}
          </section>

          {/* Voice & captions */}
          {selected?.supports.voice ? (
            <section className="flex flex-col gap-3">
              <SectionLabel>Voice, audio & captions</SectionLabel>
              <ToggleRow label="Voiceover" hint="Generate narration for voiced lanes" checked={w.voiceEnabled} onChange={(v) => setWorkflow({ voiceEnabled: v })} />
              <ToggleRow label="Subtitles" hint="Render readable captions" checked={w.subtitlesEnabled} onChange={(v) => setWorkflow({ subtitlesEnabled: v })} />
              <div className="grid gap-3 md:grid-cols-2">
                <Field label="Delivery"><TextInput maxLength={300} placeholder="Calm, quick, confident" value={w.voiceDelivery} onChange={(e) => setWorkflow({ voiceDelivery: e.target.value })} /></Field>
                <Field label="Voice ID (optional)"><TextInput maxLength={200} placeholder="Use provider default" value={w.voiceId} onChange={(e) => setWorkflow({ voiceId: e.target.value })} /></Field>
                <Field label="Caption position">
                  <NativeSelect value={w.subtitlePosition} onChange={(e) => setWorkflow({ subtitlePosition: e.target.value })}>
                    <option value="bottom">Bottom</option>
                    <option value="center">Center</option>
                    <option value="top">Top</option>
                  </NativeSelect>
                </Field>
                <Field label="Caption size (px)"><TextInput type="number" min="20" max="140" className="font-mono" value={w.subtitleSize} onChange={(e) => setWorkflow({ subtitleSize: e.target.value })} /></Field>
              </div>
            </section>
          ) : null}

          {/* Distribution */}
          <section className="flex flex-col gap-3">
            <SectionLabel>Distribution</SectionLabel>
            <div className="flex flex-wrap gap-1.5">
              {(catalog.platforms || []).map((platform) => {
                const on = w.platforms.includes(platform);
                return (
                  <button
                    key={platform}
                    type="button"
                    onClick={() => togglePlatform(platform)}
                    className={cx(
                      'rounded-full border px-3 py-1 text-xs font-medium transition-colors duration-150',
                      on ? 'border-honey/50 bg-honey-tint text-honey' : 'border-line1 bg-bg2 text-ink2 hover:border-line2',
                    )}
                  >
                    {platform}
                  </button>
                );
              })}
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Caption (optional)"><TextArea rows={3} maxLength={5000} value={w.publishCaption} onChange={(e) => setWorkflow({ publishCaption: e.target.value })} /></Field>
              <Field label="Call to action (optional)"><TextArea rows={3} maxLength={500} value={w.publishCta} onChange={(e) => setWorkflow({ publishCta: e.target.value })} /></Field>
            </div>
            <p className="text-[11px] text-ink3">Creating a run never publishes. Distribution stays behind evaluation, rights approval, dry run, and the live-publish gate.</p>
          </section>

          {/* Operator controls */}
          <section className="flex flex-col gap-3">
            <SectionLabel>Operator controls</SectionLabel>
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Privacy">
                <NativeSelect value={w.privacy} onChange={(e) => setWorkflow({ privacy: e.target.value })}>
                  {(catalog.privacy_modes || []).map((mode) => <option key={mode} value={mode}>{titleCase(mode)}</option>)}
                </NativeSelect>
              </Field>
              <Field label="Maximum generation spend ($)">
                <TextInput type="number" min="0" max="10000" step="0.01" className="font-mono" value={w.maxCost} onChange={(e) => setWorkflow({ maxCost: e.target.value })} />
              </Field>
              <Field label="Operator token (held in memory only)" className="md:col-span-2" hint="Needed only for cancel, retry, and approval decisions.">
                <TextInput type="password" autoComplete="off" placeholder="••••••••" value={w.operatorToken} onChange={(e) => setWorkflow({ operatorToken: e.target.value })} />
              </Field>
            </div>
          </section>
        </div>

        {/* Launch rail */}
        <aside className="flex flex-col gap-3 md:sticky md:top-4 md:self-start">
          <Card className="flex flex-col gap-3 p-4">
            <SectionLabel>Production brief</SectionLabel>
            <div>
              <b className="text-[13px] font-semibold text-ink1">{selected?.label || 'First-frame ad'}</b>
              <p className="mt-0.5 text-[11px] leading-relaxed text-ink3">{selected?.description || 'Loading production details…'}</p>
            </div>
            <dl className="grid grid-cols-2 gap-2 text-xs">
              {[
                ['Format', w.aspectRatio || selected?.default_aspect_ratio || '—'],
                ['Runtime', `${w.runtimeSeconds || selected?.default_runtime_seconds || 0} sec`],
                ['Scenes', selected?.supports.scenes ? String(s.scenes.length) : 'Auto'],
                ['Budget', budget > 0 ? `$${budget.toFixed(2)} max` : '$0 local'],
              ].map(([label, value]) => (
                <div key={label} className="rounded-md bg-bg1 p-2">
                  <dt className="text-[10px] uppercase tracking-[0.06em] text-ink3">{label}</dt>
                  <dd className="mt-0.5 font-mono text-[13px] text-ink1">{value}</dd>
                </div>
              ))}
            </dl>
            <Button type="submit" variant="primary" icon="arrowRight" loading={busy}>Create production</Button>
            <p className="text-[11px] leading-relaxed text-ink3">Creates a durable run and stops at the first agent, provider, evaluation, or approval boundary.</p>
          </Card>
          <Card className="p-3">
            {recent ? (
              <button type="button" onClick={() => openRun(recent.run_id)} className="w-full text-left">
                <SectionLabel>Latest run</SectionLabel>
                <b className="mt-1 block truncate text-[13px] font-semibold text-ink1">{runDisplayTitle(recent)}</b>
                <small className="text-[11px] text-ink3">{humanize(recent.status)}</small>
              </button>
            ) : (
              <>
                <SectionLabel>Latest run</SectionLabel>
                <b className="mt-1 block text-[13px] font-semibold text-ink1">No productions yet</b>
                <small className="text-[11px] text-ink3">Your first run will appear here.</small>
              </>
            )}
          </Card>
        </aside>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* PlannerView                                                        */
/* ------------------------------------------------------------------ */

export function PlannerView({ active }) {
  const s = useHub();
  const threadRef = useRef(null);
  const promptRef = useRef(null);
  const titleRef = useRef(null);
  const fileRef = useRef(null);

  // Imperative hooks the data layer calls (thread scroll, focus). Registered once.
  useEffect(() => registerThreadScroller(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }), []);
  useEffect(() => registerHubFocus('prompt', (opts) => {
    const el = promptRef.current;
    if (!el) return;
    el.focus();
    if (opts?.caretToEnd) { try { el.selectionStart = el.selectionEnd = el.value.length; } catch { /* non-critical */ } }
  }), []);
  useEffect(() => registerHubFocus('workflowTitle', () => titleRef.current?.focus()), []);

  // While the planner is the active simple surface, the explore dock inserts here.
  useEffect(() => {
    if (!active || s.createMode !== 'simple') return undefined;
    return registerPromptInserter((text) => {
      const current = hubState.composer.prompt;
      const nl = current && !current.endsWith('\n') ? '\n' : '';
      setComposer({ prompt: `${current}${nl}${text}` });
      promptRef.current?.focus();
    });
  }, [active, s.createMode]);

  const advanced = s.createMode === 'advanced';

  return (
    <div className={active ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
      <HubToolbar
        kicker="Agent-directed production"
        title="Planner"
        right={<Segmented options={MODE_OPTIONS} value={s.studioMode} onChange={setStudioMode} />}
      />
      {advanced
        ? <AdvancedForm titleRef={titleRef} />
        : <SimpleStudio threadRef={threadRef} promptRef={promptRef} fileRef={fileRef} />}
    </div>
  );
}
