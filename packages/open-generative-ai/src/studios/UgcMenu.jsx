// UGC mode picker — shared by the image and video composers, because a UGC ad is
// two prompts: a first frame that looks like a phone photo, then a clip that
// behaves like someone talking to their own camera.
//
// The menu is laid out as the three questions a clip has to answer — WHO is on
// camera, WHERE they are, WHAT they say — because the first of those was the
// one nobody could find an answer to. UGC used to answer WHO by itself, dealing
// an invented person and writing them into the prompt as a hard description,
// which silently beat any reference attached beside it. Now WHO is resolved
// from the composer and merely REPORTED here, and the deal only offers to
// invent someone when nothing else has.
//
// WHERE stays dealt, and is dealt SEPARATELY from the person: when the face is
// pinned by a reference, varying the room, light and beats is the only variation
// left, and it is the variation a batch actually needs.
//
// UI pattern follows CameraMotionMenu (ChipButton + Menu popover); the cast bank
// and the block composers live in src/lib/ugcMode.js.
import { getLang } from '../lib/i18n.js';
import { ugcClock, ugcSubject, ugcTimeline, ugcVariantAt } from '../lib/ugcMode.js';
import { ChipButton, Menu } from '../ui/Menu.jsx';
import { cx } from '../ui/kit.jsx';

const zh = () => getLang() === 'zh-CN';

function Row({ label, children, tone = 'ink2' }) {
  return (
    <div className="flex gap-2 text-[11px] leading-relaxed">
      <span className="w-12 shrink-0 pt-px text-[10px] font-semibold uppercase tracking-[0.06em] text-ink3">
        {label}
      </span>
      <span className={cx('min-w-0 flex-1', tone === 'honey' ? 'text-honey' : 'text-ink2')}>{children}</span>
    </div>
  );
}

function Section({ title, action, children }) {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-line1 bg-bg0 px-2 py-2">
      <div className="flex items-center gap-2 pb-0.5">
        <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink3">{title}</span>
        {action ? <span className="ml-auto">{action}</span> : null}
      </div>
      {children}
    </div>
  );
}

function DealButton({ onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        'rounded-sm border border-line1 bg-bg1 px-1.5 py-0.5 text-[10px] font-semibold',
        'text-ink2 transition-colors hover:border-line2 hover:text-ink1',
      )}
    >
      {children}
    </button>
  );
}

// What the composer is conditioning on, in the words the user used to attach it.
function subjectSummary(subject) {
  const names = subject?.names?.length ? subject.names.join(' + ') : '';
  switch (subject?.kind) {
    case 'cast':
      return {
        who: zh() ? `演员表：${names}` : `Your cast — ${names}`,
        from: zh() ? '来自「演员表」' : 'from the Cast chip',
      };
    case 'persona':
      return {
        who: names,
        from: zh()
          ? `来自角色档案 · ${subject.count} 张参考图`
          : `from your Persona ID · ${subject.count} reference picture${subject.count === 1 ? '' : 's'}`,
      };
    case 'reference':
      return {
        who: zh() ? '参考图里的人' : 'the person in your references',
        from: zh()
          ? `${subject.count} 张参考图`
          : `from ${subject.count} reference picture${subject.count === 1 ? '' : 's'}`,
      };
    case 'frame':
      return {
        who: zh() ? '首帧里的人' : 'the person in your first frame',
        from: zh() ? '来自起始帧' : 'from the attached start frame',
      };
    default:
      return null;
  }
}

