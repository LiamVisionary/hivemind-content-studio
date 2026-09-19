// Music Studio — local text-to-music with ACE-Step 1.5 Turbo.
//
// The shape of the thing: describe the sound, optionally write the words, press
// one button, hear it. Everything else is a consequence of that sentence.
//
// WHY IT IS NOT TABBED. A tabbed studio writes a per-tab snapshot of its
// composer into sessionStorage so a reload finds it again (lib/studioTabs.js),
// and lyrics are as private as a prompt — they are the one thing in this studio
// somebody might genuinely not want written to disk in the clear. One mount,
// no snapshot, nothing persisted: the smallest correct answer, and the one that
// cannot regress into a privacy bug when a field is added later.
//
// WHY THE AUDIO IS STOPPED BY HAND. App.jsx never unmounts a studio — it
// display-toggles it, so a four-minute render survives a tab switch. A playing
// <audio> survives it too, which means navigating to Image would leave music
// coming out of a page nobody is looking at. The effect on `active` is what
// stops that, and it is the only reason this component holds a ref to the
// element at all.
//
// THE GATEWAY WEIGHTS THE PASSES, NOT THIS FILE — see lib/musicLane.js. What
// arrives on the record is already a whole-job, already-monotonic percent and
// the phase's own name, so the bar reads it straight: elapsed time carries it
// until the engine counts its first step, and from then on the real fraction
// drives it through genProgress.computeSmoothProgress's anchor — the same way
// the Image studio stops a short estimate from pinning the bar at its cap.
//
// This render mounts four surfaces: music/MusicStage.jsx (the player),
// music/MusicComposer.jsx (the two text fields and the sentence),
// music/MusicRail.jsx (this session's tracks) and music/MusicSettings.jsx (the
// drawer).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'react-hot-toast';

import { WorkflowDependencyPrompt } from '../components/WorkflowDependencyPrompt.jsx';
import { useMediaSealFailure, useMediaSrc } from '../hooks/hooks.js';
import { describeFailure } from '../lib/describeFailure.js';
import { downloadMedia } from '../lib/downloadMedia.js';
import { mediaDownloadName } from '../lib/downloadNames.js';
import { runFailureRemedy } from '../lib/failureRemedy.js';
import { registerMediaDownloadName } from '../lib/e2eMedia.js';
import {
  computeSmoothProgress, estimateGenerationSeconds, formatElapsed, recordGenerationSeconds,
} from '../lib/genProgress.js';
import { localAI } from '../lib/localInferenceClient.js';
import {
  MUSIC_TERMINAL, clampSeconds, defaultMusicModel, defaultMusicSetup, defaultSectionPlan,
  fetchMusicJob, foldMusicProgress, formatTrackLength, listMusicModels, musicCountedFraction,
  musicLicenceLine, musicUsageRestriction, musicOutputUrl, musicPhaseLabel, musicQueueNote,
  musicReadiness, musicRequest,
  musicTimingProfile, newMusicProgress, sectionPlanLyrics, startMusicJob, usesSectionPlan,
} from '../lib/musicLane.js';
import { fetchMusicRecipes } from '../lib/musicRecipes.js';
import { checkWorkflowDependencies, dependenciesBlockGeneration } from '../lib/workflowDependencies.js';
import { FailureCallout, LoadingState } from '../ui/kit.jsx';
import { StageAction } from './frame/Stage.jsx';
import { StudioFrame } from './frame/StudioFrame.jsx';
import { MusicComposer } from './music/MusicComposer.jsx';
import { MusicRail } from './music/MusicRail.jsx';
import { MusicSettings } from './music/MusicSettings.jsx';
import { MusicStage, MusicStageEmpty } from './music/MusicStage.jsx';

// Fast enough that the two passes are visibly distinct, slow enough that a
// ten-minute track is not a thousand requests. The image lane polls at 600/1200.
const POLL_MS = 1200;

// Where a bar with no real signal behind it stops. Until the engine reports a
// counted step the bar is a pure guess, and the first render of all is the one
// guess that is always wrong — it loads a 10 GB checkpoint the registry's warm
// benchmark never paid for. Stopping short leaves the real signal somewhere to
// take over; running to the cap first would freeze it there for good, because
// the bar is monotonic and nothing may move it back down.
const GUESS_CAP = 0.9;

