// UGC mode picker — shared by the image and video composers, because a UGC ad is
// two prompts: a first frame that looks like a phone photo, then a clip that
// behaves like someone talking to their own camera.
//
// The primary action is "deal a new cast", not "turn on": repetition across a
// batch is the loudest tell that a set of clips came off a production line, so
// the useful thing is a different person, room, light and beat set each time.
// Re-dealing keeps whatever script the block already holds — swapping the cast
// while keeping the words is what a batch IS.
//
// UI pattern follows CameraMotionMenu (ChipButton + Menu popover); the cast bank
// and the block composers live in src/lib/ugcMode.js.
import { getLang } from '../lib/i18n.js';
import { ugcClock, ugcTimeline, ugcVariantAt } from '../lib/ugcMode.js';
import { ChipButton, Menu } from '../ui/Menu.jsx';
import { cx } from '../ui/kit.jsx';

const zh = () => getLang() === 'zh-CN';

function CastRow({ label, children }) {
  return (
    <div className="flex gap-2 text-[11px] leading-relaxed">
      <span className="w-12 shrink-0 pt-px text-[10px] font-semibold uppercase tracking-[0.06em] text-ink3">
        {label}
      </span>
      <span className="min-w-0 flex-1 text-ink2">{children}</span>
    </div>
  );
}