export function UgcMenu({
  mode = 'video',
  // Whether the composer's prompt actually holds the block right now. Read from
  // the prompt rather than from a flag, so "Start fresh" or loading a saved
  // prompt turns the chip off with it.
  active = false,
  // The last person / room dealt, as deal numbers. They survive the block being
  // cleared, so turning UGC back on deals the NEXT one rather than starting the
  // cycle over — repeating a cast is the thing this is here to avoid.
  variantIndex = null,
  roomIndex = null,
  durationSeconds = null,
  // Who the composer says is on camera. Video only — the image composer has no
  // references, so its whole job IS to invent the person.
  subject = null,
  // Set when the block in the prompt was written against a DIFFERENT binding
  // than the composer now has — armed before the references were attached, or
  // the references were removed afterwards. The block is stale and says so.
  stale = false,
  // True when the current model offers 9:16, so arming can say whether it is
  // also going to switch the aspect ratio rather than doing it invisibly.
  verticalAvailable = false,
  onArm,
}) {
  const armed = Boolean(active);
  const video = mode === 'video';
  const who = video ? (subject || ugcSubject()) : ugcSubject();
  const summary = subjectSummary(who);

  const nextPerson = Number.isInteger(variantIndex) ? variantIndex + 1 : 0;
  const nextRoom = Number.isInteger(roomIndex) ? roomIndex + 1 : nextPerson;
  // Armed shows what you have; off shows what arming would deal.
  const cast = armed
    ? ugcVariantAt(variantIndex, roomIndex)
    : ugcVariantAt(nextPerson, nextRoom);
  const timeline = ugcTimeline(durationSeconds);

  const arm = (person, room) => onArm?.(person, room);

  return (
    <Menu
      up
      width="w-[25rem]"
      trigger={(open, toggle) => (
        <ChipButton
          icon="camera"
          label={armed ? `UGC · ${zh() ? '场景 ' : 'take '}${cast.roomIndex + 1}` : 'UGC'}
          active={open || armed}
          warn={armed && stale}
          onClick={toggle}
          title={zh()
            ? '真人自拍风格 UGC 模式：镜头、光线、手机麦克风与时间轴'
            : 'Phone-selfie UGC mode — framing, named light, phone-mic audio and a hook/body/CTA timeline'}
        />
      )}
    >
      {(close) => (
        <div className="flex flex-col gap-2">
          <p className="text-[11px] leading-relaxed text-ink2">
            {video
              ? (zh()
                ? 'UGC 模式负责「怎么拍」：手机自拍构图、具名光源、手机麦克风音轨，以及按当前时长排布的钩子/正文/CTA。它不决定「拍谁」。'
                : 'UGC mode owns HOW it is shot — selfie framing, a named light source, phone-mic audio, and a hook / body / CTA timeline sized to this clip. It does not decide who is in it.')
              : (zh()
                ? '写入首帧真实感堆叠：真实皮肤纹理、具名光源、有生活痕迹的背景、9:16。'
                : 'Writes the first-frame realism stack — real skin texture, a named light source, a lived-in background, 9:16.')}
          </p>

          {video ? (
            <Section
              title={zh() ? '① 谁出镜' : '① Who is in it'}
              action={who.invents ? (
                <DealButton onClick={() => arm(nextPerson, armed ? cast.roomIndex : nextRoom)}>
                  {zh() ? '换个人' : 'different person'}
                </DealButton>
              ) : null}
            >
              {summary ? (
                <>
                  <Row label={zh() ? '出镜' : 'Who'} tone="honey">{summary.who}</Row>
                  <Row label={zh() ? '来源' : 'Source'}>{summary.from}</Row>
                  <p className="pt-1 text-[10px] leading-relaxed text-ink3">
                    {zh()
                      ? 'UGC 不会再另外描述一个人物，外貌完全交给参考。'
                      : 'UGC will not describe a person of its own — the appearance comes entirely from what you attached.'}
                  </p>
                </>
              ) : (
                <>
                  <Row label={zh() ? '出镜' : 'Who'}>{cast.person}</Row>
                  <p className="pt-1 text-[10px] leading-relaxed text-ink3">
                    {zh()
                      ? '没有参考图、角色档案或演员表，所以 UGC 会临时编一个人。附加任意一项，这里就会改用它。'
                      : 'Nothing is attached, so UGC invents someone. Attach references, a Persona ID or a Cast and this row switches to them instead.'}
                  </p>
                </>
              )}
            </Section>
          ) : null}

          <Section
            title={video ? (zh() ? '② 在哪拍' : '② Where it is shot') : (zh() ? '场景' : 'Scene')}
            action={(
              <DealButton onClick={() => arm(armed ? cast.index : nextPerson, nextRoom)}>
                {zh() ? '换个场景' : 'different place'}
              </DealButton>
            )}
          >
            {!video ? <Row label={zh() ? '人物' : 'Who'}>{cast.person}</Row> : null}
            <Row label={zh() ? '场景' : 'Where'}>
              {cast.room.place}, {cast.room.light}. {cast.room.detail}
            </Row>
            <Row label={zh() ? '声音' : 'Sound'}>{cast.room.sound}</Row>
            <Row label={zh() ? '动作' : 'Beats'}>{cast.beats.join('; ')}</Row>
          </Section>

          {video ? (
            <Section title={zh() ? '③ 说什么' : '③ What they say'}>
              <div className="text-[11px] text-ink2">
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
              <p className="pt-1 text-[10px] leading-relaxed text-ink3">
                {zh()
                  ? '在提示词的 ⟨…⟩ 处写你的台词，然后用「提示词助手」转成该模型的格式。重新发牌会保留台词。'
                  : 'Write your lines over the ⟨…⟩ marks in the prompt, then run the prompt helper to render it into the model\'s format. Re-dealing keeps your lines.'}
              </p>
            </Section>
          ) : null}

          {armed && stale ? (
            <p className="rounded-md border border-honey/50 bg-honey-tint px-2 py-1.5 text-[11px] leading-relaxed text-honey">
              {zh()
                ? '提示词里的 UGC 段落是在当前参考之前写的，出镜人物对不上。点「更新」把它改到上面的人物。'
                : 'The UGC block in your prompt was written before this changed — it still names a different subject. Update it to match the row above.'}
            </p>
          ) : null}

          {/* The panel caps at 420px and these three sections overflow it, so the
              primary action pins to the bottom of the scroll area rather than
              sitting below the fold where nobody scrolls to find it. */}
          <div className="sticky bottom-[-6px] z-10 flex items-center gap-1.5 border-t border-line1 bg-bg1 pb-1.5 pt-2">
            <button
              type="button"
              onClick={() => {
                arm(armed ? cast.index : nextPerson, armed ? cast.roomIndex : nextRoom);
                close();
              }}
              className="rounded-sm border border-honey/50 bg-honey-tint px-2 py-1 text-[11px] font-semibold text-honey transition-colors hover:border-honey"
            >
              {!armed
                ? (zh() ? '开启 UGC 模式' : 'Turn on UGC mode')
                : (stale
                  ? (zh() ? '更新段落' : 'Update the block')
                  : (zh() ? '重写段落' : 'Rewrite the block'))}
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