export function MusicStudio({ active = true }) {
  const [catalog, setCatalog] = useState({ models: [], status: 'loading', error: null });
  const [model, setModel] = useState(null);
  const [setup, setSetup] = useState(() => defaultMusicSetup(null));
  const [prompt, setPrompt] = useState('');
  const [lyrics, setLyrics] = useState('');
  const [lyricsOpen, setLyricsOpen] = useState(false);
  const [recipesOpen, setRecipesOpen] = useState(false);
  // Read the first time the door is opened, not at mount: the library lives on
  // the studio's own API, and a person who never opens it never asks for it. An
  // answer that did not arrive is asked for again on the next open.
  const [recipeBook, setRecipeBook] = useState(null);
  useEffect(() => {
    if (!recipesOpen || (recipeBook && recipeBook.status === 'ready')) return undefined;
    let current = true;
    void fetchMusicRecipes().then((answer) => { if (current) setRecipeBook(answer); });
    return () => { current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recipesOpen]);
  // What an instrumental lane reads where another reads lyrics: a section order
  // and how hard to steer with it. Kept beside `lyrics` rather than in it, so a
  // swap to a singing model and back loses neither.
  const [plan, setPlan] = useState(() => defaultSectionPlan());
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // What this tab has made, newest first. Session-only on purpose: the Library
  // is the Library, and a rail that outlived the tab would need the prompt
  // written somewhere to label its rows.
  const [tracks, setTracks] = useState([]);
  const [activeId, setActiveId] = useState('');
  const [run, setRun] = useState(null); // { id, startedAt, seconds, title, instrumental }
  const [progress, setProgress] = useState(() => newMusicProgress());
  const [display, setDisplay] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [failure, setFailure] = useState(null);
  const [dependencyReport, setDependencyReport] = useState(null);
  const [dependencyPromptOpen, setDependencyPromptOpen] = useState(false);
  const audioRef = useRef(null);
  // One run owns the studio at a time, and the token says which. Every poll loop
  // captures the token it was started under and dies the moment a newer run — or
  // a Stop — moves it on. A single `cancelledRef` holding one job id could not
  // do that: the loop only reads it once every POLL_MS, so a generate started
  // inside that window wiped the stopped run's cancellation before its loop ever
  // saw it, and the abandoned render then finished over the top of the new one.
  const runTokenRef = useRef(0);
  // Claimed synchronously at the press, because `run` is React state and the
  // POST before it is awaited. It is the guard the button and ⌘↵ actually read.
  const busyRef = useRef(false);
  // The bar's own last value, so a tick can anchor to it without reading state
  // it has just written, and the first real fraction of the run.
  const displayRef = useRef(0);
  const anchorRef = useRef(null);

  /* ---------------- the catalogue ---------------- */

  // The composer is seeded from the row exactly ONCE. Every later fetch — a
  // "Check again", the re-check after a 10 GB install — has to leave the dials
  // where the person left them, and the row's own defaults would otherwise walk
  // back over a tempo somebody had just chosen.
  const seeded = useRef(false);
  // A model the PERSON picked outlives the next fetch. loadCatalog runs again on
  // "Check again" and after a 10 GB install finishes, and re-deriving the
  // default row each time would silently drag them back to ACE-Step in the
  // middle of setting up a YuE2 track.
  const pickedId = useRef('');
  const loadCatalog = useCallback(async () => {
    const answer = await listMusicModels();
    const kept = pickedId.current
      ? answer.models.find((row) => row.id === pickedId.current)
      : null;
    const chosen = kept || defaultMusicModel(answer.models);
    setCatalog(answer);
    setModel(chosen);
    if (chosen && !seeded.current) {
      seeded.current = true;
      setSetup(defaultMusicSetup(chosen));
    }
  }, []);

  // Switching model re-seeds the dials, because the two rows do not take the
  // same ones: ACE-Step has bpm, key, time signature and language; YuE2 has a
  // score mode and none of those. Length is the one control worth carrying
  // across — it is what people set first — and only when the new row allows it.
  // A length nobody set is not one to carry, though: it is the OLD row's
  // suggestion, and ACE-Step's one minute shares an instrumental's six sections
  // out at six seconds apiece. So a length still sitting on the old row's
  // default gives way to the new row's.
  const chooseModel = useCallback((next) => {
    if (!next || next.id === pickedId.current) return;
    pickedId.current = next.id;
    const previousDefault = defaultMusicSetup(model).seconds;
    setModel(next);
    setSetup((current) => {
      const fresh = defaultMusicSetup(next);
      const untouched = current?.seconds == null || current.seconds === previousDefault;
      const seconds = untouched ? fresh.seconds : clampSeconds(next, current.seconds);
      return { ...fresh, seconds };
    });
  }, [model]);

  useEffect(() => { void loadCatalog(); }, [loadCatalog]);

  /* ---------------- the preflight ---------------- */

  // What the lane lacks for this workflow, asked once the row is known. It is
  // NOT opened as a modal on arrival: nobody picked this lane — a route landed
  // on it — so a refusal here is answered by the stage saying what is missing
  // and offering the install, which is the same rule the Image studio follows.
  const dependencyWorkflowId = String(model?.id || '');
  useEffect(() => {
    if (!dependencyWorkflowId) return;
    let alive = true;
    void checkWorkflowDependencies(localAI, { workflowId: dependencyWorkflowId })
      .then((report) => { if (alive) setDependencyReport(report); })
      .catch(() => { /* a lane that cannot be asked is not a lane that is missing things */ });
    return () => { alive = false; };
  }, [dependencyWorkflowId]);

  const openDependencyPrompt = useCallback(async ({ force = false } = {}) => {
    if (!dependencyWorkflowId) return;
    try {
      const report = await checkWorkflowDependencies(localAI, { workflowId: dependencyWorkflowId, force });
      setDependencyReport(report);
      setDependencyPromptOpen(force || dependenciesBlockGeneration(report));
    } catch {
      // Asking failed; the studio keeps working and the press will say why.
    }
  }, [dependencyWorkflowId]);

  /* ---------------- rendering a track ---------------- */

  const readiness = musicReadiness(model);
  const missing = dependenciesBlockGeneration(dependencyReport);
  const generating = Boolean(run);
  // What the COMPOSER is currently describing — the next track, not the one on
  // the bar. A render in flight quotes the estimate captured at its own press
  // (`run.estimateSeconds`), so changing the length token mid-render can never
  // make a finished render look overdue.
  const timing = musicTimingProfile(model, setup);
  const composerEstimate = Math.round(
    estimateGenerationSeconds(timing.key, timing.work, timing.fallbackRate) || 0,
  );
  const estimateSeconds = run ? run.estimateSeconds : composerEstimate;

  const poll = useCallback(async (jobId, startedAt, token) => {
    let folded = newMusicProgress();
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      if (runTokenRef.current !== token) return null;
      let job;
      try {
        job = await fetchMusicJob(jobId);
      } catch (error) {
        // One refused poll is a blip, not a failed render — the job is running
        // on this machine whatever this tab can reach. Only a terminal record
        // or a cancel ends the loop.
        if (Date.now() - startedAt > 10 * 60 * 1000) throw error;
        continue;
      }
      if (runTokenRef.current !== token) return null;
      folded = foldMusicProgress(folded, job);
      setProgress(folded);
      setElapsedMs(Date.now() - startedAt);
      if (MUSIC_TERMINAL.has(String(job.status))) return job;
    }
  }, []);

  const generate = async () => {
    // busyRef, not `generating`: `run` is state and the POST below is awaited,
    // so for the whole round trip the button is still enabled and ⌘↵ still
    // armed. A second press there starts a second render on a machine with one
    // GPU slot, and the older job then lands on the stage after the newer one.
    if (!model || busyRef.current) return;
    const style = prompt.trim();
    if (!style) {
      toast.error('Describe the sound you want first — the style line is what the model listens to.');
      return;
    }
    if (missing) { void openDependencyPrompt({ force: true }); return; }
    busyRef.current = true;
    const token = runTokenRef.current + 1;
    runTokenRef.current = token;
    setFailure(null);
    setProgress(newMusicProgress());
    anchorRef.current = null;
    displayRef.current = 0;
    setDisplay(0);
    setElapsedMs(0);
    const seconds = clampSeconds(model, setup.seconds);
    // A lane that reads a section plan is sent the plan, assembled at the press
    // from the same track length the request carries, and is an instrumental by
    // construction — whatever is sitting in the lyrics box belongs to a model
    // that sings.
    const planned = usesSectionPlan(model);
    const words = planned ? sectionPlanLyrics(model, plan, setup.seconds) : lyrics;
    const instrumental = planned || !lyrics.trim();
    // Snapshotted at the press, with the request. Everything the stage says
    // about this render is read from here rather than from the live composer.
    const profile = musicTimingProfile(model, setup);
    const startedAt = Date.now();
    setRun({
      id: '',
      startedAt,
      seconds,
      title: style,
      instrumental,
      estimateSeconds: composerEstimate,
      timingKey: profile.key,
      timingWork: profile.work,
    });
    let queued;
    try {
      queued = await startMusicJob(musicRequest(model, setup, { prompt: style, lyrics: words }));
    } catch (error) {
      if (runTokenRef.current !== token) return;
      busyRef.current = false;
      setRun(null);
      setFailure(describeFailure(error, { transport: 'local', operation: 'The track' }));
      return;
    }
    // Stopped, or replaced, while the POST was in flight.
    if (runTokenRef.current !== token) return;
    setRun((previous) => (previous ? { ...previous, id: queued.id } : previous));
    let job;
    try {
      job = await poll(queued.id, startedAt, token);
    } catch (error) {
      if (runTokenRef.current !== token) return;
      busyRef.current = false;
      setRun(null);
      setFailure(describeFailure(error, { transport: 'local', operation: 'The track' }));
      return;
    }
    // A loop that lost the studio (Stop, or a newer render) touches nothing:
    // clearing `run` here is how an abandoned job used to take the progress bar
    // and the Stop button away from the render that replaced it.
    if (runTokenRef.current !== token) return;
    busyRef.current = false;
    setRun(null);
    if (!job) return; // stopped from the stage
    if (job.status !== 'success') {
      setFailure(describeFailure(new Error(job.error || 'The render stopped before it finished.'), {
        transport: 'local', operation: 'The track',
      }));
      return;
    }
    const url = musicOutputUrl(job);
    if (!url) {
      setFailure(describeFailure(new Error('The render finished without an audio file.'), { operation: 'The track' }));
      return;
    }
    const elapsedSeconds = Number(job.elapsed_seconds) || Math.round((Date.now() - startedAt) / 1000);
    // What this machine actually took, against the profile the press quoted. The
    // registry's benchmark is one warm measurement on one Mac; from here on the
    // estimate is this machine's own, which is the only way the first cold render
    // (10 GB of checkpoint included) stops being quoted at every later one.
    recordGenerationSeconds(profile.key, profile.work, elapsedSeconds);
    const track = {
      id: job.id || queued.id,
      url,
      title: style,
      seconds,
      instrumental,
      model: model.name,
      elapsedSeconds,
    };
    // The name the file is saved under, registered against the URL rather than
    // against one button: resolveMediaSrc mints the decrypted object URL from a
    // named File when it knows one, so the <audio> element's own download
    // control and "Save this track" produce the same filename instead of a UUID.
    registerMediaDownloadName(url, mediaDownloadName(track.model, track.id, 'mp3', { fallback: 'track' }));
    setTracks((previous) => [track, ...previous]);
    setActiveId(track.id);
  };

  // Stopping is a client-side stop: this host has no cancel route for a music
  // job, so the poll ends here and the gateway finishes on its own. Saying that
  // plainly beats a button that claims to have killed a render it did not.
  const stop = () => {
    if (!run) return;
    // Moving the token on is what ends the loop. It is read every tick AND
    // either side of the fetch, so the stopped run can no longer write the
    // stage, the rail or the selection — whenever it finishes on the machine.
    runTokenRef.current += 1;
    busyRef.current = false;
    setRun(null);
    toast('Stopped watching. The render finishes on this machine and the track lands in your Library.');
  };

  /* ---------------- the bar ---------------- */

  // Elapsed time carries it until the engine counts; the real fraction takes
  // over from there. See the header, and lib/musicLane.js for who weights what.
  useEffect(() => {
    if (!run) return undefined;
    const tick = () => {
      const real = musicCountedFraction(progress);
      // Where the bar stood when the first counter landed. From here the
      // remaining real work is mapped onto the remaining bar, so an estimate
      // that was too short stops driving and the render's own position does.
      if (!anchorRef.current && real > 0 && real < 1) {
        anchorRef.current = { display: displayRef.current, real };
      }
      setElapsedMs(Date.now() - run.startedAt);
      const next = computeSmoothProgress({
        elapsedSec: (Date.now() - run.startedAt) / 1000,
        estimateSec: run.estimateSeconds,
        realFraction: real,
        realAnchor: anchorRef.current,
        prevDisplay: displayRef.current,
      });
      const value = anchorRef.current ? next : Math.min(next, GUESS_CAP);
      displayRef.current = value;
      setDisplay(value);
    };
    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [run, progress]);

  /* ---------------- the player ---------------- */

  const activeTrack = tracks.find((track) => track.id === activeId) || tracks[0] || null;
  const trackSrc = useMediaSrc(activeTrack?.url || '');
  const trackSealed = useMediaSealFailure(activeTrack?.url || '');

  // A studio is hidden, never unmounted. Music that keeps playing behind the
  // Image studio is the obvious failure mode, so leaving the page pauses it.
  useEffect(() => {
    if (active) return;
    try { audioRef.current?.pause(); } catch { /* no element yet */ }
  }, [active]);

  // A different track on the stage starts from its own beginning rather than
  // from wherever the last one was.
  useEffect(() => {
    const element = audioRef.current;
    if (!element) return;
    try { element.currentTime = 0; } catch { /* not seekable yet */ }
  }, [activeId]);

  /* ---------------- what is on screen ---------------- */

  const licence = musicLicenceLine(model);
  const restriction = musicUsageRestriction(model);
  const blocked = !model || generating || catalog.status !== 'ready';

  const emptyStage = useMemo(() => {
    if (catalog.status === 'loading') return <LoadingState label="Looking for the music models on this machine" />;
    if (catalog.status === 'unreachable') {
      return (
        <MusicStageEmpty
          title="The studio's model bridge is not answering"
          hint="Music is rendered by the engine this app runs beside. Once it is back, this page finds it on its own — or press Try again below."
          install={{ label: 'Try again', onClick: () => void loadCatalog() }}
        />
      );
    }
    if (catalog.status === 'empty') {
      return (
        <MusicStageEmpty
          title="No music model is registered on this machine"
          hint="Music lanes come from the studio's workflow registry. Nothing in it makes audio yet, so there is nothing to render with."
        />
      );
    }
    if (readiness?.reason === 'missing-weights' || missing) {
      const bytes = Number(dependencyReport?.missing_bytes) || 0;
      const size = bytes > 0 ? ` It is a ${(bytes / 1e9).toFixed(1)} GB download, once.` : '';
      return (
        <MusicStageEmpty
          title={readiness?.title || `${model?.name || 'This model'} needs its checkpoint before it can play anything.`}
          hint={`Press below and it downloads here, in this page, with a progress bar you can cancel.${size}`}
          install={{ label: 'Download it now', onClick: () => void openDependencyPrompt({ force: true }) }}
          licence={licence}
        />
      );
    }
    if (readiness?.reason === 'engine-offline') {
      return (
        <MusicStageEmpty
          title={readiness.title}
          hint="It comes back with the rest of the studio's services. Check again once it has."
          install={{ label: 'Check again', onClick: () => void loadCatalog() }}
        />
      );
    }
    // Not the model's own description: it already ends with the licence
    // sentence printed under it, and saying the same thing twice on an empty
    // page reads as a page with nothing to say.
    return (
      <MusicStageEmpty
        title="Describe a song and press the button"
        hint={usesSectionPlan(model)
          ? 'Write the style below — genre, instruments, mood, tempo. This model plays rather than sings: open Structure to choose the order of its sections, or leave that to it.'
          : 'Write the style below — instruments, feel, production, mood. Add lyrics to have it sung, or leave them empty for an instrumental.'}
        licence={licence}
      />
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog.status, readiness?.reason, missing, dependencyReport, model, licence]);

  // The gateway's own word for the pass that is running — including the one it
  // uses while a job is still waiting for the accelerator. Inferring the name
  // from a change in the step count named the wrong pass outright whenever
  // "Write audio codes first" was switched off in Advanced.
  const phaseLabel = musicPhaseLabel(progress);
  const queueNote = musicQueueNote(progress);
  const stepText = queueNote ? '' : (progress.steps ? `step ${progress.step} of ${progress.steps}` : '');
  const remainingText = estimateSeconds > 0
    ? `${formatElapsed(elapsedMs)} of about ${formatElapsed(estimateSeconds * 1000)}`
    : formatElapsed(elapsedMs);
  // An estimate that has been overtaken is worth saying out loud rather than
  // leaving a pinned bar to imply a hang. The first render is the one that
  // always overruns: it loads the checkpoint the benchmark never measured.
  const overtime = Boolean(run) && estimateSeconds > 0 && elapsedMs > (estimateSeconds + 5) * 1000;
  const stageNote = queueNote
    || (overtime
      ? 'Longer than the estimate. The first render of a session also loads the model, which the estimate does not measure — this machine\u2019s own timings replace it after one finished track.'
      : estimateSeconds > 0
        ? `About ${formatElapsed(estimateSeconds * 1000)} is an estimate, scaled from this model\u2019s measured run.`
        : '');

  const drawer = (
    <MusicSettings
      model={model}
      setup={setup}
      onSetup={setSetup}
      licence={licence}
      runsOn="This Mac"
      disabled={generating}
    />
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <StudioFrame
        railWidth={96}
        drawerTitle="Advanced"
        drawerOpen={advancedOpen}
        onDrawerToggle={() => setAdvancedOpen((open) => !open)}
        onDrawerClose={() => setAdvancedOpen(false)}
        drawer={drawer}
        notices={(
          <>
            {failure ? (
              <FailureCallout
                title={failure.title}
                detail={failure.detail}
                remedy={failure.remedy}
                onRemedy={(remedy) => void runFailureRemedy(remedy, {
                  onInstallDependencies: () => void openDependencyPrompt({ force: true }),
                  onRetry: () => void generate(),
                })}
                onDismiss={() => setFailure(null)}
              />
            ) : null}

            {dependencyPromptOpen && dependencyReport && dependencyWorkflowId ? (
              <WorkflowDependencyPrompt
                report={dependencyReport}
                workflowId={dependencyWorkflowId}
                onReport={(report) => {
                  setDependencyReport(report);
                  // Weights that just landed change the row's own verdict, and
                  // the stage reads that rather than the report.
                  if (report?.ok) void loadCatalog();
                }}
                onRemedy={(remedy) => void runFailureRemedy(remedy, {})}
                onClose={() => setDependencyPromptOpen(false)}
              />
            ) : null}
          </>
        )}
        stageActions={activeTrack && trackSrc && !generating ? (
          <StageAction
            icon="download"
            label="Save this track"
            onClick={() => void downloadMedia(
              activeTrack.url,
              mediaDownloadName(activeTrack.model, activeTrack.id, 'mp3', { fallback: 'track' }),
            )}
          />
        ) : null}
        stage={(
          <MusicStage
            busy={generating}
            title={run?.title || activeTrack?.title || ''}
            src={generating ? '' : trackSrc}
            lengthText={formatTrackLength(run?.seconds ?? activeTrack?.seconds ?? setup.seconds)}
            metaText={activeTrack ? `${activeTrack.model} · rendered in ${formatElapsed(activeTrack.elapsedSeconds * 1000)}` : ''}
            instrumental={Boolean(run ? run.instrumental : activeTrack?.instrumental)}
            audioRef={audioRef}
            sealed={trackSealed || ''}
            phase={phaseLabel}
            percent={display * 100}
            subject={stepText}
            timing={remainingText}
            note={stageNote}
            restriction={restriction}
            onCancel={stop}
            empty={emptyStage}
          />
        )}
        rail={(
          <MusicRail
            tracks={tracks}
            activeId={activeTrack?.id || ''}
            onOpen={(track) => setActiveId(track.id)}
          />
        )}
        composer={(
          <MusicComposer
            model={model}
            models={catalog.models || []}
            onModel={chooseModel}
            setup={setup}
            onSetup={setSetup}
            prompt={prompt}
            onPrompt={setPrompt}
            lyrics={lyrics}
            onLyrics={setLyrics}
            plan={plan}
            onPlan={setPlan}
            lyricsOpen={lyricsOpen}
            // One card over the prompt at a time: opening either door shuts the other.
            onToggleLyrics={() => { setRecipesOpen(false); setLyricsOpen((open) => !open); }}
            recipesOpen={recipesOpen}
            recipeBook={recipeBook}
            onToggleRecipes={() => { setLyricsOpen(false); setRecipesOpen((open) => !open); }}
            onGenerate={() => void generate()}
            generating={generating}
            blocked={blocked}
            generateTitle={missing
              ? 'This model needs its checkpoint first — press it and the download starts here.'
              : 'Render the track on this machine'}
            metaLabel={composerEstimate > 0 ? `~${formatElapsed(composerEstimate * 1000)} · free` : ''}
            metaTitle="An estimate for these exact settings — this machine's own timings once it has finished one track, and the model's measured run before that."
            // The rail above, as a door in the composer: below 640px the rail is
            // not on screen, and a track this session already made is only
            // reachable from here.
            tracks={tracks}
            activeTrackId={activeTrack?.id || ''}
            onOpenTrack={(track) => setActiveId(track.id)}
          />
        )}
      />
    </div>
  );
}
