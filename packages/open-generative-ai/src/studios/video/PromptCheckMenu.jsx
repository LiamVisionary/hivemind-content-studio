// Prompt Check — the last thing between a prompt and a paid generation.
//
// H3 fails quietly: a cut past the end of the clip does not error, it just
// never happens; an unclosed <d> makes the model read the stage directions
// aloud. None of that is visible until the clip lands. So the chip reads the
// prompt as WRITTEN — typed by hand, loaded from the library, or assembled by
// the Shot Builder — and says what will break before it costs anything.
//
// It is a readout, not a gate: nothing here blocks Generate. A finding it got
// wrong should cost a glance, never a run someone wanted.
//
// Rules live in lib/h3PromptCheck.js, wording in promptCheckText.js.
import { checkH3Prompt } from '../../lib/h3PromptCheck.js';
import { checkSummaryText, describeCheckFinding } from './promptCheckText.js';
import { ChipButton, Menu } from '../../ui/Menu.jsx';
import { Icon } from '../../ui/icons.jsx';
import { SectionLabel, cx } from '../../ui/kit.jsx';
import { zh } from './videoLogic.js';

/**
 * @param {object} props
 * @param {string} props.prompt          what is in the composer now
 * @param {number} props.durationSeconds what the run is set to produce
 * @param {Array}  props.images          reference pictures, as attached
 * @param {Array}  props.videos          motion/sound-only clip rows, as attached
 * @param {Array}  props.audios          voice clips, as attached
 * @param {object} props.durations       url -> measured seconds, where known
 * @param {Function} [props.onRefit]      re-time the shots to fit the clip
 * @param {Function} [props.onWeave]      weave the attached references / cast into the prompt
 * @param {Function} [props.onRefine]     open the helper — for findings only prose can fix
 */
