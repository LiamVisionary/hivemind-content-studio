// Story Studio — a character-led short, produced one decision at a time.
//
// Four decisions, one on screen at a time: the story, the cast and the place,
// what happens, and whether it ships. It used to be six cards down one page,
// which meant the only way to learn whether the plate had been drawn was to
// scroll past everything else to find out — and every one of the forty fields
// that exist for the times you disagree with the producer was in the way of the
// four presses that are the actual work.
//
// It is a separate studio rather than a mode of the Video studio because the
// expensive decisions all happen BEFORE a video model is asked for anything:
// which pair, what they are locked to, where it is, how many beats, and what
// actually moves. By the time a clip is generated, all of that should already
// be settled and visible.
//
// What lives where, and why:
//   story       the producer (a local LLM, or HivemindOS, or the owner's own
//               accounts) drafts options; the director locks one. Options
//               before decisions, every time. What survives is a CONTRACT that
//               every later stage quotes.
//   cast        sheets and an empty plate, drawn here and promoted straight to
//               persistent references — so they show up in the Video studio's
//               reference picker with no export. The plate is empty on purpose:
//               the sheets own the characters.
//   motion      built here, generated in the Video studio. That studio already
//               owns model choice, reference budget, lanes and resume; a second
//               video composer in here would be a second set of all of it. The
//               storyboard rides along as direction, not as a shot list.
//   ship        the checks in the order they are cheap to fix, and a repair per
//               failure that names ONE layer to change.
//
// Method credit: the production sequence follows The Viral Character Method
// (Yume no Sekai), bought and read by the owner. The decision system is
// implemented here in this studio's own words and data model; no text, template
// or example from that package is reproduced.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'react-hot-toast';

import { registerPromptInserter, loadStudioSetup } from '../app/promptTarget.js';
import { defaultPick, fetchCapabilityMatrix, rankModels, serverRows } from '../lib/capabilityMatrix.js';
import { getComposerSection, hydrateComposerState, updateComposerSection } from '../lib/composerState.js';
import { primeResolvedMedia } from '../lib/e2eMedia.js';
import { isHivemindStudioEnabled, mediaSourceToDataUrl } from '../lib/hivemindStudio.js';
import { isLocalAIAvailable } from '../lib/localInferenceClient.js';
import { useLocalImageCatalog } from '../lib/useLocalCatalog.js';
import { LocalCatalogNotice } from './LocalCatalogNotice.jsx';
import { askProducer } from '../lib/localProducer.js';
import { needsBrowserKey, runImage, transportFor } from '../lib/modelRunner.js';
import {
  fetchOAuthStatus, readinessFor, readinessFromError, refreshMuapiKeyLocation, startOAuthLogin,
} from '../lib/providerReadiness.js';
import { promoteOutputToReference } from '../lib/outputToReference.js';
import { canvasMismatch } from './story/sheetLayout.js';
import { lastUsedModelId, rememberModelId, sortModels } from '../lib/promptHelperRuntime.js';
import { DRAFT_USAGE, LOCAL, remedyFor, rowFor, sourceState, startingModelId } from '../lib/textModels.js';
import { useModelSources } from '../lib/useModelSources.js';
import { Button, StudioLayout } from '../ui/kit.jsx';
import { AuthModal } from '../dialogs/AuthModal.jsx';
import { ConfirmModal } from '../ui/Modal.jsx';

