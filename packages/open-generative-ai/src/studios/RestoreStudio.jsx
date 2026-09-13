// Restore Studio — local video restoration and upscaling with SeedVR2.
//
// The shape of the thing: load a clip, render a SHORT preview, look at it next
// to the original, and only then commit to the whole film. A full render is
// tens of minutes to hours; the preview exists so that decision costs one chunk
// instead of an evening.
//
// FREE AND PAID ARE ONE BUTTON WITH TWO MACHINES BEHIND IT. On this computer's
// own ComfyUI the render costs electricity, the gateway keeps the restored
// chunks losslessly, and every finishing pass is re-runnable. On an attached
// rented GPU the same plan runs on someone else's card, billed by the hour —
// and because its chunks come back sealed to the owner's vault (the gateway
// cannot read them, by design), the join happens HERE, in the browser where the
// key is. Every one of those consequences is stated in the panel rather than
// discovered afterwards.
//
// WHAT SURVIVES A CLOSED TAB. The chunk loop runs in the gateway, not here, and
// each finished chunk is written to the project before the next one starts. So
// this component is a view onto a project rather than the thing driving it: it
// polls, it can stop, and it can resume — and a reload during a two-hour render
// loses nothing.
//
// THE SHAPE ON SCREEN is the Image and Video studios' frame (studios/frame/),
// not StudioLayout: the comparison owns the window, past projects are the right
// rail, every dial is one press away behind Advanced, and the clip and the two
// presses float in one composer over the picture. Nothing was dropped in the
// move — the upload bar and the chunk progress became the stage's own lower-edge
// readout, the Finish panel became the drawer's last section, and the project
// rows became rail cards with their Open / Resume / Delete in one menu. This
// render mounts four surfaces: restore/RestoreStage.jsx (the comparison),
// restore/RestoreRail.jsx (the projects), restore/RestoreComposer.jsx (the clip,
// the sentence and the presses) and restore/RestoreSettings.jsx (the drawer).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'react-hot-toast';

import { Icon } from '../ui/icons.jsx';
import { toastFailure } from '../ui/failureToast.jsx';
import { runFailureRemedy } from '../lib/failureRemedy.js';
import { Card, FailureCallout } from '../ui/kit.jsx';
import { ConfirmModal } from '../ui/Modal.jsx';
import { useMediaSrc } from '../hooks/hooks.js';
import { downloadMedia } from '../lib/downloadMedia.js';
import { resolveMediaSrc } from '../lib/e2eMedia.js';
import { runTargetsFromRows } from '../lib/runTargets.js';
import {
  CLOUD_LANE, FINISH_DEFAULTS, RESTORE_DEFAULTS,
  approvedSpendUsd, chunkOutputUrls, deleteRestoreProject, describeEta, describePrice,
  describeRestoreFailure, describeRetention, estimatePrice, fetchRestorePlan, fetchRestoreProject,
  fetchRestoreProjects, finishRestore, laneReadinessFor, measureClip, planRestore, rentalForLane,
  restoreCapabilities, restoreFailureLine, restoreRunTargets, sourceTooLargeAdvice, startRestore,
  stopRestore, uploadRestoreSource,
} from '../lib/videoRestore.js';
import { DrawerBody } from './frame/AdvancedDrawer.jsx';
import { StudioFrame } from './frame/StudioFrame.jsx';
import { RestoreComposer } from './restore/RestoreComposer.jsx';
import { RestoreFinish } from './restore/RestoreFinish.jsx';
import { RestoreRail } from './restore/RestoreRail.jsx';
import { RestoreSettings } from './restore/RestoreSettings.jsx';
import { RestoreStage, RestoreStageActions } from './restore/RestoreStage.jsx';

const POLL_MS = 4000;
// Long enough to judge temporal stability, short enough to be one chunk.
const PREVIEW_SECONDS = 2;
const TERMINAL = new Set(['complete', 'error', 'stopped', 'awaiting_assembly']);

/**
 * The price, on the button that spends it.
 *
 * Empty for every lane but the hosted one, which is the only place a press
 * moves money by itself: a local render costs electricity and a rented box is
 * already being billed for whether this button is pressed or not.
 */