export function PromptCheckMenu({
  prompt = '', durationSeconds = 0, images = [], videos = [], audios = [], durations = {}, onRefit, onWeave, onRefine,
}) {
  const result = checkH3Prompt({ prompt, durationSeconds, images, videos, audios, durations });
  const nothingYet = result.findings.length === 1 && result.findings[0].code === 'empty';
  // Errors first: a broken cut matters more than a missing soundscape, and a
  // list sorted by where it happened to be found reads as unranked noise.
  const findings = [...result.findings].sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1));

  // The one finding here with a mechanical fix. A shot past the end is a
  // spacing mistake, not a writing one — the beats are right, they were just
  // laid out for a longer clip — so the check offers to re-time them rather
  // than leaving the user to redo the arithmetic by hand. Every other finding
  // needs a human to decide what the prompt should SAY.
  const canRefit = typeof onRefit === 'function'
    && durationSeconds > 0
    && findings.some((finding) => finding.code === 'cut-past-end');
  // The other mechanical fix: references attached under a prompt that never
  // addresses them. The weave (lib/promptWeave.js) writes the subject for
  // whoever is in the rows and binds the scene to it — the same pass every
  // door runs, offered here for text that was typed straight in.
  // subject-not-in-scene is deliberately NOT here: the weave can define a
  // subject but cannot write it into prose — that is the helper's job.
  const WEAVABLE = new Set(['no-sections', 'pictures-unnamed', 'motion-unnamed', 'partial-sections']);
  const canWeave = typeof onWeave === 'function'
    && findings.some((finding) => WEAVABLE.has(finding.code));
  // A subject defined but never staged needs PROSE — a beat for them to be in.
  // That is the helper's job, told the cast by slot.
  const unstaged = findings.filter((finding) => finding.code === 'subject-not-in-scene').map((finding) => finding.subject);
  const canRefine = typeof onRefine === 'function' && unstaged.length > 0;

  const tone = result.errors ? 'error' : (result.warnings && !nothingYet ? 'warn' : 'clean');
  const badge = result.errors || (nothingYet ? 0 : result.warnings);

  return (
    <Menu
      up
      align="end"
      width="w-[23rem]"
      trigger={(open, toggle) => (
        <ChipButton
          icon={tone === 'clean' ? 'check' : 'warning'}
          label={zh() ? '检查' : 'Check'}
          value={badge ? String(badge) : ''}
          active={open || tone !== 'clean'}
          warn={tone === 'error'}
          onClick={toggle}
          title={zh()
            ? '生成前检查提示词结构、镜头时间、台词标签、参考标签与声音'
            : 'Check structure, shot timing, dialogue tags, reference tags and sound before spending a generation'}
        />
      )}
    >
      {(close) => (
        <div className="flex flex-col gap-2">
          <div>
            <SectionLabel>{zh() ? '提示词检查' : 'Prompt check'}</SectionLabel>
            <p className="mt-1 text-[10px] leading-snug text-ink3">
              {checkSummaryText(result)}
              {result.mode === 'reference' && result.sections.length
                ? (zh() ? ` · 已识别 ${result.sections.length}/6 个字段` : ` · ${result.sections.length}/6 sections found`)
                : ''}
            </p>
          </div>

          {findings.length && !nothingYet ? (
            <ul className="flex flex-col gap-1">
              {findings.map((finding, index) => (
                <li
                  key={`${finding.code}-${index}`}
                  className={cx(
                    'flex items-start gap-1.5 rounded-md border p-1.5 text-[10px] leading-snug',
                    finding.level === 'error'
                      ? 'border-danger bg-danger-tint text-ink1'
                      : 'border-honey bg-honey-tint text-ink1',
                  )}
                >
                  <Icon
                    name={finding.level === 'error' ? 'warning' : 'info'}
                    size={11}
                    className={cx('mt-px shrink-0', finding.level === 'error' ? 'text-danger' : 'text-honey')}
                  />
                  <span className="min-w-0 flex-1">{describeCheckFinding(finding)}</span>
                </li>
              ))}
            </ul>
          ) : null}

          {canWeave ? (
            <button
              type="button"
              className="flex items-center justify-center gap-1.5 rounded-md border border-honey bg-honey-tint px-2 py-1.5 text-[10px] font-medium text-ink1 hover:bg-bg2"
              onClick={() => { onWeave(); close(); }}
              title={zh()
                ? '按已附加的参考和演员表重写“镜头里是谁”与“哪些会带过来”，并把他们写进场景'
                : 'Write who is in it and what carries over for whoever is attached, and bind the scene to them'}
            >
              <Icon name="wand" size={11} className="text-honey" />
              {zh() ? '把参考织入提示词' : 'Weave references into the prompt'}
            </button>
          ) : null}

          {canRefine ? (
            <button
              type="button"
              className="flex items-center justify-center gap-1.5 rounded-md border border-honey bg-honey-tint px-2 py-1.5 text-[10px] font-medium text-ink1 hover:bg-bg2"
              onClick={() => { onRefine(); close(); }}
              title={zh()
                ? '打开助手：它知道演员表，会把每位主体写进场景'
                : 'Open the helper — it is told the cast by slot and writes every subject into the scene'}
            >
              <Icon name="sparkles" size={11} className="text-honey" />
              {zh()
                ? `让助手把${unstaged.map((n) => `第 ${n} 位`).join('、')}写进场景`
                : `Write ${unstaged.map((n) => `Person ${n}`).join(', ')} into the scene with the helper`}
            </button>
          ) : null}

          {canRefit ? (
            <button
              type="button"
              className="flex items-center justify-center gap-1.5 rounded-md border border-honey bg-honey-tint px-2 py-1.5 text-[10px] font-medium text-ink1 hover:bg-bg2"
              onClick={() => { onRefit(); close(); }}
              title={zh()
                ? '按当前时长等比重排镜头时间点，保留每一个镜头'
                : 'Rescale the shot timestamps to fit the clip, keeping every shot'}
            >
              <Icon name="wand" size={11} className="text-honey" />
              {zh()
                ? `重新排布镜头以适配 ${durationSeconds}秒`
                : `Re-time shots to fit ${durationSeconds}s`}
            </button>
          ) : null}

          {findings.length && !nothingYet ? null : (
            <p className="rounded-md border border-line1 bg-bg0 p-2 text-[10px] leading-snug text-ink2">
              {nothingYet
                ? (zh()
                  ? '写点什么，或者用「分镜」搭一条时间线，这里就会开始检查。'
                  : 'Write something, or build a timeline with Shots, and this starts checking.')
                : (zh()
                  ? '结构、镜头时间、台词标签、参考标签和声音都没有发现问题。这不代表模型一定听话——只代表提示词本身说得清楚。'
                  : 'Structure, shot timing, dialogue tags, reference tags and sound all read clean. That is not a promise the model will comply — only that the prompt is unambiguous.')}
            </p>
          )}
        </div>
      )}
    </Menu>
  );
}
