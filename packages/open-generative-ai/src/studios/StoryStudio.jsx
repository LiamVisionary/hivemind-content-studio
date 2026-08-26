// Story Studio — a character-led short, produced one decision at a time.
//
// The pipeline is concept → character sheets → location plate → storyboard →
// motion script → gate. It is a separate studio rather than a mode of the Video
// studio because the expensive decisions all happen BEFORE a video model is
// asked for anything: which pair, what they are locked to, where it is, how
// many beats, and what actually moves. By the time a clip is generated, all of
// that should already be settled and visible.
//
// What lives where, and why:
//   concept     the producer (a local LLM, lib/localProducer.js) drafts options;
//               the director picks. Options before decisions, every time.
//   sheets      drawn here, then promoted to persistent references — so they
//               show up in the Video studio's reference picker with no export.
//   plate       the same, and deliberately EMPTY. The sheets own the characters.
//   board       direction for the render, not a shot list it will trace.
//   motion      built here, generated in the Video studio. That studio already
//               owns model choice, reference budget, lanes and resume; a second
//               video composer in here would be a second set of all of it.
//   gate        the checks in the order they are cheap to fix, and a repair per
//               failure that names ONE layer to change.
//
// Method credit: the production sequence follows The Viral Character Method
// (Yume no Sekai), bought and read by the owner. The decision system is
// implemented here in this studio's own words and data model; no text, template
// or example from that package is reproduced.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'react-hot-toast';

import { useMediaSrc } from '../hooks/hooks.js';
import { registerPromptInserter, loadStudioSetup } from '../app/promptTarget.js';
import { defaultPick, fetchCapabilityMatrix, rankModels, serverRows } from '../lib/capabilityMatrix.js';
import { getComposerSection, hydrateComposerState, updateComposerSection } from '../lib/composerState.js';
import { isHivemindStudioEnabled } from '../lib/hivemindStudio.js';
import { isLocalAIAvailable } from '../lib/localInferenceClient.js';
import { LOCAL_MODEL_CATALOG } from '../lib/localModels.js';
import {
  askProducer, connectHivemindosAccount, hivemindosLinkState, requestHivemindosLink,
  saveProviderKey, startCreditTopUp, textModelCatalog,
} from '../lib/localProducer.js';
import { needsBrowserKey, runImage, transportFor } from '../lib/modelRunner.js';
import {
  fetchOAuthStatus, readinessFor, readinessFromError, refreshMuapiKeyLocation, startOAuthLogin,
} from '../lib/providerReadiness.js';
import { promoteOutputToReference } from '../lib/outputToReference.js';
import { canvasMismatch, canvasPixels } from './story/sheetLayout.js';
import { ModelSourcePicker } from '../components/ModelSourcePicker.jsx';
import { lastUsedModelId, rememberModelId, sortModels } from '../lib/promptHelperRuntime.js';
import {
  ACCOUNTS, APP_ROUTE, HIVEMINDOS, LINK_POLL_MS, LINK_WAIT_MS, LOCAL, privacyLine, remedyFor, routeOf, rowFor, sourceState, startingModelId, summaryLine, tabOf,
} from '../lib/textModels.js';
import { Icon } from '../ui/icons.jsx';
import {
  Button, Card, EmptyState, Field, IconButton, NativeSelect, Pill, SectionLabel, Segmented, Slider,
  Spinner, StudioLayout, TextArea, TextInput, cx,
} from '../ui/kit.jsx';
import { AuthModal } from '../dialogs/AuthModal.jsx';
import { ModelFitPicker } from './ModelFitPicker.jsx';

import {
  conceptBrief, conceptCount, contactSheetLayout, contactSheetPrompt, contractBlanks, contractSentence,
  normalizeConcepts, SHORTLIST_CRITERIA, TONES,
} from './story/concept.js';
import {
  blankCharacter, characterSheetPrompt, IDENTITY_LOCKS, neverChangeLine,
  SHEET_AUDIT, SHEET_BACKGROUNDS, SILHOUETTE_TEST,
} from './story/characterSheet.js';
import { LOCATION_ASPECTS, locationGaps, locationPrompt, MOTION_SOURCES } from './story/location.js';
import {
  blankPanel, BOARD_FORMATS, boardFormat, boardLayout, boardPrompt, boardWarnings, defaultPanels, recommendBoard, SHOT_REASONS,
} from './story/board.js';
import {
  AUDIO_LAYERS, budgetReport, defaultBeats, motionScript, MOTION_LAYERS, MUSIC_RULES,
  scriptWarnings, segmentPlan, tighten,
} from './story/motionScript.js';
import {
  buildCaption, CAPTION_BEATS, FINISH_ORDER, ITERATION_LAYERS, QA_CHECKS,
  repairsFor, shipVerdict, SIGNAL_READS,
} from './story/qa.js';
import { STORY_EXAMPLE } from './story/example.js';
import { blankStory, producerIsRunning, restoreStory } from './story/state.js';
import { storyHandoff } from './story/handoff.js';
import {
  acceptedValues, blankFieldsIn, fieldMap, fieldsFor, fillBrief, fillChunks, storyContext, writePath,
} from './story/fields.js';

const STAGES = [
  { id: 'concept', label: 'Concept', icon: 'sparkles' },
  { id: 'characters', label: 'Characters', icon: 'persona' },
  { id: 'location', label: 'Location', icon: 'globe' },
  { id: 'board', label: 'Storyboard', icon: 'grid' },
  { id: 'motion', label: 'Motion', icon: 'film' },
  { id: 'ship', label: 'Gate', icon: 'check' },
];

