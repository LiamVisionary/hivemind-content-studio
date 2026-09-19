// Object → character — the image studio's vision workflow, as a dialog.
//
// Two steps and no graph (lib/objectToCharacter.js): the loaded prompt helper
// reads ONE picture of an object and writes an original character from it, and
// that paragraph is appended to the framing prompt. The dialog owns the first
// step and hands the joined prompt back; rendering is the composer's Generate,
// at whatever model and settings are on screen.
//
// The row of cards across the top is the pitch and a way in at once: each one is
// a real run of this workflow on this lane (object → character), and pressing a
// card loads its object as the input, so the button can be tried before a
// picture of your own has been found.
//
// The picture goes where a start frame goes: downscaled here, posted as a data
// URL to the owner-gated route, read by the llama-server this machine spawned on
// loopback, and written nowhere.
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'react-hot-toast';

import { Modal } from '../ui/Modal.jsx';
import { Button, Spinner, TextArea, cx } from '../ui/kit.jsx';
import { Icon } from '../ui/icons.jsx';
import { flattenApiDetail } from '../lib/muapiErrors.js';
import { lastUsedModelId } from '../lib/promptHelperRuntime.js';
import {
  OBJECT_TO_CHARACTER_EXAMPLES,
  OBJECT_TO_CHARACTER_FRAME,
  OBJECT_TO_CHARACTER_INSTRUCTION,
  composeCharacterPrompt,
  pickVisionModel,
} from '../lib/objectToCharacter.js';
import { OBJECT_TO_CHARACTER_ART } from '../studios/image/starterArt.js';

// What the vision projector is given. It resamples to its own grid anyway, so a
// 12-megapixel phone photo only makes the request slower.
const INPUT_LONG_SIDE = 1024;

async function api(path, body) {
  const response = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(flattenApiDetail(payload?.detail ?? payload?.error) || `Request failed (${response.status})`);
  }
  return payload;
}

// A File, a Blob or a same-origin URL → a JPEG data URL no longer than
// INPUT_LONG_SIDE on its long side.
async function pictureToDataUrl(source) {
  const blob = typeof source === 'string' ? await (await fetch(source)).blob() : source;
  const bitmap = await createImageBitmap(blob);
  try {
    const scale = Math.min(1, INPUT_LONG_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    // A transparent PNG (a cut-out product shot) would otherwise go black.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.9);
  } finally {
    bitmap.close?.();
  }
}

// One before → after pair. The character is the picture; the object rides in
// the corner as the thing it came from, and steps forward on hover so the two
// can be compared without leaving the card.
// Exported for the render test: the dialog itself portals through ui/Modal.jsx,
// which react-dom/server cannot build, but a card is plain markup.
export function ExampleCard({ example, art, active, onPick }) {
  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={active}
      title={`${example.object} became ${example.character}. Press to try this object.`}
      className={cx(
        'group relative aspect-[3/4] min-w-0 overflow-hidden rounded-lg border bg-bg3 text-left transition-[border-color,transform] duration-200',
        'hover:-translate-y-0.5 focus-visible:-translate-y-0.5',
        active ? 'border-honey' : 'border-line1 hover:border-line2',
      )}
    >
      <img src={art.after} alt={example.character} loading="lazy" className="absolute inset-0 h-full w-full object-cover" />
      <span className="absolute inset-x-0 bottom-0 h-2/5 bg-gradient-to-t from-black/70 to-transparent" />
      <span
        className={cx(
          'absolute bottom-2 left-2 w-[38%] origin-bottom-left overflow-hidden rounded-md border border-white/70 bg-white shadow-pop transition-transform duration-200',
          'group-hover:scale-[1.45] group-focus-visible:scale-[1.45]',
        )}
      >
        <img src={art.before} alt={example.object} loading="lazy" className="block aspect-square w-full object-cover" />
      </span>
      <span className="absolute bottom-2 right-2 flex items-center gap-1 rounded-full bg-black/55 px-1.5 py-0.5 text-[10px] font-medium text-white backdrop-blur-sm">
        <Icon name="arrowRight" size={10} />
        {active ? 'Loaded' : 'Try it'}
      </span>
    </button>
  );
}