function hostedPrice(quote) {
  const total = Number(quote?.totalUsd);
  if (!Number.isFinite(total) || total <= 0) return '';
  return total < 1 ? ` · ${Math.round(total * 100)}¢` : ` · $${total.toFixed(2)}`;
}

export function RestoreStudio({ active = true }) {
  const [lanes, setLanes] = useState([]);
  // The whole capabilities payload, not just its lanes: it also carries the
  // size this machine will take and how long it keeps working files, and both
  // are things the studio has to say BEFORE somebody waits rather than after.
  const [capabilities, setCapabilities] = useState(null);
  const [lane, setLane] = useState('');
  const [rental, setRental] = useState(null);
  // `undefined` while it is being fetched, `null` when it could not be priced.
  // The panel says something different for each, because "no price yet" and "we
  // cannot price this" are not the same message to somebody about to spend.
  const [cloudQuote, setCloudQuote] = useState(undefined);
  // A preview is one chunk and it costs money too. It gets its own quote rather
  // than a share of the render's, because a 2-second test and a 4-second chunk
  // are different jobs and only the service may price either.
  const [previewQuote, setPreviewQuote] = useState(undefined);
  const [settings, setSettings] = useState({ ...RESTORE_DEFAULTS });
  const [finish, setFinish] = useState({ ...FINISH_DEFAULTS });
  const [file, setFile] = useState(null);
  const [source, setSource] = useState(null);
  const [originalUrl, setOriginalUrl] = useState('');
  const [project, setProject] = useState(null);
  const [projects, setProjects] = useState([]);
  const [mode, setMode] = useState('wipe');
  const [busy, setBusy] = useState('');
  const [previewAt, setPreviewAt] = useState(0);
  const [joining, setJoining] = useState(false);
  // 0..1 while the source is streaming up, null when nothing is uploading. A
  // several-minute upload with no bar is indistinguishable from a hang.
  const [uploadPct, setUploadPct] = useState(null);
  const [joinedUrl, setJoinedUrl] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(null);
  // Advanced is shut on arrival: the four decisions that matter are in the
  // sentence under the clip, and the other thirteen are one press away.
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const objectUrlRef = useRef('');
  const pollRef = useRef(null);

  const laneInfo = lanes.find((item) => item.lane === lane) || null;
  // Whether the GATEWAY can assemble this — which is a property of the project
  // that already ran, not of whichever lane is selected right now. Opening a
  // rented project while the local lane is picked used to make the finish panel
  // promise a re-finish from chunks the gateway cannot read.
  const assemblesHere = project
    ? project.sink !== 'clip'
    : (laneInfo ? laneInfo.assembles_here : true);

  const plan = useMemo(() => (source ? planRestore({
    frames: source.frames, fps: source.fps, width: source.width, height: source.height, settings,
  }) : null), [source, settings]);

  // What a rented render would cost, from the rate the Machines page shows and
  // the time THIS project has actually measured. Before the first chunk lands
  // there is no honest duration, so there is no figure.
  const price = useMemo(() => {
    if (!laneInfo?.paid) return null;
    const perChunk = project?.progress?.seconds_per_chunk || 0;
    const chunks = plan?.chunks?.length || project?.progress?.chunks_total || 0;
    return estimatePrice({ usdPerHour: rental?.usd_per_hour, seconds: perChunk * chunks });
  }, [laneInfo, rental, project, plan]);

  // --- capability + project list ---------------------------------------------

  const refreshProjects = useCallback(async () => {
    setProjects(await fetchRestoreProjects());
  }, []);

  // Asked again by the panel's own "Try again", so a lane that was down when
  // the studio opened is not down until a reload.
  const reloadCapabilities = useCallback(async () => {
    const data = await restoreCapabilities();
    const usable = (data.lanes || []).filter((item) => item.available);
    setCapabilities(data);
    setLanes(data.lanes || []);
    // The free one first when it can do the job: a paid default is a bill
    // nobody chose.
    setLane((current) => current || usable.find((item) => !item.paid)?.lane || usable[0]?.lane || '');
    return data;
  }, []);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    (async () => {
      await reloadCapabilities();
      if (cancelled) return;
      void refreshProjects();
    })();
    return () => { cancelled = true; };
  }, [active, refreshProjects, reloadCapabilities]);

  useEffect(() => {
    if (!laneInfo?.paid || lane === CLOUD_LANE) { setRental(null); return undefined; }
    let cancelled = false;
    rentalForLane(lane).then((found) => { if (!cancelled) setRental(found); });
    return () => { cancelled = true; };
  }, [lane, laneInfo]);

  // The hosted lane's price, from the service rather than from arithmetic here.
  // Re-asked whenever a dial that moves the price moves — resolution and model
  // are most of it — and debounced, because these dials are sliders and a quote
  // per keystroke is a request per keystroke.
  useEffect(() => {
    if (lane !== CLOUD_LANE || !source) {
      setCloudQuote(undefined);
      setPreviewQuote(undefined);
      return undefined;
    }
    let cancelled = false;
    setCloudQuote(undefined);
    setPreviewQuote(undefined);
    const measured = {
      frames: source.frames, fps: source.fps, width: source.width, height: source.height,
    };
    const timer = setTimeout(() => {
      const previewFrames = Math.round(PREVIEW_SECONDS * (source.fps || 24));
      Promise.all([
        fetchRestorePlan({ ...measured, settings, runOn: CLOUD_LANE }),
        fetchRestorePlan({
          ...measured, settings, runOn: CLOUD_LANE,
          previewFrames, previewStartFrame: Math.round(previewAt * (source.fps || 24)),
        }),
      ]).then(([whole, test]) => {
        if (cancelled) return;
        // A plan that came back without a quote is a lane that could not be
        // priced, which the panel says out loud rather than showing nothing.
        setCloudQuote(whole?.lane?.quote || null);
        setPreviewQuote(test?.lane?.quote || null);
      });
    }, 400);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [lane, source, settings, previewAt]);

  // --- the source clip --------------------------------------------------------

  const attach = useCallback(async (picked) => {
    if (!picked) return;
    setBusy('measuring');
    try {
      const measured = await measureClip(picked);
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = URL.createObjectURL(picked);
      setFile(picked);
      setSource(measured);
      setOriginalUrl(objectUrlRef.current);
      setProject(null);
      setJoinedUrl('');
      setPreviewAt(0);
    } catch (error) {
      toast.error(error?.message || 'That file could not be read as video.');
    } finally {
      setBusy('');
    }
  }, []);

  useEffect(() => () => { if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current); }, []);

  // --- polling ----------------------------------------------------------------

  const poll = useCallback(async (projectId) => {
    try {
      const data = await fetchRestoreProject(projectId);
      // Progress rides BESIDE the project on the wire, not inside it — it is
      // derived, not stored. Folded in here so the running card has one shape
      // to read whether it came from a poll or from the project list.
      setProject({ ...data.project, progress: data.progress, resume_from: data.resume_from });
      if (TERMINAL.has(data.project?.status)) {
        void refreshProjects();
        return true;
      }
    } catch (error) {
      // A project that vanished stops the poll rather than looping on a 404.
      toast.error(restoreFailureLine(error));
      return true;
    }
    return false;
  }, [refreshProjects]);

  useEffect(() => {
    const id = project?.id;
    if (!id || TERMINAL.has(project?.status)) return undefined;
    pollRef.current = setInterval(() => { void poll(id); }, POLL_MS);
    return () => clearInterval(pollRef.current);
  }, [project?.id, project?.status, poll]);

  // --- starting ---------------------------------------------------------------

  // The ceiling, before the wait rather than after it. The capabilities payload
  // carries the real number; this turns it into the sentence the picker shows
  // beside the file, with the fix in it.
  const tooLarge = file ? sourceTooLargeAdvice(file, capabilities) : '';

  const start = useCallback(async ({ preview = false, projectId = '' } = {}) => {
    if (!lane) { toast.error('No machine here can restore video yet.'); return; }
    if (!projectId && !file) { toast.error('Load a clip first.'); return; }
    if (!projectId && tooLarge) { toast.error(tooLarge); return; }
    // Nothing is sent to a paid service without a price on screen first. The
    // figure the panel SHOWED is what goes back as the ceiling, so a price that
    // moved between the quote and the start is refused rather than charged.
    const approved = lane === CLOUD_LANE ? approvedSpendUsd(preview ? previewQuote : cloudQuote) : 0;
    if (lane === CLOUD_LANE && !approved) {
      toast.error('This could not be priced, so nothing has been sent. Try again in a moment.');
      return;
    }
    setBusy(preview ? 'preview' : 'render');
    try {
      // Streamed straight off disk to the gateway — nothing is copied into this
      // tab's memory, and the bar below is the real byte count crossing the
      // wire. A resume sends no source at all: the project already has one.
      let sourceId = '';
      if (!projectId) {
        setUploadPct(0);
        const staged = await uploadRestoreSource(file, { onProgress: setUploadPct });
        sourceId = staged.source_id;
      }
      const started = await startRestore({
        sourceId,
        settings,
        // A resume continues the plan it started with; only the machine can
        // still change. See restoreRequestBody.
        resume: Boolean(projectId),
        runOn: laneInfo?.paid ? (lane === CLOUD_LANE ? CLOUD_LANE : (rental?.rental_id || lane)) : '',
        maxSpendUsd: approved,
        projectId,
        previewFrames: preview ? Math.round(PREVIEW_SECONDS * (source?.fps || 24)) : 0,
        previewStartFrame: preview ? Math.round(previewAt * (source?.fps || 24)) : 0,
      });
      toast.success(preview ? 'Rendering a preview…' : 'Restoring — you can close this tab, it keeps going.');
      await poll(started.project_id);
    } catch (error) {
      // A hosted-lane refusal carries `remedy` (connect the account, add
      // credits), so the toast carries the button rather than the sentence.
      toastFailure(error, { operation: 'Starting the restoration' });
    } finally {
      setUploadPct(null);
      setBusy('');
    }
  }, [lane, laneInfo, rental, file, settings, source, previewAt, poll, cloudQuote, previewQuote, tooLarge]);

  const stop = useCallback(async () => {
    if (!project?.id) return;
    try {
      const result = await stopRestore(project.id);
      toast.success(result.message || 'Stopping.');
      void poll(project.id);
    } catch (error) {
      toast.error(restoreFailureLine(error));
    }
  }, [project, poll]);

  // --- the rented path: join here, finish there --------------------------------

  const joinAndFinish = useCallback(async () => {
    if (!project) return;
    setJoining(true);
    try {
      const urls = chunkOutputUrls(project);
      if (urls.length < 1) throw new Error('This project has no chunks to join.');
      const { joinClips } = await import('../lib/clipJoiner.js');
      const blobs = [];
      for (const url of urls) {
        // resolveMediaSrc decrypts the sealed chunk in this tab; the key never
        // leaves it, which is the whole reason the join happens here.
        blobs.push(await (await fetch(await resolveMediaSrc(url))).blob());
      }
      const joined = urls.length === 1 ? { blob: blobs[0] } : await joinClips(blobs);
      // The joined master is the biggest file this feature ever moves, so it
      // goes up the same streamed route the source does rather than as base64.
      setUploadPct(0);
      const staged = await uploadRestoreSource(
        new File([joined.blob], 'joined.mp4', { type: 'video/mp4' }),
        { onProgress: setUploadPct },
      );
      await finishRestore(project.id, finish, staged.source_id);
      toast.success('Joined and finished — the master is in History.');
      await poll(project.id);
    } catch (error) {
      toast.error(restoreFailureLine(error));
    } finally {
      setUploadPct(null);
      setJoining(false);
    }
  }, [project, finish, poll]);

  const applyFinish = useCallback(async () => {
    if (!project?.id) return;
    if (!assemblesHere) return joinAndFinish();
    setBusy('finish');
    try {
      await finishRestore(project.id, finish);
      toast.success('Re-finished from the chunks already on disk.');
      await poll(project.id);
    } catch (error) {
      toast.error(restoreFailureLine(error));
    } finally {
      setBusy('');
    }
    return undefined;
  }, [project, finish, assemblesHere, joinAndFinish, poll]);

  // --- reopening --------------------------------------------------------------

  const open = useCallback(async (summary) => {
    try {
      const data = await fetchRestoreProject(summary.id);
      setProject({ ...data.project, progress: data.progress, resume_from: data.resume_from });
      // Reopen ON the machine it ran on. A project's finished chunks belong to
      // one kind of lane — readable files, sealed clips — and resuming it
      // against a different one is refused by the gateway. Selecting the lane
      // here turns that from an error into the obvious default.
      if (data.project?.lane) setLane((current) => data.project.lane || current);
      setJoinedUrl('');
      // The browser no longer holds the file the owner first picked, so the
      // compare view gets the original back from the project itself.
      setSource({
        frames: data.project.plan?.frames || 0,
        fps: data.project.plan?.fps || 24,
        width: data.project.source?.width || 0,
        height: data.project.source?.height || 0,
        hasAudio: Boolean(data.project.source?.has_audio),
      });
      // Fetched to a blob rather than pointed at the URL. MEASURED on the dev
      // harness: a plain (non-ranged) response gives `video.seekable = [0,0]`,
      // so the compare view could play the original but never POSITION it — and
      // positioning the original on the restored clip's frame is the entire
      // point of the view. Every other clip in this app reaches the page as a
      // blob for the same reason.
      if (summary.has_source) {
        const response = await fetch(`/api/restore/source/${encodeURIComponent(summary.id)}`, { credentials: 'same-origin' });
        if (response.ok) {
          if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
          objectUrlRef.current = URL.createObjectURL(await response.blob());
          setOriginalUrl(objectUrlRef.current);
        } else {
          setOriginalUrl('');
        }
      } else {
        setOriginalUrl('');
      }
      setFile(null);
      if (data.project.options?.finish) {
        const saved = data.project.options.finish;
        setFinish({
          sharpen: saved.sharpen ?? 0,
          grain: saved.grain ?? 0,
          skinSoftening: saved.skin_softening ?? 0,
          aspect: saved.aspect || 'source',
          aspectRatio: saved.aspect_ratio || '',
          quality: saved.quality ?? FINISH_DEFAULTS.quality,
        });
      }
    } catch (error) {
      toast.error(restoreFailureLine(error));
    }
  }, []);

  const remove = useCallback(async (summary) => {
    try {
      await deleteRestoreProject(summary.id);
      if (project?.id === summary.id) setProject(null);
      await refreshProjects();
      toast.success('Project deleted. Any master it produced stays in History.');
    } catch (error) {
      toast.error(restoreFailureLine(error));
    } finally {
      setConfirmDelete(null);
    }
  }, [project, refreshProjects]);

  // --- the restored clip on screen ---------------------------------------------

  const masterUrl = project?.master ? `/api/media-studio/gateway/${encodeURIComponent(project.master)}` : '';
  const restoredSrc = useMediaSrc(masterUrl);
  const restoredUrl = joinedUrl || restoredSrc || '';

  const progress = project?.progress || null;
  // Invoices, not an estimate: the gateway records what each chunk really cost
  // as it finishes, which is what makes this safe to show while a render runs.
  const spentUsd = Number(project?.spend?.charged_usd) || 0;
  const running = project && !TERMINAL.has(project.status);
  const needsJoin = project?.status === 'awaiting_assembly';
  // One reading of the failure, shared by the card here and the row in the
  // project list, so the two never say different things about the same render.
  const failure = project?.status === 'error' && project.error
    ? describeRestoreFailure(project.error)
    : null;
  // How long this machine keeps the intermediates. Said beside the render
  // rather than only in the service log, which is where it used to live.
  const retentionLine = describeRetention(capabilities);

  // The last second a two-second test can START at. Zero when the clip is
  // shorter than the test, which is also what hides the marker: a choice with
  // one legal value is not a choice.
  const previewMax = source
    ? Math.max(0, Math.floor((source.frames / source.fps) - PREVIEW_SECONDS))
    : 0;

  // Take the clip off the stage without touching anything on disk. The project
  // list is untouched — this only empties the composer and the comparison, so
  // the next clip starts from a clean plan rather than from the last one's.
  const clearClip = useCallback(() => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = '';
    }
    setFile(null);
    setSource(null);
    setOriginalUrl('');
    setProject(null);
    setJoinedUrl('');
    setPreviewAt(0);
  }, []);

  // Dropping a clip on the composer loads it — the same door the row's own
  // label opens. StudioFrame's ComposerFloat stamps `data-studio-composer` when
  // this contract is present, which is also what keeps the drop off the
  // window-level settings-restore zone.
  const composerDrop = {
    accepts: (dataTransfer) => Array.from(dataTransfer?.types || []).includes('Files'),
    hint: () => 'Drop to load this clip',
    busy: busy === 'measuring',
    onDrop: (dataTransfer) => {
      const picked = Array.from(dataTransfer?.files || [])
        .find((item) => String(item.type || '').startsWith('video/'));
      if (picked) void attach(picked);
      else toast.error('That file could not be read as video.');
    },
  };

  // --- the frame's four surfaces ------------------------------------------------

  // The gateway's lanes as run targets, computed ONCE and handed to both the
  // drawer's card and the sentence's token. Two surfaces asking the same
  // question from two lists is how they come to disagree about which machine is
  // selected — the Image studio hoists aspect, style and batch for the same
  // reason.
  const targets = useMemo(
    () => runTargetsFromRows(restoreRunTargets(lanes), { kind: 'video' }),
    [lanes],
  );
  const runOn = {
    targets,
    value: targets.find((target) => target.id === lane) || null,
    onChange: (target) => setLane(target.id),
    // A lane that cannot run the job says why, and — where the owner can do
    // something about it — carries the door.
    readinessFor: laneReadinessFor(lanes),
    onFixReadiness: (remedy) => void runFailureRemedy(remedy, {
      onRetry: () => { void reloadCapabilities(); },
    }),
  };

  const drawer = (
    <DrawerBody>
      <RestoreSettings
        lanes={lanes}
        runOn={runOn}
        selectedLane={lane}
        price={price}
        cloudQuote={cloudQuote}
        settings={settings}
        onChange={setSettings}
        plan={plan}
        source={file ? source : null}
        busy={Boolean(busy) || Boolean(running)}
      />
      {/* Only once a render exists: there is nothing to finish before there are
          chunks, and five dials that cannot be applied are five dead controls. */}
      {project ? (
        <RestoreFinish
          finish={finish}
          onChange={setFinish}
          onApply={applyFinish}
          busy={busy === 'finish' || joining}
          disabled={running}
          assemblesHere={assemblesHere}
        />
      ) : null}
    </DrawerBody>
  );

  /* ---------------- the composer's two presses ---------------- */

  const chunkCount = plan?.chunks?.length || 0;
  const doneChunks = project?.progress?.chunks_done ?? Object.keys(project?.chunks || {}).length;
  const canStart = Boolean(file && source && !running);
  const startBlocked = Boolean(busy) || Boolean(tooLarge) || !lane;

  let primary;
  if (running) {
    primary = {
      label: 'Restoring…',
      loading: true,
      disabled: true,
      onClick: () => {},
      title: 'Every finished chunk is already saved — stopping costs the chunk in flight and nothing else.',
    };
  } else if (needsJoin) {
    primary = {
      label: `Join ${Object.keys(project.chunks || {}).length} chunks and finish`,
      loading: joining,
      disabled: Boolean(busy),
      onClick: joinAndFinish,
      title: 'Joins the sealed chunks in this tab, where the key is, then sends the master back for its finishing pass',
    };
  } else if (canStart) {
    primary = {
      label: `Restore${chunkCount ? ` ${chunkCount} chunks` : ''}${hostedPrice(cloudQuote)}`,
      loading: busy === 'render',
      disabled: startBlocked,
      onClick: () => start({}),
      title: tooLarge || 'Renders the whole clip, one chunk at a time — you can close this tab',
    };
  } else if (project && project.status !== 'complete') {
    primary = {
      label: `Resume from chunk ${doneChunks + 1}`,
      loading: busy === 'render',
      disabled: Boolean(busy),
      onClick: () => start({ projectId: project.id }),
      title: "Continues from the first chunk with no file, under this project's original settings",
    };
  } else {
    primary = {
      label: 'Restore',
      disabled: true,
      onClick: () => {},
      title: 'Load a clip first.',
    };
  }

  // The cheap way to find out whether this model helps this footage: one chunk,
  // from wherever the marker is. Offered only when a whole render is offered,
  // because it is the same press with a smaller plan.
  const alternate = canStart ? {
    label: `Test ${PREVIEW_SECONDS}s${hostedPrice(previewQuote)}`,
    loading: busy === 'preview',
    disabled: startBlocked,
    onClick: () => start({ preview: true }),
    title: tooLarge || 'One chunk, from wherever the marker is — the cheap way to find out whether this model helps this footage',
  } : null;

  // The bill, in the mono readout beside the press. The hosted lane's figure is
  // already ON the button (it is the only press that moves money by itself) and
  // the rented lane says "billed by the hour" in the sentence, so this carries
  // the one number neither of those has: the RATE, which until now appeared
  // only in the panel.
  const billLabel = lane === CLOUD_LANE
    ? ''
    : (laneInfo?.paid ? (rental?.usd_per_hour ? `$${rental.usd_per_hour}/hr` : '') : (laneInfo ? 'free' : ''));

  /* ---------------- what the stage's lower edge reads ---------------- */

  const uploading = uploadPct !== null;
  const stagePhase = uploading ? 'Uploading' : (running ? 'Restoring' : '');
  const stageSubject = uploading
    ? 'the clip'
    : (progress ? `${progress.chunks_done} of ${progress.chunks_total} chunks` : '');
  // Invoices, not an estimate: the gateway records what each chunk really cost
  // as it finishes, which is what makes this safe to show while a render runs.
  // It answers "what happens if I stop now", so it rides beside the ETA.
  const spentLabel = spentUsd > 0
    ? `${spentUsd < 1 ? `${Math.round(spentUsd * 100)}¢` : `$${spentUsd.toFixed(2)}`} charged${project?.spend?.approved_usd ? ` of $${Number(project.spend.approved_usd).toFixed(2)}` : ''}`
    : '';

  const composer = (
    <RestoreComposer
      clipName={file ? file.name : (project ? `${project.width}x${project.height}${project.preview ? ' preview' : ''}` : '')}
      // The measured clip, under its name. A REOPENED project has no file — the
      // browser never had one — so the line says the shape it came FROM, which
      // is the only reading that makes sense under a name that is the output.
      clipDetail={source
        ? `${file ? '' : 'from a '}${source.width}x${source.height}${file ? '' : ' clip'} · ${source.frames} frames · ${Number(source.fps).toFixed(2)}fps${source.hasAudio ? ' · sound' : ''}`
        : ''}
      onPickClip={(picked) => void attach(picked)}
      onDetachClip={file || project ? clearClip : null}
      clipDisabled={Boolean(busy) || Boolean(running)}
      settings={settings}
      onChangeSettings={setSettings}
      plan={plan}
      previewSeconds={PREVIEW_SECONDS}
      previewAt={previewAt}
      previewMax={previewMax}
      onPreviewAt={setPreviewAt}
      runOn={runOn}
      advancedOpen={advancedOpen}
      onToggleAdvanced={() => setAdvancedOpen((open) => !open)}
      primary={primary}
      alternate={alternate}
      onStop={running ? stop : null}
      billLabel={billLabel}
      billTitle={describePrice(price) || ''}
      projects={projects}
      activeProjectId={project?.id || ''}
      onOpenProject={open}
    />
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <StudioFrame
        railWidth={108}
        drop={composerDrop}
        composer={composer}
        drawerTitle="Advanced"
        drawerOpen={advancedOpen}
        onDrawerClose={() => setAdvancedOpen(false)}
        drawer={drawer}
        notices={(
          <>
            {/* The ceiling, stated BEFORE the wait rather than as a refusal
                after it — and with the fix in the same sentence, which is the
                whole rule. */}
            {tooLarge ? <FailureCallout title={tooLarge} /> : null}

            {needsJoin ? (
              <Card className="flex flex-col gap-2 border-warn/40 p-3">
                <div className="flex items-center gap-2">
                  <Icon name="shield" size={14} className="text-warn" />
                  <span className="text-sm font-medium text-ink1">Rendered — now join it here</span>
                </div>
                <p className="text-[11px] leading-snug text-ink3">
                  This ran on a rented machine, so its chunks came back sealed to your vault and the gateway
                  cannot read them. Joining happens in this tab, where the key is; the finished master then goes
                  back for its finishing pass and lands in History.
                </p>
              </Card>
            ) : null}

            {/* The one time somebody needs help — a two-hour render died — they
                used to get whatever `str(exc)` was: a CUDA allocator dump, an
                ffmpeg stderr tail. This says what happened and what to change,
                keeps the machine's own words behind Details, and the way out is
                the same Resume that keeps every finished chunk. */}
            {failure ? (
              <FailureCallout
                title={failure.action ? `${failure.title} ${failure.action}` : failure.title}
                detail={failure.detail}
                onRetry={() => start({ projectId: project.id })}
                retryLabel={`Resume from chunk ${(project.progress?.chunks_done ?? 0) + 1}`}
                retryDisabled={Boolean(busy)}
              />
            ) : null}
          </>
        )}
        stageActions={originalUrl || restoredUrl ? (
          <RestoreStageActions
            mode={mode}
            onModeChange={setMode}
            canCompare={Boolean(restoredUrl && originalUrl)}
            onDownload={masterUrl && !running ? () => downloadMedia(masterUrl, project.master) : null}
          />
        ) : null}
        stage={(
          <RestoreStage
            source={source}
            originalUrl={originalUrl}
            restoredUrl={restoredUrl}
            mode={mode}
            restoredLabel={project?.plan?.preview ? 'Preview' : 'Restored'}
            busy={Boolean(running) || uploading}
            phase={stagePhase}
            percent={uploading ? uploadPct * 100 : (progress ? progress.fraction * 100 : null)}
            subject={stageSubject}
            timing={uploading
              ? `${Math.round(uploadPct * 100)}%`
              : [spentLabel, describeEta(progress)].filter(Boolean).join(' · ')}
            // One sentence, because the readout truncates: this is the one that
            // decides whether somebody dares close the tab. How long the
            // intermediates survive is said in full at the foot of the rail,
            // where it is not competing with a running bar for the same line.
            note={uploading
              ? 'Streamed straight to the machine that will render it — nothing is copied into this tab, so the size of the film is not the size of this page.'
              : 'Each finished chunk is saved before the next one starts, so stopping — or closing this tab — costs you the chunk in flight and nothing else.'}
            onCancel={running ? stop : null}
            cancelLabel="Stop"
          />
        )}
        rail={(
          <RestoreRail
            projects={projects}
            activeId={project?.id || ''}
            onOpen={open}
            onResume={(summary) => start({ projectId: summary.id })}
            onDelete={setConfirmDelete}
            busy={Boolean(busy) || Boolean(running)}
            retention={retentionLine}
          />
        )}
      />

      <ConfirmModal
        open={Boolean(confirmDelete)}
        title="Delete this restoration project?"
        // Said explicitly because the two are easy to confuse: the working files
        // go, the film does not.
        body={'Its source clip and its restored chunks are deleted permanently. Any master it already produced stays in History — but re-finishing it will no longer be possible without rendering again.'}
        confirmLabel="Delete project"
        onConfirm={() => remove(confirmDelete)}
        onClose={() => setConfirmDelete(null)}
      />
    </div>
  );
}
