// Sprite Studio — sprite still → animation → key frames → sprite sheet.
//
// The pipeline is the one that actually works, not the one that sounds tidy:
// generate (or upload) a sprite, animate it with MiniMax H3, pull the distinct
// poses out of that clip, cut the background off each of them, pack a sheet.
// Every stage is a separate, resumable step with its own output on screen,
// because each one can be wrong in a way you only see by looking at it — a
// clip where the camera drifted, a matte that kept the butterfly, a sheet
// whose cells are mis-centred. Chaining them into one button would hide the
// stage that failed behind four minutes of spinner.
//
// Where the work happens, and why:
//   sprite     — the existing image engines (local bridge / MUAPI), picked
//                through the capability matrix rather than the full catalog.
//   animation  — generateHivemindVideo, the same path the Video studio uses.
//   key frames — entirely in this browser, on a clip it is already playing.
//                No frame is uploaded to be sampled.
//   matte      — the one server round-trip: SAM3 by name, one frame at a time.
//   sheet      — canvas. The PNG and the atlas are made here and handed to the
//                user; nothing plaintext is written down on the way.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'react-hot-toast';

import { useMediaSrc } from '../hooks/hooks.js';
import { defaultPick, EVIDENCE_LABELS, fetchCapabilityMatrix, rankModels, RATING_LABELS, serverRows } from '../lib/capabilityMatrix.js';
import { isHivemindStudioEnabled, mediaSourceToDataUrl } from '../lib/hivemindStudio.js';
import { isLocalAIAvailable } from '../lib/localInferenceClient.js';
import { needsBrowserKey, runImage, runVideo, transportFor } from '../lib/modelRunner.js';
import { useLocalImageCatalog } from '../lib/useLocalCatalog.js';
import { promoteOutputToReference } from '../lib/outputToReference.js';
import { registerPromptInserter } from '../app/promptTarget.js';
import { Icon } from '../ui/icons.jsx';
import { toastFailure } from '../ui/failureToast.jsx';
import { Modal } from '../ui/Modal.jsx';
import {
  Button, Card, EmptyState, Field, NativeSelect, Pill, ProgressBar, SectionLabel, Segmented, Slider,
  Spinner, StudioLayout, TextArea, cx,
} from '../ui/kit.jsx';
import { LocalCatalogNotice } from './LocalCatalogNotice.jsx';
import { ModelFitPicker, RATING_TONE } from './ModelFitPicker.jsx';
import { UploadPicker } from './UploadPicker.jsx';
import { AuthModal } from '../dialogs/AuthModal.jsx';

import { extractKeyFrames } from './sprite/spriteFrames.js';
import { matteFrames } from './sprite/spriteMatte.js';
import { animationChoices, animationRow, SPRITE_CLIP_TRANSPORTS } from './sprite/spriteRouting.js';
import {
  matteSubjectFrom, spriteAnimationPrompt, spriteImagePrompt,
  SPRITE_ACTIONS, SPRITE_BACKGROUNDS, SPRITE_EXAMPLE, SPRITE_STYLES,
} from './sprite/spritePrompt.js';
import { packSpriteSheet } from './sprite/spriteSheet.js';

const STAGES = [
  { id: 'sprite', label: 'Sprite', icon: 'image' },
  { id: 'animate', label: 'Animation', icon: 'film' },
  { id: 'frames', label: 'Key frames', icon: 'layers' },
  { id: 'sheet', label: 'Sheet', icon: 'grid' },
];

// A sprite is square. The whole point of the frame is the character, and a 16:9
// canvas spends two thirds of every generated pixel on background that is about
// to be cut away.
const SPRITE_ASPECT = '1:1';

function canvasToBlob(canvas) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoked on the next tick: revoking synchronously races the download in
  // Safari and hands the user a zero-byte file.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function StageHeader({ index, stage, done, children }) {
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
      <div className="ml-auto flex items-center gap-2">{children}</div>
    </div>
  );
}