export function ObjectToCharacterDialog({
  open, onClose,
  // Whatever is in the composer when the dialog opens: the prompt the character
  // is appended to. Blank is ordinary — the shipped framing prompt stands in.
  frame: frameProp = '',
  onUse,
}) {
  const [frame, setFrame] = useState(() => String(frameProp || '').trim() || OBJECT_TO_CHARACTER_FRAME);
  const [picture, setPicture] = useState({ url: '', label: '', exampleKey: '' });
  const [character, setCharacter] = useState('');
  const [snapshot, setSnapshot] = useState(null);
  const [runtimeError, setRuntimeError] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const inputRef = useRef(null);
  // A slow answer must not land on top of a newer press (or a closed dialog).
  const ticketRef = useRef(0);

  useEffect(() => {
    if (!open) return undefined;
    let live = true;
    api('/api/prompt-helper/runtime')
      .then((snap) => { if (live) setSnapshot(snap); })
      .catch((exc) => { if (live) { setSnapshot({ models: [] }); setRuntimeError(exc.message); } });
    return () => { live = false; ticketRef.current += 1; };
  }, [open]);

  const { loaded, candidate, blocked } = pickVisionModel(snapshot, { lastUsedId: lastUsedModelId() });
  const model = loaded || candidate;
  const settled = snapshot !== null;

  const takePicture = useCallback(async (source, { label = '', exampleKey = '' } = {}) => {
    setError('');
    try {
      const url = await pictureToDataUrl(source);
      setPicture({ url, label, exampleKey });
      setCharacter('');
    } catch {
      setError('That file could not be read as a picture — try a PNG, JPEG or WebP.');
    }
  }, []);

  const takeFiles = (files) => {
    const file = Array.from(files || []).find((item) => item.type.startsWith('image/'));
    if (file) void takePicture(file, { label: file.name });
    else if (files?.length) setError('That is not a picture — drop a PNG, JPEG or WebP.');
  };

  const design = async () => {
    if (!picture.url || !model || busy) return;
    const ticket = ++ticketRef.current;
    setError('');
    try {
      if (!loaded) {
        setBusy(`Loading ${model.name}…`);
        let state = await api('/api/prompt-helper/load', { modelId: model.id, unloadOthers: true });
        // A load already in flight (another tab, an earlier press) answers
        // `loading` — wait for llama-server rather than firing a request it
        // will refuse. Same wait the prompt helper makes.
        const deadline = Date.now() + 4 * 60 * 1000;
        while (state?.status === 'loading' && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 2500));
          if (ticket !== ticketRef.current) return;
          const snap = await api('/api/prompt-helper/runtime');
          const row = (snap?.models || []).find((item) => item.id === model.id);
          state = { ...snap, status: row?.fit === 'loading' ? 'loading' : 'loaded' };
        }
        if (ticket !== ticketRef.current) return;
        if (Array.isArray(state?.models)) setSnapshot(state);
      }
      setBusy('Reading the object…');
      const answer = await api('/api/prompt-helper/design-character', { image: picture.url, modelId: model.id });
      if (ticket !== ticketRef.current) return;
      setCharacter(String(answer.character || ''));
    } catch (exc) {
      if (ticket === ticketRef.current) setError(exc.message);
    } finally {
      if (ticket === ticketRef.current) setBusy('');
    }
  };

  const use = () => {
    const prompt = composeCharacterPrompt(frame, character);
    if (!prompt) return;
    // The frame rides back with the prompt so a reopen can start from it again.
    onUse?.(prompt, frame);
    onClose?.();
  };

  const copyInstruction = async () => {
    try {
      await navigator.clipboard.writeText(OBJECT_TO_CHARACTER_INSTRUCTION);
      toast.success('Copied. Paste it into any vision model with your picture, then paste the answer here.');
    } catch {
      toast.error('The clipboard is not available here — select the text and copy it by hand.');
    }
  };

  // No model on this machine can see. The recipe runs in ANY vision model, so
  // the repair is the instruction itself plus a box for the answer — the
  // workflow still finishes, it just borrows its first step.
  const noVision = settled && !model;
  const designLabel = loaded || !model ? 'Design the character' : `Load ${model.name} and design`;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Object → character"
      size="lg"
      footer={(
        <>
          <Button variant="neutral" onClick={onClose}>Cancel</Button>
          {character ? (
            <Button variant="neutral" icon="refresh" disabled={Boolean(busy) || !picture.url || !model} onClick={design}>
              Design again
            </Button>
          ) : null}
          {character ? (
            <Button variant="primary" onClick={use}>Use this prompt</Button>
          ) : (
            <Button variant="primary" icon="sparkles" disabled={Boolean(busy) || !picture.url || !model} onClick={design}>
              {designLabel}
            </Button>
          )}
        </>
      )}
    >
      <div className="flex flex-col gap-4">
        <p className="text-[13px] leading-relaxed text-ink2">
          A vision model reads the colours, shapes and textures of one object and designs an original
          character from them. The design is appended to your prompt — press Generate to draw it.
        </p>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {OBJECT_TO_CHARACTER_EXAMPLES.map((example) => (
            <ExampleCard
              key={example.key}
              example={example}
              art={OBJECT_TO_CHARACTER_ART[example.key]}
              active={picture.exampleKey === example.key}
              onPick={() => takePicture(OBJECT_TO_CHARACTER_ART[example.key].before, { label: example.object, exampleKey: example.key })}
            />
          ))}
        </div>

        <div className="grid gap-3 sm:grid-cols-[11rem_minmax(0,1fr)]">
          <div
            role="button"
            tabIndex={0}
            aria-label={picture.url ? 'Replace the object picture' : 'Choose a picture of an object'}
            onClick={() => inputRef.current?.click()}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputRef.current?.click(); } }}
            onDragEnter={(e) => { e.preventDefault(); depth.current += 1; setOver(true); }}
            onDragOver={(e) => e.preventDefault()}
            onDragLeave={() => { depth.current = Math.max(0, depth.current - 1); if (!depth.current) setOver(false); }}
            onDrop={(e) => { e.preventDefault(); depth.current = 0; setOver(false); takeFiles(e.dataTransfer?.files); }}
            className={cx(
              'relative flex aspect-[2/1] cursor-pointer flex-col sm:aspect-square items-center justify-center gap-1.5 overflow-hidden rounded-lg border border-dashed text-center transition-colors duration-150',
              over ? 'border-honey bg-honey-tint' : 'border-line2 bg-bg2 hover:border-ink3',
            )}
          >
            {picture.url ? (
              <>
                <img src={picture.url} alt={picture.label || 'The object'} className="absolute inset-0 h-full w-full object-contain sm:object-cover" />
                <span className="absolute inset-x-0 bottom-0 truncate bg-black/55 px-2 py-1 text-[10px] text-white">
                  {picture.label || 'Your picture'} · press to replace
                </span>
              </>
            ) : (
              <>
                <Icon name="upload" size={18} className="text-ink3" />
                <span className="px-3 text-xs font-medium text-ink1">Drop a picture of an object</span>
                <span className="px-3 text-[11px] text-ink3">or press to choose — or try a card above</span>
              </>
            )}
            <input
              ref={inputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => { takeFiles(e.target.files); e.target.value = ''; }}
            />
          </div>

          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink3">The character</span>
            {busy ? (
              <div className="flex min-h-[9rem] flex-1 items-center justify-center gap-2 rounded-md border border-line1 bg-bg2 text-xs text-ink2">
                <Spinner size={14} className="text-honey" />
                {busy}
              </div>
            ) : (
              <TextArea
                rows={7}
                value={character}
                onChange={(e) => setCharacter(e.target.value)}
                placeholder={noVision
                  ? 'Paste the vision model\'s answer here.'
                  : 'The design lands here. It is yours to edit before it is used.'}
                className="flex-1 text-xs leading-relaxed"
              />
            )}
          </div>
        </div>

        {error ? <p role="alert" className="text-xs text-danger">{error}</p> : null}

        {noVision ? (
          <div className="flex flex-col gap-2 rounded-md border border-line1 bg-bg2 px-3 py-2.5 text-xs text-ink2">
            <span>
              {blocked
                ? `${blocked.name} can see pictures but does not fit in memory right now — free some in the prompt helper (Improve → Refine), or borrow any vision model for this step:`
                : runtimeError
                  ? `The local helper did not answer (${runtimeError}). Any vision model can do this step:`
                  : 'No model on this machine can see pictures yet. Any vision model can do this step:'}
            </span>
            <span className="rounded border border-line1 bg-bg1 px-2 py-1.5 text-[11px] leading-relaxed text-ink1">
              {OBJECT_TO_CHARACTER_INSTRUCTION}
            </span>
            <span className="flex items-center gap-2">
              <Button size="sm" variant="neutral" icon="copy" onClick={copyInstruction}>Copy the instruction</Button>
              <span className="text-[11px] text-ink3">Send it with your picture, then paste the answer above.</span>
            </span>
          </div>
        ) : null}

        <details className="rounded-md border border-line1 bg-bg2/50 px-3 py-2">
          <summary className="cursor-pointer text-xs font-medium text-ink1">The prompt it is appended to</summary>
          <TextArea
            rows={4}
            value={frame}
            onChange={(e) => setFrame(e.target.value)}
            aria-label="Framing prompt"
            className="mt-2 text-xs leading-relaxed"
          />
          <p className="mt-1.5 text-[11px] text-ink3">
            This half owns the backdrop, the light and the art style; the character paragraph is told to leave them alone.
          </p>
        </details>
      </div>
    </Modal>
  );
}