import {
  conceptBrief, contactSheetLayout, contactSheetPrompt, contractBlanks, normalizeConcepts,
} from './story/concept.js';
import { blankCharacter, characterSheetPrompt, neverChangeLine } from './story/characterSheet.js';
import { locationPrompt } from './story/location.js';
import {
  blankPanel, boardFormat, boardLayout, boardPrompt, boardWarnings, defaultPanels,
} from './story/board.js';
import {
  budgetReport, defaultBeats, motionScript, scriptWarnings, segmentPlan, tighten,
} from './story/motionScript.js';
import { QA_CHECKS, buildCaption, shipVerdict } from './story/qa.js';
import { STORY_EXAMPLE } from './story/example.js';
import { blankStory, restoreStory } from './story/state.js';
import { describeHandoff, storyHandoff } from './story/handoff.js';
import { selectSendTarget } from '../lib/studioTargets.js';
import { blankFieldsIn, fieldMap, fieldsFor, fillBrief, fillChunks, storyContext, writePath, acceptedValues } from './story/fields.js';

import { STORY_STAGES, StageRail } from './story/StageRail.jsx';
import { ProducerBar } from './story/ProducerBar.jsx';
import { StoryStage } from './story/StoryStage.jsx';
import { CastStage } from './story/CastStage.jsx';
import { MotionStage } from './story/MotionStage.jsx';
import { ShipStage } from './story/ShipStage.jsx';
import { PromptDock } from './story/PromptDock.jsx';

/** The old six sections a stage's fill covers. The registry is still keyed by
 *  them, because they are the units the producer answers in — a fill that asked
 *  for the cast and the place in one object would overrun a small model. */
const SECTIONS_OF = { story: ['concept'], cast: ['characters', 'location'], motion: ['motion'], ship: ['ship'] };

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