export function UgcMenu({
  mode = 'video',
  // Whether the composer's prompt actually holds the block right now. Read from
  // the prompt rather than from a flag, so "Start fresh" or loading a saved
  // prompt turns the chip off with it.
  active = false,
  // The last cast dealt, as its deal number. Survives the block being cleared,
  // so turning UGC back on deals the NEXT one rather than starting the cycle
  // over — repeating a cast is the thing this is here to avoid.
  variantIndex = null,
  // The loaded persona's gender, if any: the preview must show the cast that
  // arming would actually deal, and the deal is narrowed by it.
  gender = '',
  // When reference pictures are attached, the person in the clip is the one in
  // the pictures, not a dealt description — say so where the cast is previewed.
  // A short line like "Cheryl — the woman in your 3 reference pictures".
  subject = '',
  durationSeconds = null,
  // True when the current model offers 9:16, so arming can say whether it is
  // also going to switch the aspect ratio rather than doing it invisibly.
  verticalAvailable = false,
  onArm,
}) {
  const armed = Boolean(active);
  const nextIndex = Number.isInteger(variantIndex) ? variantIndex + 1 : 0;
  // Armed shows the cast you have; off shows the one arming would deal.
  const cast = ugcVariantAt(armed ? variantIndex : nextIndex, { gender });
  const video = mode === 'video';
  const timeline = ugcTimeline(durationSeconds);

  return (
    <Menu
      up
      width="w-[23rem]"
      trigger={(open, toggle) => (
        <ChipButton
          // persona, not camera: the Video composer's Camera chip wears the
          // camera glyph, and two of them sat side by side on H3.
          icon="persona"
          label={armed ? `UGC · ${zh() ? '第' : 'cast '}${cast.index + 1}` : 'UGC'}
          active={open || armed}
          onClick={toggle}
          title={zh()
            ? '真人自拍风格 UGC 模式：每次重新发牌都会换人物、房间、光线与小动作'
            : 'Phone-selfie UGC mode — every deal is a different person, room, light and beat set'}
        />
      )}
    >
      {(close) => (
        <div className="flex flex-col gap-2">
          <p className="text-[11px] leading-relaxed text-ink2">
            {video
              ? (zh()
                ? '写入一段可见的 UGC 提要：人物、房间、具名光源、手机麦克风音轨，以及按当前时长计算的 钩子/正文/CTA 时间轴。'
                : 'Writes a visible UGC brief into the prompt — cast, room, a named light source, phone-mic audio, and a hook / body / CTA timeline sized to this clip.')
              : (zh()
                ? '写入首帧真实感堆叠：真实皮肤纹理、具名光源、有生活痕迹的背景、9:16。'
                : 'Writes the first-frame realism stack — real skin texture, a named light source, a lived-in background, 9:16.')}
          </p>

          <div className="flex flex-col gap-1 rounded-md border border-line1 bg-bg0 px-2 py-2">
            <div className="pb-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink3">
              {armed
                ? `${zh() ? '当前阵容' : 'Cast'} ${cast.index + 1}`
                : (zh() ? '下一组阵容' : 'Next cast')}
            </div>
            <CastRow label={zh() ? '人物' : 'Who'}>{subject || cast.person}</CastRow>
            <CastRow label={zh() ? '场景' : 'Where'}>
              {cast.room.place}, {cast.room.light}. {cast.room.detail}
            </CastRow>
            <CastRow label={zh() ? '声音' : 'Sound'}>{cast.room.sound}</CastRow>
            <CastRow label={zh() ? '动作' : 'Beats'}>{cast.beats.join('; ')}</CastRow>
          </div>

          {video ? (
            <div className="rounded-md border border-line1 bg-bg0 px-2 py-1.5 text-[11px] text-ink2">
              <span className="font-mono">
                {[
                  `${ugcClock(0)}–${ugcClock(timeline.hookEnd)}`,
                  timeline.hasBody ? `${ugcClock(timeline.hookEnd)}–${ugcClock(timeline.ctaStart)}` : '',
                  `${ugcClock(timeline.ctaStart)}–${ugcClock(timeline.seconds)}`,
                ].filter(Boolean).join(' · ')}
              </span>
              <span className="text-ink3">
                {' '}
                {timeline.hasBody
                  ? (zh() ? '钩子 · 正文 · CTA' : 'hook · body · CTA')
                  : (zh()
                    ? '钩子 · CTA — 这个时长放不下正文，调长一点'
                    : 'hook · CTA — too short for a body beat, lengthen the clip')}
              </span>
            </div>
          ) : null}

          {armed ? (
            <p className="text-[11px] leading-relaxed text-ink3">
              {video
                ? (zh()
                  ? '在 HOOK / BODY / CTA 三行的 ⟨…⟩ 处写下你的台词，然后交给提示词助手改写成目标模型格式。重新发牌会保留台词。'
                  : (subject
                    ? 'Write your three lines where the ⟨…⟩ marks are — the brief is already in H3\'s reference format, with <Subject 1> bound to your pictures and your lines as (S1) dialogue. Re-dealing keeps your lines and changes the room, light and beats.'
                    : 'Write your three lines where the ⟨…⟩ marks are, then hand it to the prompt helper to render into the model\'s format. Re-dealing keeps your lines.'))
                : (zh()
                  ? '这段可直接用作首帧提示词。'
                  : 'This is usable as the first-frame prompt as it stands.')}
            </p>
          ) : null}

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => { onArm?.(nextIndex); close(); }}
              className="rounded-sm border border-honey/50 bg-honey-tint px-2 py-1 text-[11px] font-semibold text-honey transition-colors hover:border-honey"
            >
              {armed
                ? (zh() ? '换一组阵容' : 'Deal a new cast')
                : (zh() ? '开启 UGC 模式' : 'Turn on UGC mode')}
            </button>
            {armed ? (
              <button
                type="button"
                onClick={() => { onArm?.(null); close(); }}
                title={zh() ? '从提示词中移除 UGC 段落' : 'Remove the UGC block from the prompt'}
                className={cx(
                  'rounded-sm border border-line1 bg-bg1 px-2 py-1 text-[11px] font-semibold',
                  'text-ink1 transition-colors hover:border-line2',
                )}
              >
                {zh() ? '关闭' : 'Turn off'}
              </button>
            ) : null}
            <span className="ml-auto pr-1 text-[10px] text-ink3">
              {verticalAvailable
                ? (zh() ? '同时切到 9:16' : 'also sets 9:16')
                : (zh() ? '此模型无 9:16' : 'no 9:16 on this model')}
            </span>
          </div>
        </div>
      )}
    </Menu>
  );
}