function StageHeader({ index, stage, done, busy, blanks, fields, onFillSection, children }) {
  const running = producerIsRunning(busy, `fill-section:${stage.id}`);
  // A section with nothing blank used to leave a dead grey button reading
  // "Nothing blank" — the one state where the director most wants another pass
  // at it. It offers the redraft instead, and names how many fields that is so
  // it is never a surprise.
  const redraft = !running && blanks === 0 && fields > 0;
  return (
    <div className="flex items-center gap-2.5">
      <span className={cx(
        'grid h-6 w-6 shrink-0 place-items-center rounded-full border text-[11px] font-bold',
        done ? 'border-transparent bg-ok-tint text-ok' : 'border-line1 bg-bg2 text-ink3',
      )}
      >
        {done ? <Icon name="check" size={13} /> : index + 1}
      </span>
      <SectionLabel className="!mb-0">{stage.label}</SectionLabel>
      <div className="ml-auto flex items-center gap-2">
        {children}
        {onFillSection ? (
          <Button
            size="sm"
            icon={running || redraft ? 'refresh' : 'wand'}
            onClick={() => onFillSection(stage.id, { redraft })}
            loading={running}
            disabled={Boolean(busy) || (blanks === 0 && !redraft)}
          >
            {running ? (redraft ? 'Redrafting…' : 'Filling…')
              : blanks ? `Fill ${blanks} blank${blanks === 1 ? '' : 's'}`
              : redraft ? `Redraft ${fields}`
              // A section whose fields do not exist yet — no characters added,
              // no beats written. "Redraft 0" was a second dead label in place
              // of the first one; this says what is actually true.
              : 'Nothing to write yet'}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** The real pixel size of a rendered image, or null if it cannot be read. */
function measureCanvas(url) {
  return new Promise((resolve) => {
    if (!url) { resolve(null); return; }
    const probe = new Image();
    probe.onload = () => resolve({ width: probe.naturalWidth, height: probe.naturalHeight });
    probe.onerror = () => resolve(null);
    probe.src = url;
  });
}

function Plate({ url, alt, className = '' }) {
  const src = useMediaSrc(url);
  if (!src) return null;
  return <img src={src} alt={alt} className={cx('max-h-80 rounded-md border border-line1', className)} />;
}

/**
 * What the producer is doing, beside the button that asked it.
 *
 * The producer bar at the top of the studio says the same thing, but a stage
 * button can be a whole page below it — and the wait here is not a spinner's
 * worth. Loading a local model off a cold cache is minutes, and "Loading Qwen3
 * 30B…" is the only thing that distinguishes that from a hung request.
 */
function ProducerStatus({ task, busy, status, onCancel }) {
  if (!producerIsRunning(busy, task)) return null;
  return (
    <span className="flex items-center gap-2 text-[11px] text-ink3">
      <Spinner size={12} />
      {status || 'Working…'}
      <Button size="sm" onClick={onCancel}>Cancel</Button>
    </span>
  );
}

/**
 * The wand beside one input: write this field from everything else.
 *
 * Deliberately an icon and not a labelled button. There is one on nearly every
 * field in the studio, and forty "Auto-fill"s would drown the writing they sit
 * next to.
 */
function FillButton({ busyKey, busy, onClick, hint }) {
  const running = producerIsRunning(busy, busyKey);
  return (
    <IconButton
      icon={running ? 'refresh' : 'wand'}
      label={hint}
      size="sm"
      onClick={onClick}
      disabled={Boolean(busy)}
      className={cx('!h-5 !w-5 shrink-0', running && 'animate-spin text-honey')}
    />
  );
}

/**
 * A labelled input with its own fill button, reading its label and guidance from
 * the field registry.
 *
 * Defined at module scope on purpose: a component declared inside the studio
 * would be a new type on every render, so React would unmount and remount the
 * input underneath it and the field would lose focus on every keystroke.
 */
function FillField({ spec, id, busy, onFill, className = '', children }) {
  return (
    <Field
      label={spec?.label || id}
      hint={spec?.hint}
      className={className}
      labelRight={(
        <FillButton
          busyKey={`fill:${id}`}
          busy={busy}
          onClick={() => onFill([id])}
          hint={`Write ${spec?.label || id} from the rest of the story`}
        />
      )}
    >
      {children}
    </Field>
  );
}


/**
 * Which model thinks for you, and where it runs.
 *
 * Three tabs because there are three genuinely different answers, not because a
 * list of hundreds needed chopping up: a model on this machine (free, private,
 * as fast as the hardware), one of HivemindOS's own tiers, or any named model
 * HivemindOS can reach. The last two are the same credits and the same account
 * as the HivemindOS app — the studio calls that app's own model surface rather
 * than keeping a second catalog or a second bill.
 *
 * A source that cannot answer right now says so ON its tab, with the button that
 * repairs it. An empty tab with no explanation is how "the producer is broken"
 * gets reported for something that is one press from working.
 */

/**
 * A failure that carries its own repair, rendered with the repair in it.
 *
 * The reported experience was a toast reading "OpenAI GPT Image (ChatGPT
 * sign-in): Invalid refresh token." and nothing to press. The sentence is kept
 * — it is the truth and it helps when something else is wrong — but it is no
 * longer the only thing offered.
 */
function reconnectToast(t, readiness, onFix) {
  return (
    <span className="flex flex-col gap-1.5 text-[12px]">
      <b>{readiness.label}</b>
      <span className="text-ink2">{readiness.detail}</span>
      <span className="flex gap-2">
        <Button size="sm" icon="refresh" onClick={onFix}>{readiness.action.label}</Button>
        <Button size="sm" onClick={() => toast.dismiss(t.id)}>Dismiss</Button>
      </span>
    </span>
  );
}

/** A list of objections, shown as objections rather than as errors — every one
 *  of them is something the director may have chosen on purpose. */
function Notes({ items, tone = 'warn' }) {
  if (!items?.length) return null;
  return (
    <ul className={cx('flex flex-col gap-1 text-[11px] leading-snug', tone === 'warn' ? 'text-warn' : 'text-ink3')}>
      {items.map((item) => <li key={item}>• {item}</li>)}
    </ul>
  );
}

export function StoryStudio({ active = true } = {}) {
  const [story, setStory] = useState(blankStory);
  const [hydrated, setHydrated] = useState(false);

  // The producer — one local model for the whole session rather than one per
  // stage. Which model is thinking is a session decision, not a stage decision.
  const [runtime, setRuntime] = useState(null);
  const [producerId, setProducerId] = useState('');
  const [producerOpen, setProducerOpen] = useState(false);
  // Which tab the picker is on, and what is typed in its search box. The tab
  // follows the CHOSEN model when the picker opens, so "Change" lands where the
  // current answer came from rather than always on the first tab.
  const [producerTab, setProducerTab] = useState('');
  const [producerQuery, setProducerQuery] = useState('');
  // Which of the owner's provider accounts the model list is narrowed to, and
  // the key field a "not connected" account opened. Both are picker state, not
  // session state: which account a model belongs to is carried by its id.
  const [producerAccount, setProducerAccount] = useState('');
  const [keyField, setKeyField] = useState('');
  const [savingKey, setSavingKey] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [linking, setLinking] = useState(false);
  // Two pieces of state, because they answer different questions. `busy` is
  // WHICH ask is running and lives for the whole call; `thinking` is what it is
  // doing right now and is overwritten several times by askProducer's onStatus.
  // They used to be one string, so `loading={thinking === 'concepts…'}` went
  // false the instant the first status arrived and the button dropped its
  // spinner while staying disabled — a dead button, which is exactly what a
  // press with no feedback looks like.
  const [busy, setBusy] = useState('');
  const [thinking, setThinking] = useState('');

  const [matrix, setMatrix] = useState(null);
  const [matrixError, setMatrixError] = useState('');
  // Which accounts are connected, read BEFORE anything is generated. A picker
  // that only learns this from a failed request has already wasted the press.
  const [oauth, setOauth] = useState(null);
  const [fixing, setFixing] = useState('');
  const [localModels] = useState(() => LOCAL_MODEL_CATALOG.filter((model) => model.type !== 'video'));
  const [sheetModel, setSheetModel] = useState(null);
  const [plateModel, setPlateModel] = useState(null);
  const [boardModel, setBoardModel] = useState(null);

  const [drawing, setDrawing] = useState('');
  const [authOpen, setAuthOpen] = useState(false);
  const abortRef = useRef(null);
  const storyRef = useRef(story);
  storyRef.current = story;

  useEffect(() => () => abortRef.current?.abort(), []);

  /* ---------------- persistence ---------------- */

  // A production outlives a page load by days. In studio mode the whole object
  // is encrypted in this browser and stored as ciphertext (composerState.js) —
  // the server never sees a character, a beat or a caption.
  useEffect(() => {
    let alive = true;
    hydrateComposerState().then(() => {
      if (!alive) return;
      const saved = getComposerSection('story');
      if (saved && Object.keys(saved).length) setStory(restoreStory(saved));
      setHydrated(true);
    }).catch(() => setHydrated(true));
    return () => { alive = false; };
  }, []);

  const update = useCallback((patch) => {
    setStory((current) => {
      const next = typeof patch === 'function' ? patch(current) : { ...current, ...patch };
      // Only after hydration: an early write would persist the blank defaults
      // over a real production that had not finished loading yet.
      if (hydrated) updateComposerSection('story', next);
      return next;
    });
  }, [hydrated]);

  /* ---------------- the producer's model ---------------- */

  // One catalog for both engines. A machine with no local weights on it used to
  // have no producer at all; HivemindOS's models answer for it now, on the same
  // credits as the HivemindOS app itself.
  const refreshRuntime = useCallback(async () => {
    try {
      const payload = await textModelCatalog();
      setRuntime(payload);
      setProducerId((current) => current || startingModelId(payload, lastUsedModelId()));
    } catch {
      setRuntime({ models: [], sources: {} });
    }
  }, []);

  useEffect(() => { void refreshRuntime(); }, [refreshRuntime]);

  // Local rows keep their loaded-first order; the cloud list is already ordered
  // by HivemindOS (its own tiers first, then the gateway's catalog).
  const localProducerModels = useMemo(() => sortModels(sourceState(runtime, LOCAL).models), [runtime]);
  const producer = rowFor(runtime, producerId);
  const producerTabOpen = producerTab || (producer ? tabOf(producer) : LOCAL);
  // What ensureProducerModel needs to know about THIS machine, in the shape it
  // already reads, so a cloud catalog does not send it looking for a local id.
  const localSnapshot = useMemo(() => ({ models: localProducerModels }), [localProducerModels]);

  const cancelProducer = useCallback(() => abortRef.current?.abort(), []);

  /**
   * The repair a source offered, performed.
   *
   * Every state this picker can be in that stops a press is paired with one of
   * these, so the owner is never told what is wrong without being shown where to
   * fix it — the project's rule since the OAuth error that had nothing to press.
   */
  /**
   * Connect the owner's HivemindOS account, once.
   *
   * The key never comes back to the browser after this: the server verifies it
   * against the gateway, stores it encrypted on the machine, and from then on
   * the studio only ever sees the balance.
   */
  const connectAccount = useCallback(async (token) => {
    setConnecting(true);
    try {
      const result = await connectHivemindosAccount(token);
      await refreshRuntime();
      toast.success(result?.label ? `Connected — ${result.label}.` : 'HivemindOS account connected.');
    } catch (error) {
      toast.error(error?.message || 'That key was not accepted.');
    } finally {
      setConnecting(false);
    }
  }, [refreshRuntime]);

  /**
   * Ask the HivemindOS app on this machine to hand its balance over.
   *
   * A custom-scheme link that nothing handles fails silently — the browser does
   * not error, no window appears, there is nothing to catch. So this treats
   * silence as an answer: poll while the owner is over in the app, and after the
   * budget say what happened and leave the paste path open. A button that waits
   * forever is the same failure as a button that does nothing.
   */
  const linkThroughApp = useCallback(async () => {
    setLinking(true);
    try {
      const { url, nonce } = await requestHivemindosLink();
      window.location.href = url;
      const deadline = Date.now() + LINK_WAIT_MS;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, LINK_POLL_MS));
        const { state } = await hivemindosLinkState(nonce).catch(() => ({ state: 'pending' }));
        if (state === 'linked') {
          await refreshRuntime();
          toast.success('Linked to your HivemindOS balance.');
          return;
        }
        if (state === 'expired') break;
      }
      toast(
        'HivemindOS did not answer. Open it and try again, or paste an account key below.',
        { icon: '🐝', duration: 10000 },
      );
    } catch (error) {
      toast.error(error?.message || 'Could not ask HivemindOS to link.');
    } finally {
      setLinking(false);
    }
  }, [refreshRuntime]);

  /**
   * Save one provider key into the machine's shared credential store.
   *
   * The value goes to the server and is never held in this browser. The catalog
   * is re-read straight after, because an account that is connected but still
   * shows "not connected" until a reload is indistinguishable from one that
   * failed to connect.
   */
  const saveKey = useCallback(async (name, value) => {
    setSavingKey(true);
    try {
      await saveProviderKey(name, value);
      setKeyField('');
      await refreshRuntime();
      toast.success(`${name} saved. Its models are on the Your accounts tab.`);
    } catch (error) {
      toast.error(error?.message || 'That key could not be saved.');
    } finally {
      setSavingKey(false);
    }
  }, [refreshRuntime]);

  const runRemedy = useCallback(async (remedy) => {
    // Called both with a bare action (the older call sites) and with the whole
    // remedy, because a provider account's repair has to name WHICH account.
    const action = typeof remedy === 'string' ? remedy : String(remedy?.action || '');
    if (action === 'accounts') {
      setProducerOpen(true);
      setProducerTab(ACCOUNTS);
      return;
    }
    if (action === 'key') {
      setProducerOpen(true);
      setProducerTab(ACCOUNTS);
      setKeyField(String(remedy?.key || ''));
      return;
    }
    if (action === 'oauth') {
      // The same sign-in the Providers view runs — one flow per account on this
      // machine, so signing in here signs in for HivemindOS too.
      try {
        const url = await startOAuthLogin(String(remedy?.provider || ''));
        window.open(url, '_blank', 'noopener,noreferrer');
        toast('Finish the sign-in in the tab that opened, then press Try again.', { icon: '🔑', duration: 10000 });
      } catch (error) {
        toast.error(
          error?.instruction ? `${error.message} ${error.instruction}` : (error?.message || 'Could not start the sign-in.'),
        );
      }
      return;
    }
    if (action === 'models') {
      window.dispatchEvent(new CustomEvent('navigate', { detail: { page: 'models' } }));
      return;
    }
    if (action === 'refresh') { void refreshRuntime(); return; }
    if (action === 'connect') {
      // The form is already on the tab; this only makes sure it is the tab in
      // view, because a button that appears to do nothing is worse than no
      // button at all.
      setProducerOpen(true);
      setProducerTab(HIVEMINDOS);
      return;
    }
    if (action === 'top-up') {
      // Two different acts behind one button. With the HivemindOS app running,
      // credits belong there — buying a second balance here would split the one
      // the machine already shares. Without it, "install HivemindOS first" is
      // not an answer, so the studio opens the checkout itself.
      if (routeOf(runtime) === APP_ROUTE) {
        const url = sourceState(runtime, HIVEMINDOS).url;
        if (url) window.open(url, '_blank', 'noopener,noreferrer');
        toast('Add credits in HivemindOS — this studio spends the same balance.', { icon: '🐝', duration: 8000 });
        return;
      }
      try {
        const { checkoutUrl } = await startCreditTopUp();
        if (!checkoutUrl) throw new Error('HivemindOS did not return a checkout page.');
        window.open(checkoutUrl, '_blank', 'noopener,noreferrer');
        toast('Finish the checkout in the tab that opened, then press Try again.', { icon: '💳', duration: 10000 });
      } catch (error) {
        toast.error(error?.message || 'Could not open the HivemindOS checkout.');
      }
      return;
    }
    const url = sourceState(runtime, HIVEMINDOS).url;
    if (!url) {
      toast('HivemindOS is not installed on this machine yet.', { icon: '🐝' });
      return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  }, [runtime, refreshRuntime]);

  /**
   * A producer failure, shown with its repair when it named one.
   *
   * The engines answer refusals as `{message, remedy, provider}` — an expired
   * ChatGPT sign-in, a key the provider rejected, credits that ran out — so a
   * plain `toast.error(message)` throws the only actionable half away. This is
   * the same rule the image side already follows after the OAuth error that had
   * nothing to press.
   */
  const producerFailed = useCallback((error, fallback) => {
    const message = error?.message || fallback;
    const remedy = remedyFor(error?.remedy);
    if (!remedy) { toast.error(message); return; }
    toast.error((t) => (
      <span className="flex flex-col gap-1.5 text-[12px]">
        <span className="text-ink2">{message}</span>
        <span className="flex gap-2">
          <Button size="sm" onClick={() => { toast.dismiss(t.id); void runRemedy(remedy); }}>
            {remedy.label}
          </Button>
          <Button size="sm" onClick={() => toast.dismiss(t.id)}>Dismiss</Button>
        </span>
      </span>
    ), { duration: 12000 });
  }, [runRemedy]);


  /** One ask, with no opinion about buttons. Throws; the callers decide whether
   *  a failure is a toast or one step of a longer job. */
  const runProducer = useCallback(async (task, brief, context, { onStatus, signal }) => {
    const { result, notes } = await askProducer({
      modelId: producer.id, task, brief, context,
      onStatus, signal, snapshot: localSnapshot, source: producer.source,
    });
    // A short answer is not a failure and not a success. Say which it was.
    for (const note of notes) toast(note, { icon: '✂️', duration: 8000 });
    void refreshRuntime();
    return result;
  }, [producer, localSnapshot, refreshRuntime]);

  const ask = useCallback(async (task, brief, context, { busyKey = '' } = {}) => {
    if (!producer) {
      toast.error('Pick a model for the producer first.');
      setProducerOpen(true);
      return null;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    // A fill needs its own key — forty fields all reporting `busy === 'fill'`
    // would spin every wand in the studio at once.
    setBusy(busyKey || task);
    // Something to read before the first onStatus lands. Loading a 30B model
    // off a cold page cache is minutes, not a tick.
    setThinking('Waking the producer…');
    try {
      return await runProducer(task, brief, context, {
        onStatus: setThinking, signal: controller.signal,
      });
    } catch (error) {
      if (!error?.cancelled) producerFailed(error, 'The producer could not answer that.');
      return null;
    } finally {
      setBusy('');
      setThinking('');
      abortRef.current = null;
    }
  }, [producer, runProducer]);

  /* ---------------- auto-fill ---------------- */

  // Rebuilt when the production changes rather than looked up per field: forty
  // fields each re-scanning six sections would rebuild the registry forty times
  // a keystroke.
  const specs = useMemo(() => fieldMap(story), [story]);

  // How many blanks each stage's fill button would write. Shown on the button
  // so pressing it is never a surprise.
  const blanks = useMemo(() => Object.fromEntries(
    STAGES.map((stage) => [stage.id, blankFieldsIn(stage.id, story).length]),
  ), [story]);

  // How many fields a redraft would rewrite, for the button that offers it once
  // a section has no blanks left.
  const stageFields = useMemo(() => Object.fromEntries(
    STAGES.map((stage) => [stage.id, fieldsFor(stage.id, story).length]),
  ), [story]);

  /**
   * Write the named fields from everything else the director has written.
   *
   * The context is the WHOLE production, not the stage in view — that is the
   * point of the button. The fields being written are omitted from it, because
   * a field offered as evidence for itself comes back as what is already there.
   */
  const fill = useCallback(async (ids, { busyKey = '' } = {}) => {
    const entries = ids.map((id) => specs.get(id)).filter(Boolean);
    if (!entries.length) return { written: 0 };
    if (!producer) {
      toast.error('Pick a model for the producer first.');
      setProducerOpen(true);
      return { written: 0 };
    }
    // Several asks, not one. See fillChunks: a seventeen-field section asked for
    // in a single answer overruns the model's room, and a cut-off answer used to
    // be a total loss.
    const chunks = fillChunks(entries);
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(busyKey || `fill:${entries[0].id}`);
    setThinking('Waking the producer…');
    // The story as it is being written, so chunk three can see what chunk one
    // wrote. Kept locally because React has not necessarily re-rendered between
    // two awaits, and a stale context is how the second half of a section ends
    // up contradicting the first.
    let draft = storyRef.current;
    let written = 0;
    let failure = '';
    // The error object as well as its sentence: a refusal that named a repair
    // has to keep it all the way to the summary toast, or the fill loop is the
    // one place the fix gets dropped.
    let failureError = null;
    let stopped = false;
    try {
      // Every chunk at once. They used to run one after another so a later
      // chunk could read what an earlier one wrote, but that made a seventeen-
      // field section four round trips deep — minutes of waiting for asks that
      // do not actually depend on each other. They all read the same story
      // instead, which is the story the director is looking at while they wait.
      const context = storyContext(draft, { omit: entries.map((entry) => entry.id) });
      if (!Object.keys(context).length) {
        failure = 'Nothing to go on yet — write something first, anywhere in the story.';
      } else {
        let landedChunks = 0;
        const onStatus = (line) => setThinking(
          chunks.length > 1 ? `${line} · ${landedChunks} of ${chunks.length} back` : line,
        );
        onStatus('Waking the producer…');
        const settled = await Promise.allSettled(chunks.map((group) => runProducer(
          'fill', fillBrief(group), context, { onStatus: () => {}, signal: controller.signal },
        ).then((result) => { landedChunks += 1; onStatus('Writing…'); return result; })));

        // Applied in chunk order, not completion order, so two runs of the same
        // press write the same story.
        for (let index = 0; index < chunks.length; index += 1) {
          const outcome = settled[index];
          if (outcome.status === 'rejected') {
            const error = outcome.reason;
            if (error?.cancelled) { stopped = true; continue; }
            // The first real refusal is the one reported: five chunks failing
            // on one dead credential is one problem, not five toasts.
            if (!failure) {
              failure = error?.message || 'The producer could not answer that.';
              failureError = error;
            }
            continue;
          }
          const accepted = acceptedValues(chunks[index], outcome.value?.values);
          const landed = Object.keys(accepted);
          if (!landed.length) continue;
          const apply = (current) => landed.reduce((next, id) => writePath(next, id, accepted[id]), current);
          draft = apply(draft);
          update(apply);
          written += landed.length;
        }
      }
    } finally {
      setBusy('');
      setThinking('');
      abortRef.current = null;
    }
    const total = entries.length;
    if (stopped) {
      if (written) toast(`Stopped — ${written} of ${total} written.`, { icon: '✍️' });
      return { written, stopped: true };
    }
    if (failure) {
      if (!written) producerFailed(failureError, failure);
      else toast(`Filled ${written} of ${total}, then the producer stopped: ${failure}`, { icon: '✍️', duration: 12000 });
      return { written, failed: true };
    }
    if (!written) {
      toast.error('Nothing usable came back for that.');
      return { written: 0 };
    }
    if (written < total) {
      toast(`Filled ${written} of ${total} — the rest came back empty. Press Fill again for those.`, { icon: '✍️' });
    }
    return { written };
  }, [producer, runProducer, specs, update]);

  const fillSection = useCallback(async (sectionId, { redraft = false } = {}) => {
    // A redraft asks for every field in the section, not just the empty ones —
    // which is the whole point of offering it once nothing is blank.
    const entries = redraft
      ? fieldsFor(sectionId, storyRef.current)
      : blankFieldsIn(sectionId, storyRef.current);
    if (!entries.length) {
      toast('Nothing to write in this section.', { icon: '\u270D\uFE0F' });
      return;
    }
    // A redraft overwrites work the director may have written by hand. The
    // button naming the count stops that being a surprise; keeping the version
    // it replaced stops it being a loss.
    const before = redraft ? storyRef.current : null;
    const outcome = await fill(entries.map((entry) => entry.id), { busyKey: `fill-section:${sectionId}` });
    // What `fill` reports, NOT what the ref says: `update()` is a React setter
    // and the re-render that moves `storyRef.current` has not happened by the
    // time this await resolves, so comparing references here always said
    // "nothing changed" and the Undo never appeared.
    if (before && outcome?.written) {
      toast((t) => (
        <span className="flex items-center gap-2 text-[12px]">
          <span>Redrafted {entries.length} field{entries.length === 1 ? '' : 's'}.</span>
          <Button size="sm" onClick={() => { update(() => before); toast.dismiss(t.id); }}>Undo</Button>
        </span>
      ), { icon: '\u270D\uFE0F', duration: 12000 });
    }
  }, [fill, update]);

  const fillOne = useCallback((ids) => { void fill(ids); }, [fill]);

  /* ---------------- the models that draw ---------------- */

  useEffect(() => {
    let alive = true;
    fetchCapabilityMatrix()
      .then((payload) => { if (alive) setMatrix(payload); })
      .catch(() => { if (alive) setMatrixError('Could not read the capability matrix — models are listed unrated.'); });
    return () => { alive = false; };
  }, []);

  const refreshOAuth = useCallback(async () => {
    // Both credentials this studio can act on, in one pass: which accounts are
    // connected, and whether this machine already holds the MUAPI key.
    const [status] = await Promise.all([fetchOAuthStatus(), refreshMuapiKeyLocation()]);
    setOauth(status);
    return status;
  }, []);

  useEffect(() => { void refreshOAuth(); }, [refreshOAuth]);

  const rowReadiness = useCallback((row) => readinessFor(row, { oauth }), [oauth]);

  /**
   * Repair whatever a row said was wrong, from the row itself.
   *
   * Opening the authorize URL rather than printing it: a link someone has to
   * copy out of a message is the same failure as an error they have to
   * interpret.
   */
  const fixReadiness = useCallback(async (action) => {
    if (!action) return;
    if (action.kind === 'muapi-key') { setAuthOpen(true); return; }
    if (action.kind !== 'oauth') return;
    const key = `oauth:${action.provider}`;
    setFixing(key);
    try {
      const url = await startOAuthLogin(action.provider);
      window.open(url, '_blank', 'noopener,noreferrer');
      toast('Finish the sign-in in the tab that just opened, then press Check again.', { icon: '🔑', duration: 9000 });
    } catch (error) {
      // The reason AND what to do about it. "Could not start the sign-in" on
      // its own is the kind of message this studio is not allowed to ship.
      toast.error(
        error?.instruction
          ? `${error.message}\n\n${error.instruction}`
          : (error?.message || 'Could not start the sign-in.'),
        { duration: 14000 },
      );
    } finally {
      setFixing('');
      await refreshOAuth();
    }
  }, [refreshOAuth]);

  const choicesFor = useCallback((featureId) => {
    if (!matrix) return [];
    const local = localModels.map((model) => ({
      id: model.id,
      label: model.name || model.id,
      provider: model.provider || 'sdcpp',
      providerLabel: 'On this machine',
      family: model.family || '',
      accepts: model.accepts,
      available: isLocalAIAvailable(),
      source: 'local',
    }));
    const cloud = serverRows(matrix, featureId).map((row) => ({
      ...row, id: row.model, label: row.model_label, providerLabel: row.provider_label, source: 'cloud',
    }));
    // `available` from the matrix means the PROVIDER answered its probe. A row
    // also has to be one this studio can actually route, or the picker offers a
    // model whose Draw button can only fail — which is how an OAuth pick ended
    // up asking for a MUAPI key.
    return rankModels(matrix, featureId, [...local, ...cloud]).map((row) => {
      const route = transportFor(row);
      return {
        ...row,
        available: row.available !== false && route.runnable,
        unavailableReason: route.runnable ? '' : route.reason,
        transport: route.transport,
      };
    });
  }, [matrix, localModels]);

  const sheetChoices = useMemo(() => choicesFor('story_character_sheet'), [choicesFor]);
  const plateChoices = useMemo(() => choicesFor('story_location'), [choicesFor]);
  const boardChoices = useMemo(() => choicesFor('story_board'), [choicesFor]);

  useEffect(() => { if (!sheetModel && sheetChoices.length) setSheetModel(defaultPick(sheetChoices)); }, [sheetChoices, sheetModel]);
  useEffect(() => { if (!plateModel && plateChoices.length) setPlateModel(defaultPick(plateChoices)); }, [plateChoices, plateModel]);
  useEffect(() => { if (!boardModel && boardChoices.length) setBoardModel(defaultPick(boardChoices)); }, [boardChoices, boardModel]);

  /**
   * Draw one image and hand back a persistent reference URL.
   *
   * Promoted rather than kept as an output: a sheet that is not a reference is
   * a picture of a character, and the whole point of the stage is that later
   * generations can be conditioned on it. Promotion also puts it in the Video
   * studio's reference grid, which is where the motion stage expects to find it.
   */
  const draw = useCallback(async ({ key, label, model, prompt, aspect, name }) => {
    if (!prompt) { toast.error('There is nothing to draw yet.'); return ''; }
    if (!model) { toast.error('Pick a model to draw it with.'); return ''; }
    // Only the MUAPI key lives in this browser. Every other credential is
    // checked where it actually is, so asking for a MUAPI key because a model
    // is "not local" is how an OpenAI OAuth pick used to open the wrong dialog.
    if (needsBrowserKey(model)) {
      setAuthOpen(true);
      return '';
    }
    setDrawing(key);
    try {
      const result = await runImage({ row: model, shared: { prompt, aspect_ratio: aspect, seed: -1 } });
      const reference = await promoteOutputToReference(result.url, { kind: 'image', name }).catch(() => '');
      const url = reference || result.url;
      const drawn = result.url;
      // And check what actually came back. A provider that ignores the ratio
      // squashes every panel on a grid sheet by the same factor, and from here
      // that is indistinguishable from one that obeyed — so it is measured,
      // named, and said out loud rather than shown as if it were what we asked
      // for.
      void measureCanvas(drawn).then((size) => {
        const off = size && canvasMismatch(aspect, size.width, size.height);
        if (off) {
          toast(
            `The ${label} came back ${off.got} — ${model?.name || model?.id || 'that model'} ignored the ${aspect} canvas that was asked for, so the panels are squashed. Draw it with a different model, or set the clip aspect to match.`,
            { icon: '📐', duration: 14000 },
          );
        }
      });
      return url;
    } catch (error) {
      console.warn(`[StoryStudio] ${label} generation failed:`, error?.message || error);
      // A failure that names its own fix is offered as the fix. The provider's
      // sentence still shows underneath, but it is not the whole answer.
      const remedy = readinessFromError({
        message: error?.message, remedy: error?.remedy, provider: error?.oauthProvider,
      });
      if (remedy.action) {
        void refreshOAuth();
        toast.error(
          (t) => reconnectToast(t, remedy, () => { toast.dismiss(t.id); void fixReadiness(remedy.action); }),
          { duration: 12000 },
        );
      } else {
        toast.error(error?.message || `Could not draw the ${label}.`);
      }
      return '';
    } finally {
      setDrawing('');
    }
  }, [refreshOAuth, fixReadiness]);

  /* ---------------- stage 1: concept ---------------- */

  const brief = story.brief;
  const setBrief = (patch) => update((current) => ({ ...current, brief: { ...current.brief, ...patch } }));

  const askConcepts = async () => {
    const result = await ask('concepts', conceptBrief(brief));
    if (!result) return;
    const concepts = normalizeConcepts(result, { count: brief.count });
    if (!concepts.length) { toast.error('No usable concepts came back — try again, or a larger model.'); return; }
    update({ concepts, shortlist: [], ranking: null, lockedId: '', contactSheetUrl: '' });
  };

  const toggleShortlist = (id) => update((current) => {
    const has = current.shortlist.includes(id);
    return { ...current, shortlist: has ? current.shortlist.filter((entry) => entry !== id) : [...current.shortlist, id] };
  });

  const askShortlist = async () => {
    const result = await ask('shortlist', 'Compare these and recommend the strongest.', { concepts: story.concepts });
    if (!result) return;
    update({
      ranking: result,
      shortlist: Array.isArray(result.recommend) ? result.recommend.map(String) : story.shortlist,
    });
  };

  const drawContactSheet = async () => {
    const chosen = story.concepts.filter((concept) => story.shortlist.includes(concept.id));
    const url = await draw({
      key: 'contact',
      label: 'contact sheet',
      model: sheetModel,
      prompt: contactSheetPrompt(chosen.length ? chosen : story.concepts, { style: story.style, world: brief.world }),
      // The canvas the prompt's own grid was laid out for — the sheet says how
      // many cells across it is, so it cannot also be asked for a canvas of a
      // different shape.
      aspect: contactSheetLayout((chosen.length ? chosen : story.concepts).length).canvas,
      name: 'story-contact-sheet.png',
    });
    if (url) update({ contactSheetUrl: url });
  };

  const lockConcept = async (concept) => {
    update({ lockedId: concept.id });
    const result = await ask('contract', 'Write the contract and the identity locks for this concept.', {
      concept, world: brief.world, tone: brief.tone, avoid: brief.avoid,
    });
    if (!result) return;
    const characters = (Array.isArray(result.characters) ? result.characters : []).map((row) => ({
      ...blankCharacter(),
      ...row,
      sheetUrl: '',
      audit: {},
    }));
    update({
      title: result.title || story.title,
      promise: result.promise || story.promise,
      contract: { ...story.contract, ...(result.contract || {}) },
      characters: characters.length ? characters : story.characters,
    });
    toast.success('Contract locked. Every later stage quotes it.');
  };

  const contractGaps = contractBlanks(story.contract);
  const conceptDone = contractGaps.length === 0 && story.characters.length > 0;

  /* ---------------- stage 2: characters ---------------- */

  const patchCharacter = (index, patch) => update((current) => ({
    ...current,
    characters: current.characters.map((row, i) => (i === index ? { ...row, ...patch } : row)),
  }));

  const drawSheet = async (index) => {
    const character = story.characters[index];
    const url = await draw({
      // Keyed per character: two cards both testing `drawing === 'character
      // sheet'` spun each other's button.
      key: `sheet:${index}`,
      label: 'character sheet',
      model: sheetModel,
      prompt: characterSheetPrompt(character, { style: story.style, background: story.sheetBackground }),
      aspect: '16:9',
      name: `sheet-${(character.name || 'character').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`,
    });
    if (url) patchCharacter(index, { sheetUrl: url, audit: {} });
  };

  const charactersDone = story.characters.length > 0 && story.characters.every((row) => row.sheetUrl);

  /* ---------------- stage 3: location ---------------- */

  const setLocation = (patch) => update((current) => ({ ...current, location: { ...current.location, ...patch } }));

  const askLocations = async () => {
    const result = await ask('location', 'Offer location directions for this contract.', {
      contract: story.contract, promise: story.promise, world: brief.world,
      characters: story.characters.map((row) => ({ name: row.name, never: neverChangeLine(row) })),
    });
    if (!result) return;
    update({ locationOptions: Array.isArray(result.directions) ? result.directions : [] });
  };

  const chooseLocation = (option) => setLocation({ ...option, motion: Array.isArray(option.motion) ? option.motion : [] });

  const drawPlate = async () => {
    const url = await draw({
      key: 'plate',
      label: 'location plate',
      model: plateModel,
      prompt: locationPrompt(story.location, { style: story.style, aspect: story.aspect }),
      aspect: story.aspect,
      name: `plate-${(story.location.place || 'location').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}.png`,
    });
    if (url) setLocation({ plateUrl: url });
  };

  const gaps = locationGaps(story.location);
  const locationDone = Boolean(story.location.plateUrl);

  /* ---------------- stage 4: board ---------------- */

  const setBoard = (patch) => update((current) => ({ ...current, board: { ...current.board, ...patch } }));

  const recommendation = useMemo(() => recommendBoard({
    beats: story.motion.beats.filter((beat) => beat.action).length,
    seconds: story.motion.seconds,
  }), [story.motion.beats, story.motion.seconds]);

  const changeFormat = (format) => setBoard({ format, panels: defaultPanels(format) });

  const askBoard = async () => {
    const format = boardFormat(story.board.format);
    const result = await ask('board', `Build a ${format.label} board (${format.panels} panels).`, {
      title: story.title, promise: story.promise, contract: story.contract,
      characters: story.characters.map((row) => ({ name: row.name, never: neverChangeLine(row) })),
      location: story.location.place, seconds: story.motion.seconds, panels: format.panels,
    });
    if (!result) return;
    const scaffold = defaultPanels(story.board.format);
    const panels = (Array.isArray(result.panels) ? result.panels : []).map((row, index) => ({
      ...(scaffold[index] || blankPanel(index, story.board.format)),
      ...row,
      n: index + 1,
    }));
    setBoard({
      arc: result.arc || story.board.arc,
      panels: panels.length ? panels : story.board.panels,
    });
    if (result.title && !story.title) update({ title: result.title });
  };

  const patchPanel = (index, patch) => setBoard({
    panels: story.board.panels.map((row, i) => (i === index ? { ...row, ...patch } : row)),
  });

  const boardText = useMemo(() => boardPrompt({
    format: story.board.format,
    panels: story.board.panels,
    title: story.title,
    promise: story.promise,
    arc: story.board.arc,
    style: story.style,
    aspect: story.aspect,
    locks: story.characters.map(neverChangeLine).filter(Boolean),
    location: story.location.place,
  }), [story]);

  const drawBoard = async () => {
    const url = await draw({
      key: 'board',
      label: 'storyboard',
      model: boardModel,
      prompt: boardText,
      // The canvas the panels are laid out on, from the same function the prompt
      // used. These were two independent guesses until 2026-08-24: the prompt
      // asked for 9:16 panels and the request asked for a 16:9 canvas, whose
      // 2x2 cells are 16:9 — so every panel came back stretched sideways.
      aspect: boardLayout(story.board.format, story.aspect).canvas,
      name: `board-${story.board.format}.png`,
    });
    if (url) setBoard({ sheetUrl: url });
  };

  const boardNotes = boardWarnings(story.board.panels, story.board.format);
  const boardDone = Boolean(story.board.sheetUrl);

  /* ---------------- stage 5: motion ---------------- */

  const setMotion = (patch) => update((current) => ({ ...current, motion: { ...current.motion, ...patch } }));
  const setLayer = (id, value) => setMotion({ layers: { ...story.motion.layers, [id]: value } });
  const patchBeat = (index, patch) => setMotion({
    beats: story.motion.beats.map((row, i) => (i === index ? { ...row, ...patch } : row)),
  });

  const askBeats = async () => {
    const result = await ask('beats', `Write the motion direction for a ${story.motion.seconds}-second generation.`, {
      contract: story.contract, promise: story.promise,
      characters: story.characters.map((row) => ({ name: row.name, never: neverChangeLine(row) })),
      location: { place: story.location.place, motion: story.location.motion, lights: story.location.lights },
      board: story.board.panels.map((row) => ({ job: row.job, verb: row.verb, shot: row.shot, reason: row.reason })),
      seconds: story.motion.seconds,
    });
    if (!result) return;
    const beats = (Array.isArray(result.beats) ? result.beats : []).map((row) => ({
      from: Number(row.from) || 0, to: Number(row.to) || 0,
      action: String(row.action || ''), emotion: String(row.emotion || ''),
    }));
    setMotion({
      force: result.force || story.motion.force,
      layers: { ...story.motion.layers, ...(result.layers || {}) },
      beats: beats.length ? beats : story.motion.beats,
      camera: result.camera || story.motion.camera,
      audio: result.audio || story.motion.audio,
      negatives: result.negatives || story.motion.negatives,
      override: '',
    });
  };

  const builtScript = useMemo(() => motionScript(story.motion), [story.motion]);
  const script = story.motion.override || builtScript;
  const notes = useMemo(() => scriptWarnings(story.motion), [story.motion]);
  const budget = useMemo(() => budgetReport(script, { limit: story.motion.limit }), [script, story.motion.limit]);

  const compress = async () => {
    const limit = Number(story.motion.limit) || 0;
    if (!limit) { toast.error('Set a character limit first.'); return; }
    const result = await ask('compress', `Compress to ${limit} characters or fewer.\n\n${script}`, { limit });
    if (!result?.script) return;
    setMotion({ override: result.script });
    toast.success(`Compressed to ${String(result.script).length} characters.`);
  };

  /**
   * Hand the whole production over, not just the paragraph.
   *
   * This used to post the script alone and then tell you to go and arm your own
   * references — which meant the Video studio opened with prose describing
   * pictures that were not attached, and, because the composer picks its
   * grammar from what IS attached, could only render that prose as prose. The
   * sheets are subjects, the plate and the board are scene references, and the
   * beats, soundscape and length travel as structure, so H3's six-section
   * reference format is what the composer lands on by itself.
   */
  const sendToVideo = () => {
    if (!script) { toast.error('There is no script to send yet.'); return; }
    const handoff = storyHandoff(story, { script });
    loadStudioSetup('video', handoff);
    window.dispatchEvent(new CustomEvent('navigate', { detail: { page: 'video' } }));
    const { subjects, scenes, pictures } = handoff.counts;
    const parts = [];
    if (subjects) parts.push(`${subjects} character sheet${subjects === 1 ? '' : 's'}`);
    if (scenes) parts.push(`${scenes === 1 ? 'the location plate' : 'the plate and the board'}`);
    toast.success(
      pictures
        ? `Sent to the Video studio — ${story.motion.seconds}s, with ${parts.join(' and ')} attached as references.`
        : `Sent to the Video studio (${story.motion.seconds}s). Nothing was drawn yet, so no references went with it.`,
      { duration: 8000 },
    );
  };

  const motionDone = Boolean(script) && notes.length === 0;

  /* ---------------- stage 6: gate ---------------- */

  const setVerdict = (id, value) => update((current) => ({
    ...current,
    qa: { ...current.qa, verdicts: { ...current.qa.verdicts, [id]: current.qa.verdicts[id] === value ? '' : value } },
  }));
  const setCaption = (id, value) => update((current) => ({
    ...current, qa: { ...current.qa, caption: { ...current.qa.caption, [id]: value } },
  }));

  const verdict = useMemo(() => shipVerdict(story.qa.verdicts), [story.qa.verdicts]);
  const caption = useMemo(() => buildCaption(story.qa.caption), [story.qa.caption]);
  const segments = useMemo(
    () => segmentPlan({ totalSeconds: story.segments.total, perGeneration: story.segments.per }),
    [story.segments],
  );

  /* ---------------- prompt bridge ---------------- */

  // The explore dock and the hub insert into whichever studio is visible. Here
  // there is no single prompt box, so the insert lands where text is most
  // likely wanted: the motion script once one exists, the world of the brief
  // before that.
  useEffect(() => {
    if (!active) return undefined;
    return registerPromptInserter((text) => {
      const current = storyRef.current;
      if (current.motion.override || current.motion.beats.some((beat) => beat.action)) {
        const base = current.motion.override || motionScript(current.motion);
        setMotion({ override: `${base}${base.endsWith('\n') ? '' : '\n'}${text}` });
      } else {
        setBrief({ world: `${current.brief.world}${current.brief.world ? '\n' : ''}${text}` });
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // Anything that means a production is already under way. Loading the example
  // replaces all of it, so it asks first — the sheets and plates survive in the
  // reference library, but the writing around them does not.
  const hasWork = Boolean(
    story.concepts.length || story.characters.length
    || story.location.place || story.motion.beats.some((beat) => beat.action),
  );

  const loadExample = () => {
    if (hasWork && !window.confirm('Replace this production with the worked example? Your sheets and plates stay in your references.')) return;
    update({
      ...blankStory(),
      ...STORY_EXAMPLE,
      // The example ships no images: the URLs would point at references this
      // browser has never uploaded, and a broken preview reads as a failed draw.
      board: { ...STORY_EXAMPLE.board, sheetUrl: '' },
      characters: STORY_EXAMPLE.characters.map((row) => ({ ...blankCharacter(), ...row, sheetUrl: '', audit: {} })),
    });
    toast('Loaded a worked example — every field filled with the kind of thing that belongs in it.', { icon: '🚌' });
  };

  const startOver = () => {
    if (!window.confirm('Clear this production? The sheets and plates stay in your references.')) return;
    update(blankStory());
  };

  /* ---------------- panel ---------------- */

  const panel = (
    <>
      <div>
        <SectionLabel>Production</SectionLabel>
        <FillField spec={specs.get('style')} id="style" busy={busy} onFill={fillOne}>
          <TextArea
            rows={2}
            value={story.style}
            onChange={(event) => update({ style: event.target.value })}
            placeholder="muted painterly animation, soft grain, restrained palette"
          />
        </FillField>
        <Field label="Aspect ratio" hint="The plate and the panels. Short-form is vertical; a 16:9 plate reframed to 9:16 loses the foreground the motion lives in.">
          <NativeSelect value={story.aspect} onChange={(event) => update({ aspect: event.target.value })}>
            {LOCATION_ASPECTS.map((ratio) => <option key={ratio} value={ratio}>{ratio}</option>)}
          </NativeSelect>
        </Field>
        <Field label="Sheet background" hint="Plain and flat. A busy background makes the sheet useless as a reference.">
          <NativeSelect value={story.sheetBackground} onChange={(event) => update({ sheetBackground: event.target.value })}>
            {SHEET_BACKGROUNDS.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
          </NativeSelect>
        </Field>
      </div>

      <div>
        <SectionLabel>Clip</SectionLabel>
        <Field label="Length" hint="One generation. Longer stories are split below rather than asked for in one go.">
          <Slider value={story.motion.seconds} min={5} max={30} step={1} onChange={(value) => setMotion({ seconds: value })} format={(value) => `${value}s`} />
        </Field>
        <Field label="Character limit" hint="Some generators cap the prompt. 0 means no cap, and the compressor stays out of the way.">
          <Slider value={story.motion.limit} min={0} max={2000} step={50} onChange={(value) => setMotion({ limit: value })} format={(value) => (value ? `${value}` : 'none')} />
        </Field>
      </div>

      <div className="flex flex-col gap-2">
        <Button icon="sparkles" size="sm" onClick={loadExample}>Load example</Button>
        <Button icon="trash" size="sm" onClick={startOver}>Start over</Button>
      </div>
      {matrixError ? <p className="text-[11px] leading-snug text-warn">{matrixError}</p> : null}
    </>
  );

  return (
    <StudioLayout panel={panel} panelTitle="Story settings">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-4">
        {!isHivemindStudioEnabled() ? (
          <Card className="border-warn/40 p-3 text-[13px] text-ink2">
            The producer runs on this machine’s models and on HivemindOS. Open the studio from the
            Hivemind Content Studio shell so it can reach them.
          </Card>
        ) : null}

        {/* ── Producer ─────────────────────────────────────────────── */}
        <Card className="flex flex-col gap-2 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Icon name="persona" size={15} className="text-ink3" />
            <span className="text-[12px] font-semibold text-ink2">Producer</span>
            <span className="text-[12px] text-ink3">{summaryLine(producer)}</span>
            {busy ? <Pill tone="honey" dot>{thinking || 'Working…'}</Pill> : null}
            <div className="ml-auto flex items-center gap-2">
              {busy ? <Button size="sm" onClick={cancelProducer}>Cancel</Button> : null}
              <Button size="sm" icon="sliders" onClick={() => setProducerOpen((open) => !open)}>
                {producerOpen ? 'Done' : 'Change'}
              </Button>
            </div>
          </div>
          {/* The privacy sentence follows the CHOSEN model. One sentence for both
              engines would be false for one of them. */}
          <p className="text-[11px] leading-snug text-ink3">
            It drafts options; you pick. {privacyLine(producer)}
          </p>
          {producerOpen ? (
            <ModelSourcePicker
              catalog={runtime}
              selectedId={producerId}
              tab={producerTabOpen}
              onTab={setProducerTab}
              query={producerQuery}
              onQuery={setProducerQuery}
              onPick={(id) => { setProducerId(id); rememberModelId(id); }}
              onRemedy={runRemedy}
              account={producerAccount}
              onAccount={setProducerAccount}
              keyField={keyField}
              onKeySave={saveKey}
              onKeyCancel={() => setKeyField('')}
              savingKey={savingKey}
              onConnect={connectAccount}
              connecting={connecting}
              onLink={linkThroughApp}
              linking={linking}
            />
          ) : null}
        </Card>

        {/* ── 1. Concept ───────────────────────────────────────────── */}
        <Card className="flex flex-col gap-3 p-4">
          <StageHeader index={0} stage={STAGES[0]} done={conceptDone} busy={busy} blanks={blanks.concept} fields={stageFields.concept} onFillSection={fillSection}>
            {story.concepts.length ? <Pill tone="neutral">{story.concepts.length} drafted</Pill> : null}
          </StageHeader>
          <p className="text-[12px] leading-snug text-ink3">
            The expensive mistake is a good render of the wrong pair. Compare eight, keep two or
            three, lock one — then everything downstream is built on a decision you actually made.
          </p>

          <div className="grid gap-2 sm:grid-cols-2">
            <FillField spec={specs.get('brief.person')} id="brief.person" busy={busy} onFill={fillOne}>
              <TextInput value={brief.person} onChange={(event) => setBrief({ person: event.target.value })} placeholder="a night-shift florist" />
            </FillField>
            <FillField spec={specs.get('brief.companion')} id="brief.companion" busy={busy} onFill={fillOne}>
              <TextInput value={brief.companion} onChange={(event) => setBrief({ companion: event.target.value })} placeholder="a stubborn pigeon" />
            </FillField>
          </div>
          <Field label="The relationship should feel">
            <Segmented value={brief.tone} onChange={(value) => setBrief({ tone: value })} options={TONES.map((entry) => ({ value: entry.id, label: entry.label }))} />
          </Field>
          <div className="grid gap-2 sm:grid-cols-2">
            <FillField spec={specs.get('brief.world')} id="brief.world" busy={busy} onFill={fillOne}>
              <TextInput value={brief.world} onChange={(event) => setBrief({ world: event.target.value })} placeholder="a harbour tram shelter in the rain" />
            </FillField>
            <FillField spec={specs.get('brief.avoid')} id="brief.avoid" busy={busy} onFill={fillOne}>
              <TextInput value={brief.avoid} onChange={(event) => setBrief({ avoid: event.target.value })} placeholder="no dialogue, no on-screen text" />
            </FillField>
          </div>
          <Field label="How many concepts" hint="Fewer than five is not a comparison.">
            <Slider value={brief.count} min={3} max={12} step={1} onChange={(value) => setBrief({ count: conceptCount(value) })} />
          </Field>

          <div className="flex flex-wrap items-center gap-2">
            <Button icon="wand" onClick={askConcepts} loading={busy === 'concepts'} disabled={Boolean(busy)}>
              Ask for {conceptCount(brief.count)} concepts
            </Button>
            <ProducerStatus task="concepts" busy={busy} status={thinking} onCancel={cancelProducer} />
            {story.concepts.length ? (
              <Button size="sm" icon="stack" onClick={askShortlist} loading={busy === 'shortlist'} disabled={Boolean(busy)}>Compare them</Button>
            ) : null}
            <ProducerStatus task="shortlist" busy={busy} status={thinking} onCancel={cancelProducer} />
            {story.shortlist.length ? (
              <Button size="sm" icon="grid" onClick={drawContactSheet} loading={drawing === 'contact'} disabled={Boolean(drawing)}>
                {drawing === 'contact' ? 'Drawing…' : 'Draw a contact sheet'}
              </Button>
            ) : null}
          </div>

          {story.ranking?.reason ? (
            <p className="rounded-md border border-line1 bg-bg2 p-2 text-[12px] leading-snug text-ink2">{story.ranking.reason}</p>
          ) : null}

          {story.concepts.length ? (
            <div className="grid gap-2 sm:grid-cols-2">
              {story.concepts.map((concept) => {
                const ranked = story.ranking?.ranked?.find((row) => String(row.id) === concept.id);
                const shortlisted = story.shortlist.includes(concept.id);
                const locked = story.lockedId === concept.id;
                return (
                  <div
                    key={concept.id}
                    className={cx(
                      'flex flex-col gap-1.5 rounded-md border p-2.5 text-[12px] transition-colors',
                      locked ? 'border-ok/60 bg-ok-tint' : shortlisted ? 'border-honey/60 bg-honey-tint' : 'border-line1 bg-bg2',
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-bold text-ink3">{concept.id}</span>
                      <span className="truncate font-semibold text-ink1">{concept.title || concept.pair}</span>
                      {ranked ? (
                        <Pill tone="neutral" className="ml-auto">
                          {Object.values(ranked.scores || {}).reduce((sum, value) => sum + (Number(value) || 0), 0) || '—'}
                        </Pill>
                      ) : null}
                    </div>
                    {concept.title ? <p className="text-ink2">{concept.pair}</p> : null}
                    <p className="text-ink3"><b className="text-ink2">Hook</b> — {concept.hook}</p>
                    <p className="text-ink3"><b className="text-ink2">Friction</b> — {concept.friction}</p>
                    <p className="text-ink3"><b className="text-ink2">Reward</b> — {concept.reward}</p>
                    <p className="text-ink3"><b className="text-ink2">Signature</b> — {concept.signature}</p>
                    {ranked?.why ? <p className="italic text-ink3">{ranked.why}</p> : null}
                    <div className="mt-auto flex items-center gap-2 pt-1">
                      <Button size="sm" onClick={() => toggleShortlist(concept.id)}>
                        {shortlisted ? 'Drop from shortlist' : 'Shortlist'}
                      </Button>
                      <Button
                        size="sm"
                        icon="check"
                        onClick={() => lockConcept(concept)}
                        loading={busy === 'contract' && story.lockedId === concept.id}
                        disabled={Boolean(busy)}
                      >
                        {locked ? 'Locked' : 'Lock this one'}
                      </Button>
                      <ProducerStatus task={story.lockedId === concept.id ? 'contract' : ''} busy={busy} status={thinking} onCancel={cancelProducer} />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <EmptyState
              icon="sparkles"
              title={busy === 'concepts' ? (thinking || 'Working…') : 'No concepts yet'}
              hint={busy === 'concepts'
                ? 'The producer is a local model on this machine. A cold one takes a minute to load before it writes anything.'
                : SHORTLIST_CRITERIA.map((entry) => entry.label).join(' · ')}
            />
          )}

          {story.contactSheetUrl ? <Plate url={story.contactSheetUrl} alt="Contact sheet of the shortlisted directions" /> : null}

          <div className="rounded-md border border-line1 bg-bg2 p-2.5">
            <SectionLabel>The contract</SectionLabel>
            <p className="mb-2 text-[12px] leading-snug text-ink2">{contractSentence(story.contract)}</p>
            <div className="grid gap-2 sm:grid-cols-3">
              {[
                ['pressure', 'When this happens'], ['who', 'this character'], ['goal', 'tries to'],
                ['other', 'while this one'], ['behavior', 'responds by'], ['reward', 'turning it into'],
              ].map(([field, label]) => (
                <FillField key={field} spec={{ ...specs.get(`contract.${field}`), label }} id={`contract.${field}`} busy={busy} onFill={fillOne}>
                  <TextInput
                    value={story.contract[field]}
                    onChange={(event) => update((current) => ({ ...current, contract: { ...current.contract, [field]: event.target.value } }))}
                  />
                </FillField>
              ))}
            </div>
            {contractGaps.length ? (
              <Notes items={[`Still blank: ${contractGaps.join(', ')}. A half-written contract reads as finished to every later stage.`]} />
            ) : null}
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <FillField spec={specs.get('title')} id="title" busy={busy} onFill={fillOne}>
                <TextInput value={story.title} onChange={(event) => update({ title: event.target.value })} />
              </FillField>
              <FillField spec={specs.get('promise')} id="promise" busy={busy} onFill={fillOne}>
                <TextInput value={story.promise} onChange={(event) => update({ promise: event.target.value })} />
              </FillField>
            </div>
          </div>
        </Card>

        {/* ── 2. Characters ────────────────────────────────────────── */}
        <Card className="flex flex-col gap-3 p-4">
          <StageHeader index={1} stage={STAGES[1]} done={charactersDone} busy={busy} blanks={blanks.characters} fields={stageFields.characters} onFillSection={fillSection}>
            <Button size="sm" icon="plus" onClick={() => update((current) => ({ ...current, characters: [...current.characters, blankCharacter()] }))}>
              Add character
            </Button>
          </StageHeader>
          <p className="text-[12px] leading-snug text-ink3">
            One sheet per recurring character: front, exact side, back, on one plain canvas.
            The locks below are ranked by how badly each one shows when it drifts. {SILHOUETTE_TEST}
          </p>

          <ModelFitPicker
            label="Sheet model"
            rows={sheetChoices}
            value={sheetModel}
            onChange={setSheetModel}
            readinessFor={rowReadiness}
            onFixReadiness={fixReadiness}
            busyAction={fixing}
          />

          {story.characters.length ? story.characters.map((character, index) => (
            <div key={character.id || index} className="flex flex-col gap-2 rounded-md border border-line1 bg-bg2 p-3">
              <div className="grid gap-2 sm:grid-cols-3">
                {['name', 'role', 'species'].map((key) => (
                  <FillField
                    key={key}
                    spec={specs.get(`characters[${index}].${key}`)}
                    id={`characters[${index}].${key}`}
                    busy={busy}
                    onFill={fillOne}
                  >
                    <TextInput value={character[key] || ''} onChange={(event) => patchCharacter(index, { [key]: event.target.value })} />
                  </FillField>
                ))}
              </div>
              {IDENTITY_LOCKS.map((lock) => (
                <FillField
                  key={lock.id}
                  spec={{ ...specs.get(`characters[${index}].${lock.id}`), label: lock.label, hint: lock.hint }}
                  id={`characters[${index}].${lock.id}`}
                  busy={busy}
                  onFill={fillOne}
                >
                  <TextArea rows={2} value={character[lock.id] || ''} onChange={(event) => patchCharacter(index, { [lock.id]: event.target.value })} />
                </FillField>
              ))}
              <FillField
                spec={{
                  ...specs.get(`characters[${index}].never`),
                  hint: 'Quoted verbatim by the board and by every repair. Leave it empty and the locks above are used instead.',
                }}
                id={`characters[${index}].never`}
                busy={busy}
                onFill={fillOne}
              >
                <TextArea rows={2} value={character.never} onChange={(event) => patchCharacter(index, { never: event.target.value })} placeholder={neverChangeLine(character)} />
              </FillField>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  icon="image"
                  onClick={() => drawSheet(index)}
                  loading={drawing === `sheet:${index}`}
                  disabled={Boolean(drawing)}
                >
                  {drawing === `sheet:${index}` ? 'Drawing…' : character.sheetUrl ? 'Redraw the sheet' : 'Draw the sheet'}
                </Button>
                <Button size="sm" icon="trash" onClick={() => update((current) => ({ ...current, characters: current.characters.filter((_, i) => i !== index) }))}>
                  Remove
                </Button>
              </div>
              {character.sheetUrl ? (
                <>
                  <Plate url={character.sheetUrl} alt={`${character.name} reference sheet`} />
                  <SectionLabel>Audit before this becomes a reference</SectionLabel>
                  <div className="grid gap-1 sm:grid-cols-2">
                    {SHEET_AUDIT.map((check) => (
                      <label key={check.id} className="flex items-start gap-2 text-[12px] leading-snug text-ink2">
                        <input
                          type="checkbox"
                          checked={Boolean(character.audit?.[check.id])}
                          onChange={(event) => patchCharacter(index, { audit: { ...character.audit, [check.id]: event.target.checked } })}
                          className="mt-0.5 accent-honey"
                        />
                        {check.label}
                      </label>
                    ))}
                  </div>
                  {SHEET_AUDIT.some((check) => !character.audit?.[check.id]) ? (
                    <Notes items={['Unticked items are not failures — they are unchecked. A drifting sheet costs every generation built on it.']} tone="ink" />
                  ) : <Pill tone="ok">Audited</Pill>}
                </>
              ) : null}
            </div>
          )) : (
            <EmptyState icon="persona" title="No characters yet" hint="Lock a concept above and the producer writes the identity locks, or add one by hand." />
          )}
        </Card>

        {/* ── 3. Location ──────────────────────────────────────────── */}
        <Card className="flex flex-col gap-3 p-4">
          <StageHeader index={2} stage={STAGES[2]} done={locationDone} busy={busy} blanks={blanks.location} fields={stageFields.location} onFillSection={fillSection} />
          <p className="text-[12px] leading-snug text-ink3">
            One empty plate, so no later prompt has to rebuild the place. Empty on purpose:
            a figure in the plate argues with the character sheets in every render.
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" icon="wand" onClick={askLocations} loading={busy === 'location'} disabled={Boolean(busy)}>Suggest directions</Button>
            <ProducerStatus task="location" busy={busy} status={thinking} onCancel={cancelProducer} />
            <ModelFitPicker
              label="Plate model"
              rows={plateChoices}
              value={plateModel}
              onChange={setPlateModel}
              readinessFor={rowReadiness}
              onFixReadiness={fixReadiness}
              busyAction={fixing}
            />
          </div>

          {story.locationOptions.length ? (
            <div className="grid gap-2 sm:grid-cols-2">
              {story.locationOptions.map((option, index) => (
                <button
                  key={`${option.place}-${index}`}
                  type="button"
                  onClick={() => chooseLocation(option)}
                  className={cx(
                    'flex flex-col gap-1 rounded-md border p-2.5 text-left text-[12px] transition-colors',
                    story.location.place === option.place ? 'border-honey/60 bg-honey-tint' : 'border-line1 bg-bg2 hover:border-line2',
                  )}
                >
                  <span className="font-semibold text-ink1">{option.place}</span>
                  <span className="text-ink3">{[option.time, option.weather, option.palette].filter(Boolean).join(' · ')}</span>
                  <span className="text-ink3">Moves: {(option.motion || []).join(', ')}</span>
                </button>
              ))}
            </div>
          ) : null}

          <div className="grid gap-2 sm:grid-cols-2">
            {['place', 'time', 'weather', 'palette', 'accent', 'lights'].map((key) => (
              <FillField key={key} spec={specs.get(`location.${key}`)} id={`location.${key}`} busy={busy} onFill={fillOne}>
                <TextInput value={story.location[key]} onChange={(event) => setLocation({ [key]: event.target.value })} />
              </FillField>
            ))}
          </div>
          <FillField spec={specs.get('location.depth')} id="location.depth" busy={busy} onFill={fillOne}>
            <TextArea rows={2} value={story.location.depth} onChange={(event) => setLocation({ depth: event.target.value })} />
          </FillField>

          <Field label="What can move" hint="Decided here, while looking at the place — the motion stage draws from this list.">
            <div className="flex flex-col gap-1.5">
              {MOTION_SOURCES.map((source) => (
                <div key={source.id} className="flex flex-wrap items-center gap-1.5">
                  <span className="w-28 shrink-0 text-[11px] font-semibold text-ink2">{source.label}</span>
                  {source.examples.map((example) => {
                    const on = story.location.motion.includes(example);
                    return (
                      <button
                        key={example}
                        type="button"
                        onClick={() => setLocation({
                          motion: on
                            ? story.location.motion.filter((entry) => entry !== example)
                            : [...story.location.motion, example],
                        })}
                        className={cx(
                          'rounded-full border px-2 py-0.5 text-[11px] transition-colors',
                          on ? 'border-honey/60 bg-honey-tint text-ink1' : 'border-line1 bg-bg2 text-ink3 hover:border-line2',
                        )}
                      >
                        {example}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </Field>
          <FillField spec={specs.get('location.forbid')} id="location.forbid" busy={busy} onFill={fillOne}>
            <TextInput value={story.location.forbid} onChange={(event) => setLocation({ forbid: event.target.value })} placeholder="no people, no signage text" />
          </FillField>

          <Notes items={gaps} />

          <div className="flex flex-wrap items-center gap-2">
            <Button icon="image" onClick={drawPlate} loading={drawing === 'plate'} disabled={Boolean(drawing) || !story.location.place}>
              {drawing === 'plate' ? 'Drawing…' : story.location.plateUrl ? 'Redraw the plate' : 'Draw the plate'}
            </Button>
          </div>
          {story.location.plateUrl ? <Plate url={story.location.plateUrl} alt="Empty location plate" /> : null}
        </Card>

        {/* ── 4. Storyboard ────────────────────────────────────────── */}
        <Card className="flex flex-col gap-3 p-4">
          <StageHeader index={3} stage={STAGES[3]} done={boardDone} busy={busy} blanks={blanks.board} fields={stageFields.board} onFillSection={fillSection} />
          <p className="text-[12px] leading-snug text-ink3">
            A board is direction, not a contract. Expect the video model to interpret it —
            when a beat has to be exact, drop to two frames and generate only that.
          </p>

          <Field label="Density">
            <Segmented
              value={story.board.format}
              onChange={changeFormat}
              options={BOARD_FORMATS.map((entry) => ({ value: entry.id, label: entry.label }))}
            />
          </Field>
          <p className="text-[12px] leading-snug text-ink3">{boardFormat(story.board.format).best}</p>
          {recommendation.id !== story.board.format ? (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-honey/40 bg-honey-tint p-2 text-[12px] text-ink2">
              <span>Suggested: <b>{boardFormat(recommendation.id).label}</b> — {recommendation.why}</span>
              <Button size="sm" className="ml-auto" onClick={() => changeFormat(recommendation.id)}>Use it</Button>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" icon="wand" onClick={askBoard} loading={busy === 'board'} disabled={Boolean(busy)}>Draft the panels</Button>
            <ProducerStatus task="board" busy={busy} status={thinking} onCancel={cancelProducer} />
            <FillField spec={specs.get('board.arc')} id="board.arc" busy={busy} onFill={fillOne} className="!mb-0 flex-1">
              <TextInput value={story.board.arc} onChange={(event) => setBoard({ arc: event.target.value })} placeholder="from what feeling to what feeling" />
            </FillField>
          </div>

          <div className="flex flex-col gap-2">
            {story.board.panels.map((panelRow, index) => (
              <div key={panelRow.n} className="grid gap-2 rounded-md border border-line1 bg-bg2 p-2.5 sm:grid-cols-[auto_1fr_1fr]">
                <div className="flex flex-col">
                  <span className="text-[11px] font-bold text-ink3">{panelRow.n}</span>
                  <span className="text-[11px] font-semibold text-ink2">{panelRow.job}</span>
                </div>
                <FillField
                  spec={{ ...specs.get(`board.panels[${index}].verb`), label: 'Dominant action', hint: index === 0 ? panelRow.asks : '' }}
                  id={`board.panels[${index}].verb`}
                  busy={busy}
                  onFill={fillOne}
                >
                  <TextArea rows={2} value={panelRow.verb} onChange={(event) => patchPanel(index, { verb: event.target.value })} />
                </FillField>
                <div className="flex flex-col gap-1.5">
                  <FillField
                    spec={{ ...specs.get(`board.panels[${index}].shot`), label: 'Shot' }}
                    id={`board.panels[${index}].shot`}
                    busy={busy}
                    onFill={fillOne}
                  >
                    <NativeSelect value={panelRow.shot} onChange={(event) => patchPanel(index, { shot: event.target.value })}>
                      <option value="">Pick one</option>
                      {SHOT_REASONS.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
                    </NativeSelect>
                  </FillField>
                  <FillField
                    spec={{ ...specs.get(`board.panels[${index}].reason`), label: 'Camera reason' }}
                    id={`board.panels[${index}].reason`}
                    busy={busy}
                    onFill={fillOne}
                  >
                    <TextInput value={panelRow.reason} onChange={(event) => patchPanel(index, { reason: event.target.value })} placeholder="the viewer now needs to discover…" />
                  </FillField>
                  <FillField
                    spec={{ ...specs.get(`board.panels[${index}].motion`), label: 'What moves' }}
                    id={`board.panels[${index}].motion`}
                    busy={busy}
                    onFill={fillOne}
                  >
                    <TextInput value={panelRow.motion} onChange={(event) => patchPanel(index, { motion: event.target.value })} placeholder="what moves in this panel" />
                  </FillField>
                </div>
              </div>
            ))}
          </div>

          <Notes items={boardNotes} />

          <details className="rounded-md border border-line1 bg-bg2">
            <summary className="cursor-pointer px-3 py-2 text-[12px] font-semibold text-ink2">The prompt this draws from</summary>
            <div className="p-2"><TextArea rows={12} value={boardText} readOnly className="font-mono text-[11px]" /></div>
          </details>

          <ModelFitPicker
            label="Board model"
            rows={boardChoices}
            value={boardModel}
            onChange={setBoardModel}
            readinessFor={rowReadiness}
            onFixReadiness={fixReadiness}
            busyAction={fixing}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button icon="grid" onClick={drawBoard} loading={drawing === 'board'} disabled={Boolean(drawing) || !boardText}>
              {drawing === 'board' ? 'Drawing…' : story.board.sheetUrl ? 'Redraw the board' : 'Draw the board'}
            </Button>
            <span className="text-[11px] text-ink3">
              The sheets and this board travel to the Video studio with the script — the sheets as subjects, the plate and the board as places.
            </span>
          </div>
          {story.board.sheetUrl ? <Plate url={story.board.sheetUrl} alt="Storyboard sheet" /> : null}
        </Card>

        {/* ── 5. Motion ────────────────────────────────────────────── */}
        <Card className="flex flex-col gap-3 p-4">
          <StageHeader index={4} stage={STAGES[4]} done={motionDone} busy={busy} blanks={blanks.motion} fields={stageFields.motion} onFillSection={fillSection}>
            <Pill tone={budget.fits ? 'neutral' : 'warn'}>{budget.chars} chars</Pill>
          </StageHeader>
          <p className="text-[12px] leading-snug text-ink3">
            The references say what exists. This says what happens — timed action, an emotional
            turn, a world that moves because of something, a camera with a reason, and sound
            from things you can see.
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" icon="wand" onClick={askBeats} loading={busy === 'beats'} disabled={Boolean(busy)}>Draft the motion</Button>
            <ProducerStatus task="beats" busy={busy} status={thinking} onCancel={cancelProducer} />
            <Button size="sm" onClick={() => setMotion({ beats: defaultBeats(story.motion.seconds, story.motion.beats.length || 3) })}>
              Re-time the beats to {story.motion.seconds}s
            </Button>
          </div>

          <FillField
            spec={{ ...specs.get('motion.force'), hint: 'One cause. Everything below is a response to it — that is the difference between a world and a wiggle.' }}
            id="motion.force"
            busy={busy}
            onFill={fillOne}
          >
            <TextInput value={story.motion.force} onChange={(event) => setMotion({ force: event.target.value })} placeholder="wind off the harbour, carrying rain" />
          </FillField>
          <div className="grid gap-2 sm:grid-cols-2">
            {MOTION_LAYERS.map((layer) => (
              <FillField
                key={layer.id}
                spec={{ ...specs.get(`motion.layers.${layer.id}`), label: layer.label, hint: layer.hint }}
                id={`motion.layers.${layer.id}`}
                busy={busy}
                onFill={fillOne}
              >
                {/* rows=2: a layer is a clause about what responds to the force,
                    not a noun. One row clipped them mid-word. */}
                <TextArea rows={2} value={story.motion.layers[layer.id] || ''} onChange={(event) => setLayer(layer.id, event.target.value)} />
              </FillField>
            ))}
          </div>

          <SectionLabel>Beats</SectionLabel>
          <div className="flex flex-col gap-2">
            {story.motion.beats.map((beat, index) => (
              <div key={index} className="grid gap-2 rounded-md border border-line1 bg-bg2 p-2.5 sm:grid-cols-[10rem_1fr_1fr]">
                <div className="flex items-center gap-1">
                  {/* !px-2: the shared input pads for a sentence, and two digits
                      plus the number spinner do not fit what is left of a 56px
                      box — 10 rendered as a clipped "1". */}
                  <TextInput type="number" value={beat.from} onChange={(event) => patchBeat(index, { from: Number(event.target.value) })} className="w-[4.25rem] !px-2" />
                  <span className="text-[11px] text-ink3">→</span>
                  <TextInput type="number" value={beat.to} onChange={(event) => patchBeat(index, { to: Number(event.target.value) })} className="w-[4.25rem] !px-2" />
                  <span className="text-[11px] text-ink3">s</span>
                </div>
                <FillField
                  spec={{ ...specs.get(`motion.beats[${index}].action`), label: 'One dominant action' }}
                  id={`motion.beats[${index}].action`}
                  busy={busy}
                  onFill={fillOne}
                >
                  <TextArea rows={2} value={beat.action} onChange={(event) => patchBeat(index, { action: event.target.value })} />
                </FillField>
                <FillField
                  spec={{ ...specs.get(`motion.beats[${index}].emotion`), label: 'What it changes' }}
                  id={`motion.beats[${index}].emotion`}
                  busy={busy}
                  onFill={fillOne}
                >
                  <TextArea rows={2} value={beat.emotion} onChange={(event) => patchBeat(index, { emotion: event.target.value })} />
                </FillField>
              </div>
            ))}
            <div className="flex items-center gap-2">
              <Button size="sm" icon="plus" onClick={() => setMotion({ beats: [...story.motion.beats, { from: story.motion.beats.at(-1)?.to || 0, to: story.motion.seconds, action: '', emotion: '' }] })}>
                Add a beat
              </Button>
              {story.motion.beats.length > 1 ? (
                <Button size="sm" icon="trash" onClick={() => setMotion({ beats: story.motion.beats.slice(0, -1) })}>Drop the last</Button>
              ) : null}
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <FillField
              spec={{ ...specs.get('motion.camera'), hint: 'Two to four motivated changes. Each one because the viewer now needs to discover something.' }}
              id="motion.camera"
              busy={busy}
              onFill={fillOne}
            >
              <TextArea rows={2} value={story.motion.camera} onChange={(event) => setMotion({ camera: event.target.value })} />
            </FillField>
            <FillField
              spec={{ ...specs.get('motion.audio'), hint: AUDIO_LAYERS.map((layer) => layer.label).join(' · ') }}
              id="motion.audio"
              busy={busy}
              onFill={fillOne}
            >
              <TextArea rows={2} value={story.motion.audio} onChange={(event) => setMotion({ audio: event.target.value })} />
            </FillField>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Music">
              <NativeSelect value={story.motion.music} onChange={(event) => setMotion({ music: event.target.value })}>
                {MUSIC_RULES.map((rule) => <option key={rule.id} value={rule.id}>{rule.label}</option>)}
              </NativeSelect>
            </Field>
            <FillField spec={specs.get('motion.negatives')} id="motion.negatives" busy={busy} onFill={fillOne}>
              <TextInput value={story.motion.negatives} onChange={(event) => setMotion({ negatives: event.target.value })} />
            </FillField>
          </div>

          <Notes items={notes} />

          <Field
            label="The script"
            hint={story.motion.override ? 'Edited by hand — the fields above no longer rewrite it.' : 'Rebuilt from the fields above as you type.'}
            labelRight={story.motion.override ? (
              <Button size="sm" onClick={() => setMotion({ override: '' })}>Back to the built one</Button>
            ) : null}
          >
            <TextArea
              rows={14}
              value={script}
              onChange={(event) => setMotion({ override: event.target.value })}
              className="font-mono text-[11px]"
            />
          </Field>

          <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink3">
            <span>{budget.chars} characters{budget.limit ? ` of ${budget.limit}` : ''}.</span>
            {budget.savings > 0 ? (
              <>
                <span className="text-warn">
                  {budget.savings} of them say nothing{budget.emptyPhrases.length ? ` (${budget.emptyPhrases.join(', ')})` : ''}.
                </span>
                <Button size="sm" onClick={() => setMotion({ override: tighten(script) })}>Cut them</Button>
              </>
            ) : null}
            {budget.over ? (
              <Button size="sm" icon="scissors" onClick={compress} loading={busy === 'compress'} disabled={Boolean(busy)}>
                Compress by {budget.over}
              </Button>
            ) : null}
          </div>

          <ProducerStatus task="compress" busy={busy} status={thinking} onCancel={cancelProducer} />

          <div className="flex flex-wrap items-center gap-2">
            <Button icon="film" onClick={sendToVideo} disabled={!script}>Open in the Video studio</Button>
            <Button size="sm" icon="copy" onClick={() => { navigator.clipboard?.writeText(script); toast.success('Script copied.'); }}>Copy</Button>
          </div>
        </Card>

        {/* ── 6. Gate ──────────────────────────────────────────────── */}
        <Card className="flex flex-col gap-3 p-4">
          <StageHeader index={5} stage={STAGES[5]} done={verdict.state === 'ship'} busy={busy} blanks={blanks.ship} fields={stageFields.ship} onFillSection={fillSection}>
            <Pill tone={verdict.state === 'ship' ? 'ok' : verdict.state === 'blocked' ? 'danger' : 'honey'}>
              {verdict.headline}
            </Pill>
          </StageHeader>
          <p className="text-[12px] leading-snug text-ink3">{verdict.detail}</p>

          <div className="flex flex-col gap-1.5">
            {QA_CHECKS.map((check) => {
              const state = story.qa.verdicts[check.id] || '';
              return (
                <div key={check.id} className="flex flex-col gap-1 rounded-md border border-line1 bg-bg2 p-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[12px] font-semibold text-ink1">{check.label}</span>
                    {check.blocks ? <Pill tone="neutral">blocks publishing</Pill> : null}
                    <div className="ml-auto flex items-center gap-1">
                      <Button size="sm" onClick={() => setVerdict(check.id, 'pass')} className={state === 'pass' ? '!border-ok/60 !bg-ok-tint' : ''}>Pass</Button>
                      <Button size="sm" onClick={() => setVerdict(check.id, 'fail')} className={state === 'fail' ? '!border-warn/60 !bg-warn/10' : ''}>Fail</Button>
                    </div>
                  </div>
                  <p className="text-[11px] leading-snug text-ink3">{check.asks}</p>
                  {state === 'fail' ? repairsFor(check.id).map((repair) => (
                    <div key={repair.id} className="rounded border border-warn/40 bg-warn/10 p-2 text-[11px] leading-snug text-ink2">
                      <b>{repair.label}</b> — {repair.cause}
                      <br />
                      Repair the <b>{repair.stage}</b> stage: {repair.fix}
                    </div>
                  )) : null}
                </div>
              );
            })}
          </div>

          <div className="rounded-md border border-line1 bg-bg2 p-2.5">
            <SectionLabel>Longer than one generation?</SectionLabel>
            <div className="mb-2 grid gap-2 sm:grid-cols-2">
              <Field label="Whole story"><Slider value={story.segments.total} min={5} max={120} step={5} onChange={(value) => update((current) => ({ ...current, segments: { ...current.segments, total: value } }))} format={(value) => `${value}s`} /></Field>
              <Field label="Per generation"><Slider value={story.segments.per} min={5} max={30} step={1} onChange={(value) => update((current) => ({ ...current, segments: { ...current.segments, per: value } }))} format={(value) => `${value}s`} /></Field>
            </div>
            <div className="flex flex-col gap-1.5">
              {segments.map((segment) => (
                <div key={segment.index} className="text-[12px] leading-snug text-ink2">
                  <b>Generation {segment.index}</b> · {segment.from}–{segment.to}s — one job: {segment.job}.
                  {segment.boundary ? <span className="text-ink3"> {segment.boundary}</span> : null}
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-md border border-line1 bg-bg2 p-2.5">
            <SectionLabel>Caption</SectionLabel>
            <div className="grid gap-2 sm:grid-cols-2">
              {CAPTION_BEATS.map((beat) => (
                <FillField
                  key={beat.id}
                  spec={{ ...specs.get(`qa.caption.${beat.id}`), label: beat.label, hint: beat.asks }}
                  id={`qa.caption.${beat.id}`}
                  busy={busy}
                  onFill={fillOne}
                >
                  <TextArea rows={2} value={story.qa.caption[beat.id] || ''} onChange={(event) => setCaption(beat.id, event.target.value)} />
                </FillField>
              ))}
            </div>
            {caption.caption ? (
              <p className="mt-2 rounded border border-line1 bg-bg1 p-2 text-[12px] leading-snug text-ink2">{caption.caption}</p>
            ) : null}
            <Notes items={caption.problems} />
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <div className="rounded-md border border-line1 bg-bg2 p-2.5">
              <SectionLabel>Finish, in this order</SectionLabel>
              <ol className="flex flex-col gap-0.5 text-[12px] text-ink2">
                {FINISH_ORDER.map((step, index) => <li key={step}>{index + 1}. {step}</li>)}
              </ol>
              <p className="mt-1 text-[11px] leading-snug text-ink3">
                An upscale sharpens pixels. It does not repair acting, an unclear action, a broken
                identity or a dead world.
              </p>
            </div>
            <div className="rounded-md border border-line1 bg-bg2 p-2.5">
              <SectionLabel>Then change one thing</SectionLabel>
              <p className="text-[11px] leading-snug text-ink3">{ITERATION_LAYERS.join(' · ')}</p>
              <div className="mt-1.5 flex flex-col gap-1 text-[11px] leading-snug text-ink3">
                {SIGNAL_READS.map((row) => (
                  <div key={row.id}><b className="text-ink2">{row.signal}</b> — {row.means} <i>{row.next}</i></div>
                ))}
              </div>
            </div>
          </div>
        </Card>
      </div>

      {authOpen ? <AuthModal onClose={() => setAuthOpen(false)} onSaved={() => setAuthOpen(false)} /> : null}
    </StudioLayout>
  );
}