export function StoryStudio({ active = true } = {}) {
  const [story, setStory] = useState(blankStory);
  const [hydrated, setHydrated] = useState(false);
  const [stage, setStage] = useState('story');
  const [promptOpen, setPromptOpen] = useState(false);

  // The producer — one model for the whole session rather than one per stage.
  // Which model is thinking is a session decision, not a stage decision.
  const [producerId, setProducerId] = useState('');
  const [producerOpen, setProducerOpen] = useState(false);
  // The catalog, the picker's own state (section, search, account, key field)
  // and every repair a source can offer come from the same hook the prompt
  // helper uses, so the two pickers cannot drift. A repair that switches
  // sections also opens the popover, or its button appears to do nothing.
  const sources = useModelSources({ onOpen: setProducerOpen });
  const { catalog: runtime, refresh: refreshRuntime, runRemedy } = sources;
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
  // Discovered, not assumed. Story used to list the desktop sd.cpp catalog as
  // "On this machine" and default to the first workable row in it, which in a
  // hosted studio is an id the bridge refuses.
  const { models: localModels, status: localStatus, refresh: refreshLocalCatalog } = useLocalImageCatalog();
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

  // One catalog for every engine. A machine with no local weights on it used to
  // have no producer at all; HivemindOS's models answer for it now, on the same
  // credits as the HivemindOS app itself. The first catalog decides where to
  // start; a later refresh never overrides a choice already made.
  useEffect(() => {
    if (!runtime) return;
    setProducerId((current) => current || startingModelId(runtime, lastUsedModelId()));
  }, [runtime]);

  // Local rows keep their loaded-first order; the cloud list is already ordered
  // by HivemindOS (its own tiers first, then the gateway's catalog).
  const localProducerModels = useMemo(() => sortModels(sourceState(runtime, LOCAL).models), [runtime]);
  const producer = rowFor(runtime, producerId);
  // What askProducer needs to know about THIS machine, in the shape it already
  // reads, so a cloud catalog does not send it looking for a local id.
  const localSnapshot = useMemo(() => ({ models: localProducerModels }), [localProducerModels]);

  const cancelProducer = useCallback(() => abortRef.current?.abort(), []);

  /**
   * A producer failure, shown with its repair when it named one.
   *
   * The engines answer refusals as `{message, remedy, provider}` — an expired
   * ChatGPT sign-in, a key the provider rejected, credits that ran out — so a
   * plain `toast.error(message)` throws the only actionable half away.
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
    for (const note of notes) toast(note, { duration: 8000 });
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
  }, [producer, runProducer, producerFailed]);

  /* ---------------- auto-fill ---------------- */

  // Rebuilt when the production changes rather than looked up per field: forty
  // fields each re-scanning six sections would rebuild the registry forty times
  // a keystroke.
  const specs = useMemo(() => fieldMap(story), [story]);

  /**
   * Write the named fields from everything else the director has written.
   *
   * The context is the WHOLE production, not the stage in view — that is the
   * point of the button. The fields being written are omitted from it, because
   * a field offered as evidence for itself comes back as what is already there.
   */
  const fill = useCallback(async (ids, { busyKey = '' } = {}) => {
    const registry = fieldMap(storyRef.current);
    const entries = ids.map((id) => registry.get(id)).filter(Boolean);
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
    // The story as it is being written, so the summary can compare against it.
    // Kept locally because React has not necessarily re-rendered between two
    // awaits.
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
      if (written) toast(`Stopped — ${written} of ${total} written.`);
      return { written, stopped: true };
    }
    if (failure) {
      if (!written) producerFailed(failureError, failure);
      else toast(`Filled ${written} of ${total}, then the producer stopped: ${failure}`, { duration: 12000 });
      return { written, failed: true };
    }
    if (!written) {
      toast.error('Nothing usable came back for that.');
      return { written: 0 };
    }
    if (written < total) {
      toast(`Filled ${written} of ${total} — the rest came back empty. Press Draft again for those.`);
    }
    return { written };
  }, [producer, runProducer, update, producerFailed]);

  /**
   * One stage's blanks, or its whole set of fields once nothing is blank.
   *
   * A redraft overwrites work the director may have written by hand, so the
   * button names the count before it runs and this keeps the version it
   * replaced behind an Undo.
   */
  const fillStage = useCallback(async (stageId) => {
    const sections = SECTIONS_OF[stageId] || [];
    const current = storyRef.current;
    const blank = sections.flatMap((section) => blankFieldsIn(section, current));
    const redraft = blank.length === 0;
    const entries = redraft ? sections.flatMap((section) => fieldsFor(section, current)) : blank;
    if (!entries.length) {
      toast('Nothing to write in this stage yet.');
      return;
    }
    const before = redraft ? current : null;
    const outcome = await fill(entries.map((entry) => entry.id), { busyKey: `fill-section:${stageId}` });
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
      ), { duration: 12000 });
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
    // A missing server-side key opens the producer picker's own inline field —
    // the same door, so there is one place a key is added rather than two.
    if (action.kind === 'key') { void runRemedy({ action: 'key', key: action.key }); return; }
    if (action.kind !== 'oauth') return;
    const key = `oauth:${action.provider}`;
    setFixing(key);
    try {
      const url = await startOAuthLogin(action.provider);
      window.open(url, '_blank', 'noopener,noreferrer');
      toast('Finish the sign-in in the tab that just opened, then press Check again.', { duration: 9000 });
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
  }, [refreshOAuth, runRemedy]);

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

  // Shown beside the pickers only when this machine offers nothing at all —
  // with cloud rows on screen a local warning would be noise.
  const localNotice = isLocalAIAvailable() && localStatus !== 'ready' && !localModels.length
    ? <LocalCatalogNotice status={localStatus} onCheckAgain={refreshLocalCatalog} />
    : null;

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
    if (!model) { toast.error('Pick a model to draw it with — under “Drawn with”.'); return ''; }
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
      // Read the picture ONCE, in the clear, and keep it: it is what the
      // reference upload sends, and it is what the card shows. The reference
      // comes back sealed to the owner vault, and displaying it by fetching
      // and decrypting the new URL depends on the vault key being in this
      // tab — when it was not, the sheet that had just been drawn rendered as
      // a broken image over ciphertext. The bytes were here the whole time.
      const dataUrl = await mediaSourceToDataUrl(result.url, 'image').catch(() => '');
      const reference = await promoteOutputToReference(result.url, { kind: 'image', name, dataUrl }).catch(() => '');
      if (reference && dataUrl) primeResolvedMedia(reference, dataUrl);
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
            { duration: 14000 },
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

  /* ---------------- stage 1: the story ---------------- */

  const brief = story.brief;
  const setBrief = useCallback((patch) => update((current) => ({ ...current, brief: { ...current.brief, ...patch } })), [update]);

  const askConcepts = async () => {
    const result = await ask('concepts', conceptBrief(brief));
    if (!result) return;
    const concepts = normalizeConcepts(result, { count: brief.count });
    if (!concepts.length) { toast.error('No usable directions came back — try again, or a larger model.'); return; }
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
    const rows = chosen.length ? chosen : story.concepts;
    const url = await draw({
      key: 'contact',
      label: 'contact sheet',
      model: sheetModel,
      prompt: contactSheetPrompt(rows, { style: story.style, world: brief.world }),
      // The canvas the prompt's own grid was laid out for — the sheet says how
      // many cells across it is, so it cannot also be asked for a canvas of a
      // different shape.
      aspect: contactSheetLayout(rows.length).canvas,
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
    update((current) => ({
      ...current,
      title: result.title || current.title,
      promise: result.promise || current.promise,
      contract: { ...current.contract, ...(result.contract || {}) },
      characters: characters.length ? characters : current.characters,
    }));
    toast.success('Contract locked. Every later stage quotes it.');
  };

  /* ---------------- stage 2: cast and place ---------------- */

  const patchCharacter = useCallback((index, patch) => update((current) => ({
    ...current,
    characters: current.characters.map((row, i) => (i === index ? { ...row, ...patch } : row)),
  })), [update]);

  const drawSheet = async (index) => {
    const character = storyRef.current.characters[index];
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

  const setLocation = useCallback((patch) => update((current) => ({ ...current, location: { ...current.location, ...patch } })), [update]);

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

  /**
   * Write the cast and the place from the locked contract.
   *
   * With no characters at all there is nothing for a field fill to write into,
   * and the old studio answered that press with "Nothing to write yet". The
   * contract already names both halves of the pair, so the rows are seeded from
   * it rather than asking the director to add two blanks and name them again.
   */
  const draftCast = useCallback(async () => {
    let current = storyRef.current;
    if (!current.characters.length) {
      const seeds = [current.contract.who, current.contract.other]
        .map((value) => String(value || '').trim())
        .filter(Boolean);
      if (!seeds.length) {
        toast.error('Lock a direction on the story stage first — the cast is written from the contract.');
        return;
      }
      const seeded = seeds.map((role) => ({ ...blankCharacter(), role }));
      update((row) => ({ ...row, characters: seeded }));
      // Written straight onto the ref as well: `fill` reads the story from here
      // for its context and its registry, and the re-render that would move it
      // has not happened by the next line.
      current = { ...current, characters: seeded };
      storyRef.current = current;
    }
    await fillStage('cast');
  }, [update, fillStage]);

  /* ---------------- stage 3: what happens ---------------- */

  const setBoard = useCallback((patch) => update((current) => ({ ...current, board: { ...current.board, ...patch } })), [update]);

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

  const patchPanel = useCallback((index, patch) => update((current) => ({
    ...current,
    board: {
      ...current.board,
      panels: current.board.panels.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    },
  })), [update]);

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

  const boardNotes = useMemo(
    () => boardWarnings(story.board.panels, story.board.format),
    [story.board.panels, story.board.format],
  );

  const setMotion = useCallback((patch) => update((current) => ({ ...current, motion: { ...current.motion, ...patch } })), [update]);
  const patchBeat = useCallback((index, patch) => update((current) => ({
    ...current,
    motion: {
      ...current.motion,
      beats: current.motion.beats.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    },
  })), [update]);

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
      beats: beats.length ? beats : defaultBeats(story.motion.seconds, story.motion.beats.length || 3),
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

  /* ---------------- stage 4: the gate ---------------- */

  const setVerdict = useCallback((id, value) => update((current) => ({
    ...current,
    qa: { ...current.qa, verdicts: { ...current.qa.verdicts, [id]: current.qa.verdicts[id] === value ? '' : value } },
  })), [update]);

  const setCaption = useCallback((id, value) => update((current) => ({
    ...current, qa: { ...current.qa, caption: { ...current.qa.caption, [id]: value } },
  })), [update]);

  const verdict = useMemo(() => shipVerdict(story.qa.verdicts), [story.qa.verdicts]);
  const caption = useMemo(() => buildCaption(story.qa.caption), [story.qa.caption]);
  const segments = useMemo(
    () => segmentPlan({ totalSeconds: story.segments.total, perGeneration: story.segments.per }),
    [story.segments],
  );

  /**
   * Record that this production was approved — the one thing the gate can
   * actually decide, and the half still worth having a month later.
   *
   * Blocked while a blocking check has failed, because "ship it anyway" is not
   * a decision this stage is willing to record silently.
   */
  const ship = () => {
    if (story.qa.shipped) {
      update((current) => ({ ...current, qa: { ...current.qa, shipped: '' } }));
      return;
    }
    if (verdict.state === 'blocked') {
      toast.error(verdict.headline);
      return;
    }
    update((current) => ({ ...current, qa: { ...current.qa, shipped: new Date().toISOString() } }));
    toast.success(
      verdict.untested.length
        ? `Shipped with ${verdict.untested.length} check${verdict.untested.length === 1 ? '' : 's'} unrun. Finish in order: join, sound, caption, upscale.`
        : 'Shipped. Finish in order: join the takes, balance the sound, write the caption, upscale last.',
      { duration: 8000 },
    );
  };

  /* ---------------- the handoff ---------------- */

  // What this production would actually look like once it arrived somewhere —
  // asked of the real handoff, so the menu never promises a picture that this
  // target has no lane for. Cheap: the handoff is a pure mapping.
  const describeSendTo = (plan) => describeHandoff(storyHandoff(story, { script, plan }));

  /**
   * Hand the whole production over, not just the paragraph — to a chosen tab,
   * on a chosen source, written for the model that source is on.
   *
   * This used to post the script alone into whichever video tab happened to be
   * in front, on whatever source it happened to be on. Two things were wrong
   * with that and they were the same thing: nothing was attached, so the
   * composer — which picks its grammar from what IS attached — could only
   * render the prose as prose. Now the target is chosen first and the story is
   * written FOR it (lib/videoDelivery.js): a cast and a six-section prompt for
   * H3's reference lane, stitched ingredient views and a paragraph for LTX,
   * labelled blocks for Seedance, and an honest count of what could not travel.
   */
  const sendToVideo = ({ tabId, source, descriptor }) => {
    if (!script) { toast.error('There is no script to send yet.'); return; }
    const handoff = storyHandoff(story, {
      script,
      plan: descriptor?.plan || null,
      // The row named a model; the target must land on THAT one, or the prompt
      // arrives written for a model nothing selected.
      modelId: descriptor?.modelId || '',
    });
    // The tab has to be in front before the setup bridge will drain into it.
    selectSendTarget('video', tabId);
    loadStudioSetup('video', { ...handoff, source });
    window.dispatchEvent(new CustomEvent('navigate', { detail: { page: 'video' } }));
    const { pictures, unattached } = handoff.counts;
    const where = descriptor?.modelName ? ` on ${descriptor.modelName}` : '';
    const carried = pictures
      ? `${pictures} picture${pictures === 1 ? '' : 's'} attached`
      : 'nothing attached';
    toast.success(
      `Sent to the Video studio${where} — ${handoff.seconds}s, ${carried}.`
      + (unattached ? ` ${unattached} could not travel: this model has no lane for ${unattached === 1 ? 'it' : 'them'}.` : '')
      + (handoff.seconds < handoff.askedSeconds ? ` Trimmed from ${handoff.askedSeconds}s — that is as long as this model holds a scene.` : ''),
      { duration: 9000 },
    );
  };

  /* ---------------- prompt bridge ---------------- */

  // The explore dock and the hub insert into whichever studio is visible. Here
  // there is no single prompt box, so the insert lands where text is most
  // likely wanted: the motion script once one exists, the brief before that.
  useEffect(() => {
    if (!active) return undefined;
    return registerPromptInserter((text) => {
      const current = storyRef.current;
      if (current.motion.override || current.motion.beats.some((beat) => beat.action)) {
        const base = current.motion.override || motionScript(current.motion);
        setMotion({ override: `${base}${base.endsWith('\n') ? '' : '\n'}${text}` });
        setPromptOpen(true);
      } else {
        setBrief({ pitch: `${current.brief.pitch}${current.brief.pitch ? '\n' : ''}${text}` });
        setStage('story');
      }
    });
  }, [active, setMotion, setBrief]);

  /* ---------------- what the rail says ---------------- */

  const contractGaps = contractBlanks(story.contract);
  const writtenBeats = story.motion.beats.filter((beat) => String(beat.action || '').trim()).length;
  const sheetsDrawn = story.characters.filter((row) => row.sheetUrl).length;

  const stages = useMemo(() => STORY_STAGES.map((entry) => {
    if (entry.id === 'story') {
      return {
        ...entry,
        done: contractGaps.length === 0 && story.characters.length > 0,
        status: story.lockedId
          ? `Locked — ${story.title || 'contract written'}`
          // A contract can be whole without a card ever having been locked —
          // the worked example, or a director who wrote their own idea. The
          // badge says done either way, so the line has to agree with it.
          : contractGaps.length === 0
            ? `Contract written${story.title ? ` — ${story.title}` : ''}`
            : story.concepts.length
              ? `${story.concepts.length} direction${story.concepts.length === 1 ? '' : 's'} drafted`
              : 'Nothing drafted yet',
      };
    }
    if (entry.id === 'cast') {
      return {
        ...entry,
        done: story.characters.length > 0 && sheetsDrawn === story.characters.length && Boolean(story.location.plateUrl),
        status: `${story.characters.length} character${story.characters.length === 1 ? '' : 's'}`
          + (story.characters.length ? ` · ${sheetsDrawn} of ${story.characters.length} drawn` : '')
          + ` · plate ${story.location.plateUrl ? 'drawn' : 'not drawn'}`,
      };
    }
    if (entry.id === 'motion') {
      return {
        ...entry,
        done: Boolean(script) && notes.length === 0,
        status: `${writtenBeats} beat${writtenBeats === 1 ? '' : 's'} · ${story.motion.seconds}s`
          + ` · board ${story.board.sheetUrl ? 'drawn' : story.board.panels.some((panel) => panel.verb) ? 'drafted' : 'empty'}`,
      };
    }
    return {
      ...entry,
      done: verdict.state === 'ship',
      status: story.qa.shipped
        ? 'Shipped'
        : `${QA_CHECKS.length - verdict.untested.length} of ${QA_CHECKS.length} checked`,
    };
  }), [
    contractGaps.length, story.characters.length, story.lockedId, story.title, story.concepts.length,
    sheetsDrawn, story.location.plateUrl, script, notes.length, writtenBeats, story.motion.seconds,
    story.board.sheetUrl, story.board.panels, verdict.state, verdict.untested.length, story.qa.shipped,
  ]);

  // Anything that means a production is already under way. Loading the example
  // replaces all of it, so it asks first — the sheets and plates survive in the
  // reference library, but the writing around them does not.
  const hasWork = Boolean(
    story.concepts.length || story.characters.length
    || story.location.place || story.motion.beats.some((beat) => beat.action),
  );

  // A native OS confirm popping out of a dark, designed app reads as broken —
  // and in a Tauri WebView it looks nothing like the product. Both of these ask
  // through the app's own ConfirmModal instead (DESIGN.md §3).
  const [confirming, setConfirming] = useState('');

  const applyExample = () => {
    update({
      ...blankStory(),
      ...STORY_EXAMPLE,
      // The example ships no images: the URLs would point at references this
      // browser has never uploaded, and a broken preview reads as a failed draw.
      board: { ...STORY_EXAMPLE.board, sheetUrl: '' },
      characters: STORY_EXAMPLE.characters.map((row) => ({ ...blankCharacter(), ...row, sheetUrl: '', audit: {} })),
    });
    setStage('story');
    toast('Loaded a worked example — every field filled with the kind of thing that belongs in it.');
  };

  const clearProduction = () => {
    update(blankStory());
    setStage('story');
  };

  const loadExample = () => {
    if (hasWork) { setConfirming('example'); return; }
    applyExample();
  };

  const startOver = () => {
    if (hasWork) { setConfirming('clear'); return; }
    clearProduction();
  };

  /* ---------------- the cast draft's own label ---------------- */

  const castBlanks = useMemo(
    () => blankFieldsIn('characters', story).length + blankFieldsIn('location', story).length,
    [story],
  );
  const castFields = useMemo(
    () => fieldsFor('characters', story).length + fieldsFor('location', story).length,
    [story],
  );

  /* ---------------- render ---------------- */

  const rail = (
    <StageRail
      stages={stages}
      stage={stage}
      onStage={setStage}
      title={story.title}
      promise={story.promise}
      locked={Boolean(story.lockedId) && contractGaps.length === 0}
      onNew={startOver}
      onExample={loadExample}
    />
  );

  const dock = (
    <PromptDock
      story={story}
      script={script}
      overridden={Boolean(story.motion.override)}
      budget={budget}
      open={promptOpen}
      onToggle={() => setPromptOpen((open) => !open)}
      onScript={(value) => setMotion({ override: value })}
      onRevert={() => setMotion({ override: '' })}
      onTighten={() => setMotion({ override: tighten(script) })}
      onCompress={compress}
      busy={busy}
      onCopy={() => { navigator.clipboard?.writeText(script); toast.success('Script copied.'); }}
      onSend={sendToVideo}
      describeSendTo={describeSendTo}
    />
  );

  return (
    <StudioLayout panel={rail} panelTitle="Stages" panelWidth="w-[252px]" composer={dock}>
      <ProducerBar
        summary={[story.title || 'Untitled production', `${story.motion.seconds}s`, story.aspect].join(' · ')}
        producer={producer}
        open={producerOpen}
        onOpen={setProducerOpen}
        busy={busy}
        thinking={thinking}
        onCancel={cancelProducer}
        warning={matrixError}
        picker={{
          ...sources.pickerProps,
          selectedId: producerId,
          onPick: (id) => { setProducerId(id); rememberModelId(id); },
          // What one press costs, per row: a Story draft is the press here.
          usage: DRAFT_USAGE,
        }}
      />

      <div className="mx-auto flex w-full max-w-[820px] flex-col gap-5 px-9 pb-12 pt-7 max-sm:px-4">
        {!isHivemindStudioEnabled() ? (
          <p className="m-0 rounded-lg border border-warn/40 bg-warn/[0.08] p-3 text-[13px] leading-snug text-ink2">
            The producer runs on this machine’s models and on HivemindOS. Open the studio from the
            Hivemind Content Studio shell so it can reach them.
          </p>
        ) : null}

        {stage === 'story' ? (
          <StoryStage
            story={story}
            specs={specs}
            busy={busy}
            thinking={thinking}
            drawing={drawing}
            onFill={fillOne}
            onUpdate={update}
            onBrief={setBrief}
            draft={askConcepts}
            onCancel={cancelProducer}
            onCompare={askShortlist}
            onContactSheet={drawContactSheet}
            onShortlist={toggleShortlist}
            onLock={lockConcept}
            onFillContract={() => { void fillStage('story'); }}
          />
        ) : null}

        {stage === 'cast' ? (
          <CastStage
            story={story}
            specs={specs}
            busy={busy}
            thinking={thinking}
            drawing={drawing}
            onFill={fillOne}
            onUpdate={update}
            onLocation={setLocation}
            onPatchCharacter={patchCharacter}
            onAddCharacter={() => update((current) => ({ ...current, characters: [...current.characters, blankCharacter()] }))}
            onRemoveCharacter={(index) => update((current) => ({
              ...current, characters: current.characters.filter((_, i) => i !== index),
            }))}
            onDrawSheet={drawSheet}
            onDrawPlate={drawPlate}
            onChooseLocation={chooseLocation}
            onSuggestPlaces={askLocations}
            draft={draftCast}
            onCancel={cancelProducer}
            draftLabel={castBlanks ? 'Draft the cast and the place' : `Redraft ${castFields} fields`}
            draftHint={castBlanks
              ? `from the locked contract · ${castBlanks} field${castBlanks === 1 ? '' : 's'} still blank`
              : 'everything is written — this rewrites all of it, with an Undo'}
            sheetChoices={sheetChoices}
            sheetModel={sheetModel}
            onSheetModel={setSheetModel}
            plateChoices={plateChoices}
            plateModel={plateModel}
            onPlateModel={setPlateModel}
            localNotice={localNotice}
            readinessFor={rowReadiness}
            onFixReadiness={fixReadiness}
            fixing={fixing}
          />
        ) : null}

        {stage === 'motion' ? (
          <MotionStage
            story={story}
            specs={specs}
            busy={busy}
            thinking={thinking}
            drawing={drawing}
            onFill={fillOne}
            onMotion={setMotion}
            onPatchBeat={patchBeat}
            onBoard={setBoard}
            onPatchPanel={patchPanel}
            draft={askBeats}
            onCancel={cancelProducer}
            onDraftBoard={askBoard}
            onDrawBoard={drawBoard}
            onChangeFormat={changeFormat}
            boardText={boardText}
            boardNotes={boardNotes}
            notes={notes}
            boardChoices={boardChoices}
            boardModel={boardModel}
            onBoardModel={setBoardModel}
            localNotice={localNotice}
            readinessFor={rowReadiness}
            onFixReadiness={fixReadiness}
            fixing={fixing}
          />
        ) : null}

        {stage === 'ship' ? (
          <ShipStage
            story={story}
            specs={specs}
            busy={busy}
            verdict={verdict}
            caption={caption}
            segments={segments}
            onFill={fillOne}
            onUpdate={update}
            onVerdict={setVerdict}
            onCaption={setCaption}
            onShip={ship}
            onFillCaption={() => { void fillStage('ship'); }}
          />
        ) : null}
      </div>

      <ConfirmModal
        open={Boolean(confirming)}
        onClose={() => setConfirming('')}
        onConfirm={() => {
          const which = confirming;
          setConfirming('');
          if (which === 'example') applyExample();
          else clearProduction();
        }}
        tone={confirming === 'clear' ? 'danger' : 'primary'}
        title={confirming === 'clear'
          ? 'Clear this production and start a new one?'
          : 'Replace this production with the worked example?'}
        body="The sheets and plates stay in your references."
        confirmLabel={confirming === 'clear' ? 'Clear' : 'Replace'}
        cancelLabel="Cancel"
      />

      {authOpen ? <AuthModal onClose={() => setAuthOpen(false)} onSaved={() => setAuthOpen(false)} /> : null}
    </StudioLayout>
  );
}
