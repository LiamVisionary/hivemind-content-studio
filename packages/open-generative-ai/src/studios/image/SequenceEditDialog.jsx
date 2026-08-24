// Sequential edit chain (Mix-Studio "edit sets" port) — one prompt per line;
// step 1 edits this image, every later step edits the PREVIOUS step's output,
// seed advancing by one per step. Great for staged transformations ("add a
// scarf" → "make it snow" → "night lighting") without hand-feeding outputs back.
import { useState } from 'react';
import { MAX_SEQUENCE_STEPS, normalizeSequentialPrompts } from '../../lib/editSequence.js';
import { Modal } from '../../ui/Modal.jsx';
import { ActionButton, Field, TextArea } from '../../ui/kit.jsx';

export function SequenceEditDialog({ entry, modelName, busy, progress, onClose, onRun }) {
  const [text, setText] = useState('');
  const prompts = normalizeSequentialPrompts(text);

  return (
    <Modal open onClose={busy ? undefined : onClose} title="Edit steps (sequence)" size="lg" dismissable={!busy}
      footer={
        <>
          <ActionButton variant="neutral" label={busy ? 'Stop after this step' : 'Cancel'} onClick={onClose} />
          <ActionButton
            variant="primary"
            icon="stack"
            loading={busy}
            label={busy
              ? (progress || 'Editing…')
              : prompts.length >= 2
                ? `Run ${prompts.length} steps in order`
                : 'Write at least two steps'}
            disabled={busy || prompts.length < 2}
            onClick={() => onRun({ prompts })}
          />
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-xs leading-relaxed text-ink3">
          One edit per line, run top to bottom on {modelName}. Each step edits the previous
          step&apos;s result, so changes accumulate; every intermediate lands in the gallery.
        </p>
        <Field label={`Steps (${prompts.length}/${MAX_SEQUENCE_STEPS})`}>
          <TextArea
            rows={6}
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={busy}
            placeholder={'add a red scarf\nmake it snow lightly\nshift to warm evening light'}
            className="font-mono"
          />
        </Field>
      </div>
    </Modal>
  );
}
