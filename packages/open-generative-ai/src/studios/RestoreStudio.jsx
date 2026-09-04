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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'react-hot-toast';

import { Icon } from '../ui/icons.jsx';
import { toastFailure } from '../ui/failureToast.jsx';
import { runFailureRemedy } from '../lib/failureRemedy.js';
import {
  Button, Card, EmptyState, FailureCallout, Pill, ProgressBar, Slider, StudioLayout, cx,
} from '../ui/kit.jsx';
import { ConfirmModal } from '../ui/Modal.jsx';
import { useMediaSrc } from '../hooks/hooks.js';
import { downloadMedia } from '../lib/downloadMedia.js';
import { resolveMediaSrc } from '../lib/e2eMedia.js';
import {
  CLOUD_LANE, FINISH_DEFAULTS, RESTORE_DEFAULTS,
  approvedSpendUsd, chunkOutputUrls, deleteRestoreProject, describeEta, describeRestoreFailure,
  describeRetention, estimatePrice, fetchRestorePlan, fetchRestoreProject, fetchRestoreProjects,
  finishRestore, measureClip, planRestore, rentalForLane, restoreCapabilities, restoreFailureLine,
  sourceTooLargeAdvice, startRestore, stopRestore, uploadRestoreSource,
} from '../lib/videoRestore.js';
import { RestoreCompare } from './restore/RestoreCompare.jsx';
import { RestoreFinish } from './restore/RestoreFinish.jsx';
import { RestoreProjects } from './restore/RestoreProjects.jsx';
import { RestoreSettings } from './restore/RestoreSettings.jsx';

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

  const panel = (
    <RestoreSettings
      lanes={lanes}
      selectedLane={lane}
      onSelectLane={setLane}
      price={price}
      cloudQuote={cloudQuote}
      settings={settings}
      onChange={setSettings}
      plan={plan}
      source={file ? source : null}
      busy={Boolean(busy) || Boolean(running)}
      onRemedy={(remedy) => void runFailureRemedy(remedy, { onRetry: () => { void reloadCapabilities(); } })}
    />
  );

  const composer = (
    <div className="flex flex-wrap items-center gap-2 p-3">
      <label className={cx(
        'inline-flex cursor-pointer items-center gap-2 rounded-lg border border-line1 bg-bg2 px-3 py-2 text-sm font-medium text-ink1 hover:bg-bg3',
        (busy || running) && 'pointer-events-none opacity-40',
      )}>
        <Icon name="upload" size={14} />
        {file ? file.name : 'Load a clip'}
        <input
          type="file"
          accept="video/*"
          className="hidden"
          onChange={(event) => { void attach(event.target.files?.[0]); event.target.value = ''; }}
        />
      </label>

      {file && source && !running ? (
        <>
          <Button
            icon="eye"
            onClick={() => start({ preview: true })}
            loading={busy === 'preview'}
            disabled={Boolean(busy) || !file || Boolean(tooLarge)}
            title="One chunk, from wherever the marker is — the cheap way to find out whether this model helps this footage"
          >
            Test {PREVIEW_SECONDS}s{hostedPrice(previewQuote)}
          </Button>
          <Button
            variant="primary"
            icon="wand"
            onClick={() => start({})}
            loading={busy === 'render'}
            disabled={Boolean(busy) || !file || Boolean(tooLarge)}
          >
            Restore {plan?.chunks?.length ? `${plan.chunks.length} chunks` : ''}{hostedPrice(cloudQuote)}
          </Button>
        </>
      ) : null}

      {running ? (
        <Button icon="stop" variant="danger" onClick={stop}>Stop</Button>
      ) : null}

      {project && !file && !running && project.status !== 'complete' ? (
        <Button icon="play" onClick={() => start({ projectId: project.id })} loading={busy === 'render'}>
          Resume from chunk {(project.progress?.chunks_done ?? Object.keys(project.chunks || {}).length) + 1}
        </Button>
      ) : null}

      {needsJoin ? (
        <Button variant="primary" icon="layers" onClick={joinAndFinish} loading={joining}>
          Join {Object.keys(project.chunks || {}).length} chunks and finish
        </Button>
      ) : null}

      {masterUrl && !running ? (
        <Button
          icon="download"
          onClick={() => downloadMedia(masterUrl, project.master)}
        >
          Download
        </Button>
      ) : null}
    </div>
  );

  return (
    <StudioLayout panel={panel} panelTitle="Restore" composer={composer}>
      <div className="flex min-h-0 flex-1 flex-col gap-4 p-4">
        {!source && !project ? (
          <EmptyState
            icon="film"
            title="Restore and upscale video, on your own machine"
            hint="SeedVR2 re-generates footage at a higher resolution and removes the compression mush on the way. Load a clip to see the plan; render a two-second test before committing to the whole thing."
          />
        ) : (
          <>
            {source && file && !project ? (
              <Card className="flex flex-wrap items-center gap-3 p-3">
                <Icon name="info" size={14} className="text-ink3" />
                <span className="text-xs text-ink2">
                  Preview from
                </span>
                <div className="min-w-[160px] flex-1">
                  <Slider
                    value={previewAt}
                    min={0}
                    max={Math.max(0, Math.floor((source.frames / source.fps) - PREVIEW_SECONDS))}
                    step={0.5}
                    onChange={setPreviewAt}
                    format={(value) => `${value.toFixed(1)}s`}
                  />
                </div>
                <span className="text-[11px] text-ink3">
                  Pick a shot with motion and detail — a static frame tells you very little.
                </span>
              </Card>
            ) : null}

            {/* The ceiling, stated on the card BEFORE the wait rather than as a
                refusal after it — and with the fix in the same sentence, which
                is the whole rule. */}
            {tooLarge ? (
              <FailureCallout title={tooLarge} />
            ) : null}

            {uploadPct !== null ? (
              <Card className="flex flex-col gap-2 p-3">
                <div className="flex items-center gap-2">
                  <Pill tone="honey" dot>Uploading</Pill>
                  <span className="text-xs text-ink2">{Math.round(uploadPct * 100)}% of the clip sent</span>
                </div>
                <ProgressBar value={uploadPct} />
                <p className="text-[11px] leading-snug text-ink3">
                  Streamed straight to the machine that will render it — nothing is copied into this tab, so
                  the size of the film is not the size of this page.
                </p>
              </Card>
            ) : null}

            {progress && running ? (
              <Card className="flex flex-col gap-2 p-3">
                <div className="flex items-center gap-2">
                  <Pill tone="honey" dot>Restoring</Pill>
                  <span className="text-xs text-ink2">
                    {progress.chunks_done} of {progress.chunks_total} chunks
                  </span>
                  <span className="ml-auto text-[11px] text-ink3">{describeEta(progress)}</span>
                </div>
                <ProgressBar value={progress.fraction} />
                {/* On the hosted lane, what has ACTUALLY been charged so far —
                    the sum of the invoices for the chunks that finished, not a
                    share of the estimate. It is the number that answers "what
                    happens if I stop now", which is the question the sentence
                    below is otherwise only half answering. */}
                {spentUsd > 0 ? (
                  <span className="text-[11px] text-ink2">
                    {spentUsd < 1 ? `${Math.round(spentUsd * 100)}¢` : `$${spentUsd.toFixed(2)}`} charged so far
                    {project?.spend?.approved_usd
                      ? ` of the $${Number(project.spend.approved_usd).toFixed(2)} you approved`
                      : ''}
                  </span>
                ) : null}
                <p className="text-[11px] leading-snug text-ink3">
                  Each finished chunk is saved before the next one starts, so stopping — or closing this tab —
                  costs you the chunk in flight and nothing else.
                  {retentionLine ? ` ${retentionLine}` : ''}
                </p>
              </Card>
            ) : null}

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

            {/* The comparison IS the screen. Inside a scrolling column `flex-1`
                stretches to nothing, so the height is stated: a restore judged
                in a 130px band is a restore nobody can judge. */}
            <RestoreCompare
              className="min-h-[46vh]"
              originalUrl={originalUrl}
              restoredUrl={restoredUrl}
              mode={mode}
              onModeChange={setMode}
              restoredLabel={project?.plan?.preview ? 'Preview' : 'Restored'}
            />
          </>
        )}

        <div className="grid gap-4 lg:grid-cols-2">
          {project ? (
            <RestoreFinish
              finish={finish}
              onChange={setFinish}
              onApply={applyFinish}
              busy={busy === 'finish' || joining}
              disabled={!project || running}
              assemblesHere={assemblesHere}
            />
          ) : <div />}
          <RestoreProjects
            projects={projects}
            activeId={project?.id}
            onOpen={open}
            onResume={(summary) => start({ projectId: summary.id })}
            onDelete={setConfirmDelete}
            busy={Boolean(busy) || Boolean(running)}
            retention={retentionLine}
          />
        </div>
      </div>

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
    </StudioLayout>
  );
}