function SpritePreview({ url, alt }) {
  const src = useMediaSrc(url);
  if (!src) return null;
  return (
    <img
      src={src}
      alt={alt}
      // Nearest-neighbour so a 512px sprite preview shows the pixels it has
      // rather than a browser's idea of a smooth upscale.
      style={{ imageRendering: 'pixelated' }}
      className="max-h-64 rounded-md border border-line1 bg-[repeating-conic-gradient(#0000_0_25%,#8883_0_50%)_50%/16px_16px]"
    />
  );
}

function ClipPreview({ url }) {
  const src = useMediaSrc(url);
  if (!src) return null;
  // controlsList=nodownload: Chrome names a blob: download from the URL's UUID
  // and ignores the File's name, so a native download could never agree with
  // ours. The studio keeps exactly one download path — see downloadNames.js.
  // eslint-disable-next-line jsx-a11y/media-has-caption
  return (
    <video
      src={src}
      controls
      controlsList="nodownload"
      loop
      muted
      playsInline
      className="max-h-64 rounded-md border border-line1"
    />
  );
}

export function SpriteStudio({ active = true } = {}) {
  const [matrix, setMatrix] = useState(null);
  const [matrixError, setMatrixError] = useState('');
  const [matrixOpen, setMatrixOpen] = useState(false);
  // What this machine can actually run, and why the list is empty when it is.
  const { models: localModels, status: localStatus, refresh: refreshLocalCatalog } = useLocalImageCatalog();

  // Stage 1 — the sprite
  const [subject, setSubject] = useState('');
  const [style, setStyle] = useState('16bit');
  const [background, setBackground] = useState('chroma');
  const [imageModel, setImageModel] = useState(null);
  const [spriteUrl, setSpriteUrl] = useState('');
  const [drawing, setDrawing] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);

  // Stage 2 — the animation
  const [action, setAction] = useState('idle');
  const [customBeat, setCustomBeat] = useState('');
  const [customAction, setCustomAction] = useState('');
  const [soundscape, setSoundscape] = useState('');
  const [seconds, setSeconds] = useState(5);
  const [videoModel, setVideoModel] = useState(null);
  const [promptOverride, setPromptOverride] = useState('');
  const [clipUrl, setClipUrl] = useState('');
  const [animating, setAnimating] = useState(false);
  const [animationProgress, setAnimationProgress] = useState(null);

  // Stage 3 — the key frames
  const [frameCount, setFrameCount] = useState(8);
  const [frames, setFrames] = useState([]);
  const [extracting, setExtracting] = useState(false);
  const [extractProgress, setExtractProgress] = useState('');

  // Stage 4 — the sheet
  const [matteSubject, setMatteSubject] = useState('');
  const [columns, setColumns] = useState(0);
  const [cellSize, setCellSize] = useState(0);
  // A sprite cycle is played at its own rate, not the source clip's: eight poses
  // sampled out of five seconds would crawl at 1.6 fps. Twelve is the ordinary
  // hand-animation rate and the one most engines default to.
  const [sheetFps, setSheetFps] = useState(12);
  const [sheet, setSheet] = useState(null);
  const [packing, setPacking] = useState(false);
  const [packProgress, setPackProgress] = useState('');

  const abortRef = useRef(null);
  const frameStripRef = useRef(null);
  const sheetHostRef = useRef(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  // The prompt-insert bridge (explore dock, prompt helper) targets the sprite
  // description while this studio is the visible one — the same contract every
  // other studio registers.
  useEffect(() => {
    if (!active) return undefined;
    return registerPromptInserter((text) => {
      setSubject((current) => (current.trim() ? `${current.replace(/\s*$/, '')}\n${text}` : text));
    });
  }, [active]);

  // The verdicts, once. A studio that cannot read them still works — every
  // picker falls back to "untried here", which is the honest thing to say.
  useEffect(() => {
    let alive = true;
    fetchCapabilityMatrix()
      .then((payload) => { if (alive) setMatrix(payload); })
      .catch(() => { if (alive) setMatrixError('Could not read the capability matrix — models are listed unrated.'); });
    return () => { alive = false; };
  }, []);

  const imageChoices = useMemo(() => {
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
    const cloud = serverRows(matrix, 'sprite_source').map((row) => ({
      ...row,
      id: row.model,
      label: row.model_label,
      providerLabel: row.provider_label,
      source: 'cloud',
    }));
    // A row also has to be one this studio can route — see modelRunner.js.
    return rankModels(matrix, 'sprite_source', [...local, ...cloud]).map((row) => {
      const route = transportFor(row);
      return { ...row, available: row.available !== false && route.runnable, unavailableReason: route.reason };
    });
  }, [matrix, localModels]);

  const videoChoices = useMemo(() => {
    if (!matrix) return [];
    // Rated by the matrix, then marked with whether THIS stage can reach the
    // row — see spriteRouting.js. A cloud row the stage cannot send the sprite
    // to is shown with its reason, not offered as a job that fails locally.
    return animationChoices(rankModels(matrix, 'sprite_animation', serverRows(matrix, 'sprite_animation')
      .map((row) => ({ ...row, id: row.model, label: row.model_label, providerLabel: row.provider_label, source: 'cloud' }))));
  }, [matrix]);

  // The row's own reason, on the row. The image picker keeps its readiness
  // where the credential lives; the animation picker only has to say which
  // rows this stage cannot send the sprite to.
  const animationReadiness = useCallback((row) => (
    row.available === false && row.unavailableReason
      ? { state: 'unroutable', label: 'Cannot run here', detail: row.unavailableReason, action: null, blocks: true }
      : null
  ), []);

  useEffect(() => { if (!imageModel && imageChoices.length) setImageModel(defaultPick(imageChoices)); }, [imageChoices, imageModel]);
  useEffect(() => { if (!videoModel && videoChoices.length) setVideoModel(defaultPick(videoChoices)); }, [videoChoices, videoModel]);

  const animationPrompt = useMemo(() => (
    promptOverride || spriteAnimationPrompt({ subject, style, action, customBeat, customAction, background, soundscape })
  ), [promptOverride, subject, style, action, customBeat, customAction, background, soundscape]);

  const loadExample = useCallback(() => {
    setSubject(SPRITE_EXAMPLE.subject);
    setStyle(SPRITE_EXAMPLE.style);
    setBackground(SPRITE_EXAMPLE.background);
    setAction(SPRITE_EXAMPLE.action);
    setCustomBeat(SPRITE_EXAMPLE.customBeat);
    setCustomAction(SPRITE_EXAMPLE.customAction);
    setSoundscape(SPRITE_EXAMPLE.soundscape);
    setPromptOverride('');
    toast('Loaded the dragon that this feature was built against.');
  }, []);

  /* ---------------- stage 1: draw the sprite ---------------- */

  const drawSprite = async () => {
    const prompt = spriteImagePrompt({ subject, style, background });
    if (!prompt) { toast.error('Describe the sprite first.'); return; }
    if (!imageModel) { toast.error('Pick a model to draw it with.'); return; }
    // Only the MUAPI key lives in this browser; every other credential is
    // checked where it actually is. Asking for a MUAPI key because a model is
    // "not local" was how an OpenAI OAuth pick opened the wrong dialog.
    if (needsBrowserKey(imageModel)) {
      setAuthOpen(true);
      return;
    }
    setDrawing(true);
    try {
      const result = await runImage({ row: imageModel, shared: { prompt, aspect_ratio: SPRITE_ASPECT, seed: -1 } });
      if (!result?.url) throw new Error('No sprite came back.');
      setSpriteUrl(result.url);
      // Promoted to a persistent reference so the animation stage can hand it
      // to the video lane the same way any other start frame gets there.
      const reference = await promoteOutputToReference(result.url, { kind: 'image', name: 'sprite.png' })
        .catch(() => '');
      if (reference) setSpriteUrl(reference);
      if (!matteSubject) setMatteSubject(matteSubjectFrom(subject));
    } catch (error) {
      console.warn('[SpriteStudio] sprite generation failed:', error?.message || error);
      // The studio route answers "<Provider>: <the provider's own exception>";
      // describeFailure turns that into a sentence, and a refusal that named a
      // repair arrives here as a button rather than as prose.
      toastFailure(error, {
        operation: 'Drawing the sprite',
        handlers: { onMuapiKey: () => setAuthOpen(true), onRetry: () => void drawSprite() },
      });
    } finally {
      setDrawing(false);
    }
  };

  /* ---------------- stage 2: animate it ---------------- */

  const animate = async () => {
    if (!spriteUrl) { toast.error('Add a sprite first.'); return; }
    if (!videoModel) { toast.error('Pick a model to animate it with.'); return; }
    const controller = new AbortController();
    abortRef.current = controller;
    setAnimating(true);
    setAnimationProgress({ progress: null });
    try {
      // The row is the PICK — its provider, not a Media Studio row built from
      // its id. That rewrite is how "Seedance 2.0 · Higgsfield" used to reach
      // the local lane as an unknown workflow. `extra` declares the one
      // transport this stage built a request for, so anything else is refused
      // before it costs a request.
      const result = await runVideo({
        row: animationRow(videoModel),
        shared: {
          prompt: animationPrompt,
          duration: seconds,
          aspect_ratio: SPRITE_ASPECT,
        },
        extra: Object.fromEntries(SPRITE_CLIP_TRANSPORTS.map((transport) => [transport, {
          image: spriteUrl,
          onProgress: (update) => setAnimationProgress(update),
        }])),
        signal: controller.signal,
      });
      if (!result?.url) throw new Error('No clip came back.');
      setClipUrl(result.url);
      setFrames([]);
      setSheet(null);
      if (!matteSubject) setMatteSubject(matteSubjectFrom(subject));
    } catch (error) {
      if (!error?.cancelled) {
        console.warn('[SpriteStudio] animation failed:', error?.message || error);
        toastFailure(error, {
          operation: 'Animating the sprite',
          handlers: { onMuapiKey: () => setAuthOpen(true), onRetry: () => void animate() },
        });
      }
    } finally {
      setAnimating(false);
      setAnimationProgress(null);
      abortRef.current = null;
    }
  };

  /* ---------------- stage 3: pull the key frames ---------------- */

  const extract = async () => {
    if (!clipUrl) { toast.error('Animate the sprite first.'); return; }
    setExtracting(true);
    setExtractProgress('Decoding the clip…');
    try {
      // The clip is sealed at rest, so it is decrypted here — the same way the
      // player above already reads it — and sampled from memory.
      const playable = await mediaSourceToDataUrl(clipUrl, 'video');
      const result = await extractKeyFrames(playable || clipUrl, {
        count: frameCount,
        onProgress: (done, total) => setExtractProgress(`Sampling ${done} of ${total}…`),
      });
      setFrames(result.frames);
      setSheet(null);
      if (result.frames.length < frameCount) {
        toast(`Only ${result.frames.length} distinct poses in that clip — the rest were duplicates.`);
      }
    } catch (error) {
      console.warn('[SpriteStudio] frame extraction failed:', error?.message || error);
      toast.error(error?.message || 'Could not read frames out of that clip.');
    } finally {
      setExtracting(false);
      setExtractProgress('');
    }
  };

  // Frames are canvases, not URLs — paint them into the strip directly rather
  // than round-tripping every one through a data URL.
  useEffect(() => {
    const host = frameStripRef.current;
    if (!host) return;
    host.replaceChildren(...frames.map(({ canvas, time }) => {
      const cell = document.createElement('figure');
      cell.className = 'flex shrink-0 flex-col items-center gap-1';
      const thumb = canvas.cloneNode(false);
      thumb.width = canvas.width;
      thumb.height = canvas.height;
      thumb.getContext('2d').drawImage(canvas, 0, 0);
      thumb.className = 'h-24 w-auto rounded border border-line1';
      thumb.style.imageRendering = 'pixelated';
      const caption = document.createElement('figcaption');
      caption.className = 'text-[10px] text-ink3';
      caption.textContent = `${time.toFixed(2)}s`;
      cell.append(thumb, caption);
      return cell;
    }));
  }, [frames]);

  /* ---------------- stage 4: cut out and pack ---------------- */

  const cutAndPack = async () => {
    if (!frames.length) { toast.error('Pull the key frames first.'); return; }
    const named = matteSubject.trim() || matteSubjectFrom(subject);
    if (!named) { toast.error('Name the sprite so the cut-out knows what to keep.'); return; }
    const controller = new AbortController();
    abortRef.current = controller;
    setPacking(true);
    try {
      setPackProgress(`Cutting out frame 1 of ${frames.length} — the first one loads the model, so it is the slow one.`);
      const { frames: matted, error } = await matteFrames(frames.map((frame) => frame.canvas), {
        subject: named,
        signal: controller.signal,
        onProgress: (done, total) => setPackProgress(
          done < total ? `Cutting out frame ${done + 1} of ${total}…` : 'Packing the sheet…',
        ),
      });
      if (!matted.length) throw new Error(error || 'No frames survived the cut-out.');
      // Some frames made it and one did not: pack what there is and say so,
      // rather than discarding minutes of finished cut-outs.
      if (error) toast.error(`Stopped after ${matted.length} of ${frames.length} frames — ${error}`);
      const packed = packSpriteSheet(matted, {
        columns,
        cellSize,
        name: 'sprite',
        frameRate: sheetFps,
        sourceDuration: seconds,
      });
      setSheet(packed);
    } catch (error) {
      console.warn('[SpriteStudio] sheet build failed:', error?.message || error);
      toast.error(error?.message || 'Could not build the sheet.');
    } finally {
      setPacking(false);
      setPackProgress('');
      abortRef.current = null;
    }
  };

  useEffect(() => {
    const host = sheetHostRef.current;
    if (!host) return;
    if (!sheet) { host.replaceChildren(); return; }
    const view = sheet.canvas.cloneNode(false);
    view.width = sheet.canvas.width;
    view.height = sheet.canvas.height;
    view.getContext('2d').drawImage(sheet.canvas, 0, 0);
    view.className = 'max-w-full rounded-md border border-line1 bg-[repeating-conic-gradient(#0000_0_25%,#8883_0_50%)_50%/16px_16px]';
    view.style.imageRendering = 'pixelated';
    host.replaceChildren(view);
  }, [sheet]);

  const downloadSheet = async () => {
    if (!sheet) return;
    const blob = await canvasToBlob(sheet.canvas);
    if (blob) saveBlob(blob, `${sheet.atlas.name}-sheet.png`);
  };

  const downloadAtlas = () => {
    if (!sheet) return;
    saveBlob(new Blob([JSON.stringify(sheet.atlas, null, 2)], { type: 'application/json' }), `${sheet.atlas.name}-atlas.json`);
  };

  const chosenAction = SPRITE_ACTIONS.find((entry) => entry.id === action) || SPRITE_ACTIONS[0];

  const panel = (
    <>
      <div>
        <SectionLabel>Style</SectionLabel>
        <Field label="Art style">
          <NativeSelect value={style} onChange={(event) => setStyle(event.target.value)}>
            {SPRITE_STYLES.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
          </NativeSelect>
        </Field>
        <Field
          label="Background"
          hint="Flat and plain is what makes a silhouette findable. Keep as generated when the scene is the point — the cut-out still names the character."
        >
          <NativeSelect value={background} onChange={(event) => setBackground(event.target.value)}>
            {SPRITE_BACKGROUNDS.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
          </NativeSelect>
        </Field>
      </div>

      <div>
        <SectionLabel>Animation</SectionLabel>
        <Field label="Length" hint="H3 holds a character together to about 15s; a cycle rarely needs more than 5.">
          <Slider value={seconds} min={2} max={15} step={1} onChange={setSeconds} format={(value) => `${value}s`} />
        </Field>
        <Field label="Key frames" hint="How many distinct poses to keep. A clip with fewer than this gives fewer, rather than duplicates.">
          <Slider value={frameCount} min={2} max={24} step={1} onChange={setFrameCount} />
        </Field>
      </div>

      <div>
        <SectionLabel>Sheet</SectionLabel>
        <Field label="Columns" hint="0 lays a short cycle out as one strip and wraps a long one.">
          <Slider value={columns} min={0} max={12} step={1} onChange={setColumns} format={(value) => (value ? String(value) : 'auto')} />
        </Field>
        <Field label="Cell size" hint="0 keeps the sprite's own size. A fixed square cell is what tile-indexed importers expect.">
          <Slider value={cellSize} min={0} max={256} step={16} onChange={setCellSize} format={(value) => (value ? `${value}px` : 'native')} />
        </Field>
        <Field label="Cycle rate" hint="How fast the sheet plays back — the poses are the animation, so this is unrelated to the clip's own frame rate.">
          <Slider value={sheetFps} min={2} max={24} step={1} onChange={setSheetFps} format={(value) => `${value} fps`} />
        </Field>
      </div>

      <Button icon="info" size="sm" onClick={() => setMatrixOpen(true)}>Capability matrix</Button>
      {matrixError ? <p className="text-[11px] leading-snug text-warn">{matrixError}</p> : null}
    </>
  );

  return (
    <StudioLayout panel={panel} panelTitle="Sprite settings">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-4">
        {!isHivemindStudioEnabled() ? (
          <Card className="border-warn/40 p-3 text-[13px] text-ink2">
            The sprite pipeline runs against this machine’s Media Studio. Open the studio from
            the Hivemind Content Studio shell so the animation and cut-out stages can reach it.
          </Card>
        ) : null}

        {/* ── 1. Sprite ─────────────────────────────────────────────── */}
        <Card className="flex flex-col gap-3 p-4">
          <StageHeader index={0} stage={STAGES[0]} done={Boolean(spriteUrl)}>
            <Button size="sm" icon="sparkles" onClick={loadExample}>Load example</Button>
          </StageHeader>
          <Field label="What the sprite is" hint="One character. Shape, colours, limbs, expression — the things a silhouette is made of.">
            <TextArea
              rows={4}
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              placeholder="A cute round spherical dragon, head and body one round piece, four small legs, thick short tail, big cute eyes, pink with little black wings and horns."
            />
          </Field>

          <div className="flex flex-wrap items-center gap-2">
            <UploadPicker
              values={spriteUrl ? [spriteUrl] : []}
              onChange={(urls) => {
                setSpriteUrl(urls[0] || '');
                setClipUrl('');
                setFrames([]);
                setSheet(null);
              }}
              maxImages={1}
              label="Upload a sprite"
            />
            <span className="text-[11px] text-ink3">or</span>
            <Button
              icon="wand"
              onClick={drawSprite}
              disabled={drawing || !subject.trim()}
              loading={drawing}
            >
              {drawing ? 'Drawing…' : 'Draw it'}
            </Button>
          </div>

          <ModelFitPicker label="Drawing model" rows={imageChoices} value={imageModel} onChange={setImageModel} />
          {/* Only when this machine offers nothing: the cloud rows above are a
              real answer, so a warning beside them would be noise. */}
          {isLocalAIAvailable() && localStatus !== 'ready' && !localModels.length
            ? <LocalCatalogNotice status={localStatus} onCheckAgain={refreshLocalCatalog} />
            : null}

          {spriteUrl ? <SpritePreview url={spriteUrl} alt="The sprite" /> : null}
        </Card>

        {/* ── 2. Animation ──────────────────────────────────────────── */}
        <Card className="flex flex-col gap-3 p-4">
          <StageHeader index={1} stage={STAGES[1]} done={Boolean(clipUrl)} />
          <Field label="What it does">
            <Segmented
              value={action}
              onChange={setAction}
              options={SPRITE_ACTIONS.map((entry) => ({ value: entry.id, label: entry.label }))}
            />
          </Field>
          {action === 'custom' ? (
            <>
              <Field label="Beat name" hint="Becomes the [0s] heading.">
                <TextArea rows={1} value={customBeat} onChange={(event) => setCustomBeat(event.target.value)} placeholder="Sitting idle animation" />
              </Field>
              <Field label="What happens" hint="Include the small constant motion — a tail swing, a blink — or every extracted frame comes back identical.">
                <TextArea rows={4} value={customAction} onChange={(event) => setCustomAction(event.target.value)} />
              </Field>
            </>
          ) : (
            <p className="text-[12px] leading-snug text-ink3">{chosenAction.action} <em>{chosenAction.secondary}</em></p>
          )}
          <Field label="Soundscape" hint="H3 generates sound with the picture. Left empty it gets generic movement sounds.">
            <TextArea rows={1} value={soundscape} onChange={(event) => setSoundscape(event.target.value)} placeholder="Dragon movements sounds." />
          </Field>

          <details className="rounded-md border border-line1 bg-bg2">
            <summary className="cursor-pointer px-3 py-2 text-[12px] font-semibold text-ink2">The prompt this sends</summary>
            <div className="p-2">
              <TextArea
                rows={10}
                value={animationPrompt}
                onChange={(event) => setPromptOverride(event.target.value)}
                className="font-mono text-[11px]"
              />
              {promptOverride ? (
                <Button size="sm" className="mt-2" onClick={() => setPromptOverride('')}>Back to the generated prompt</Button>
              ) : null}
            </div>
          </details>

          <ModelFitPicker label="Animation model" rows={videoChoices} value={videoModel} onChange={setVideoModel} readinessFor={animationReadiness} />

          <div className="flex items-center gap-2">
            <Button icon="film" onClick={animate} disabled={animating || !spriteUrl} loading={animating}>
              {animating ? 'Animating…' : 'Animate the sprite'}
            </Button>
            {animating ? (
              <Button size="sm" onClick={() => abortRef.current?.abort()}>Cancel</Button>
            ) : null}
          </div>
          {animating ? <ProgressBar value={animationProgress?.progress ?? null} label="Rendering" /> : null}
          {clipUrl ? <ClipPreview url={clipUrl} /> : null}
        </Card>

        {/* ── 3. Key frames ─────────────────────────────────────────── */}
        <Card className="flex flex-col gap-3 p-4">
          <StageHeader index={2} stage={STAGES[2]} done={frames.length > 0}>
            {frames.length ? <Pill tone="ok">{frames.length} poses</Pill> : null}
          </StageHeader>
          <p className="text-[12px] leading-snug text-ink3">
            Samples the clip densely, then keeps the poses that differ most from each other —
            an idle loop spends most of its length holding still, so evenly spaced frames would
            be mostly copies.
          </p>
          <div className="flex items-center gap-2">
            <Button icon="layers" onClick={extract} disabled={extracting || !clipUrl} loading={extracting}>
              {extracting ? 'Sampling…' : 'Pull the key frames'}
            </Button>
            {extractProgress ? <span className="text-[11px] text-ink3">{extractProgress}</span> : null}
          </div>
          <div ref={frameStripRef} className="flex gap-2 overflow-x-auto" />
        </Card>

        {/* ── 4. Sheet ──────────────────────────────────────────────── */}
        <Card className="flex flex-col gap-3 p-4">
          <StageHeader index={3} stage={STAGES[3]} done={Boolean(sheet)} />
          <Field
            label="Keep this, drop everything else"
            hint="Named rather than auto-detected: a sprite clip often has something else moving in it, and a matting tool keeps whatever is most conspicuous."
          >
            <TextArea
              rows={1}
              value={matteSubject}
              onChange={(event) => setMatteSubject(event.target.value)}
              placeholder={matteSubjectFrom(subject) || 'the pink dragon'}
            />
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <Button icon="scissors" onClick={cutAndPack} disabled={packing || !frames.length} loading={packing}>
              {packing ? 'Cutting out…' : 'Cut out & pack the sheet'}
            </Button>
            {packing ? <Button size="sm" onClick={() => abortRef.current?.abort()}>Cancel</Button> : null}
            {sheet ? (
              <>
                <Button size="sm" icon="download" onClick={downloadSheet}>Sheet PNG</Button>
                <Button size="sm" icon="download" onClick={downloadAtlas}>Atlas JSON</Button>
              </>
            ) : null}
          </div>
          {packProgress ? (
            <p className="text-[11px] leading-snug text-ink3">
              {packProgress} <span className="text-ink3/70">A warm cut-out is about 20 seconds a frame.</span>
            </p>
          ) : null}
          <div ref={sheetHostRef} className="overflow-x-auto" />
          {sheet ? (
            <p className="text-[11px] text-ink3">
              {sheet.atlas.columns}×{sheet.atlas.rows} grid · {sheet.atlas.frame_width}×{sheet.atlas.frame_height} cells ·
              {' '}{sheet.atlas.frame_count} frames at {sheet.atlas.frame_rate} fps
            </p>
          ) : null}
          {!frames.length && !packing ? (
            <EmptyState
              icon="grid"
              title="The sheet lands here"
              hint="Every cell shares one origin, so the sprite sits still and only what moves, moves."
            />
          ) : null}
        </Card>
      </div>

      {/* AuthModal renders when mounted (no `open` prop) — same as the Lip Sync studio. */}
      {authOpen ? (
        <AuthModal
          onClose={() => setAuthOpen(false)}
          onSaved={() => { setAuthOpen(false); void drawSprite(); }}
        />
      ) : null}

      <Modal open={matrixOpen} onClose={() => setMatrixOpen(false)} title="Which models suit which stage" size="lg">
        {/* The SAME ranked lists the pickers use, not the server's rows alone:
            half the image models are a browser-side catalog the server has never
            heard of, and a reference view that omitted them would disagree with
            the picker two inches away. */}
        <div className="flex flex-col gap-5">
          {[
            { id: 'sprite_source', rows: imageChoices },
            { id: 'sprite_animation', rows: videoChoices },
          ].map(({ id, rows }) => {
            const feature = (matrix?.features || []).find((entry) => entry.id === id);
            if (!feature) return null;
            return (
              <section key={id} className="flex flex-col gap-2">
                <SectionLabel>{feature.label}</SectionLabel>
                <p className="text-[12px] leading-snug text-ink3">{feature.summary}</p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {rows.map((row) => (
                    <div key={row.key} className="rounded-md border border-line1 bg-bg2 p-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-[13px] font-semibold text-ink1">{row.label}</span>
                        <Pill tone={RATING_TONE[row.rating] || 'neutral'}>{RATING_LABELS[row.rating]}</Pill>
                      </div>
                      <p className="mt-1 text-[11px] leading-snug text-ink3">{row.reason}</p>
                      <p className="mt-1 text-[10px] uppercase tracking-wide text-ink3/70">
                        {row.providerLabel ? `${row.providerLabel} · ` : ''}
                        {EVIDENCE_LABELS[row.evidence] || row.evidence}
                        {row.available === false ? ' · offline right now' : ''}
                      </p>
                    </div>
                  ))}
                </div>
              </section>
            );
          })}
          {!matrix ? <Spinner /> : null}
        </div>
      </Modal>
    </StudioLayout>
  );
}
