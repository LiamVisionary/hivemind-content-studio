// What a Prompt Check finding MEANS, in the reader's language.
//
// h3PromptCheck.js returns codes and numbers because the rules have to be
// testable without a browser; the sentences live here because this is where the
// studio speaks Chinese. Every line says the consequence, not the rule — "this
// cut never happens" rather than "cut > duration" — because the consequence is
// the part that tells someone whether to care.
import { zh } from './videoLogic.js';

const SECTION_NAMES = {
  subject_definitions: () => (zh() ? '主体定义' : 'subject_definitions'),
  summary: () => (zh() ? '摘要' : 'summary'),
  retention_analysis: () => (zh() ? '保留分析' : 'retention_analysis'),
  detailed_description: () => (zh() ? '镜头描述' : 'detailed_description'),
  overall_soundscape: () => (zh() ? '整体声音' : 'overall_soundscape'),
  non_diegetic_music: () => (zh() ? '配乐' : 'non_diegetic_music'),
};

const sectionName = (name) => (SECTION_NAMES[name] ? SECTION_NAMES[name]() : name);
const seconds = (value) => `${(Number(value) || 0).toFixed(2)}s`;

// The reference budget already words itself in ReferencesMenu; here it only has
// to say enough to send someone to that panel.
function budgetText(problem) {
  switch (problem?.code) {
    case 'over-total':
      return zh()
        ? `参考总数 ${problem.count} 个，超过 H3 的 ${problem.limit} 个上限（含 ${problem.soundtracks} 条随片声轨）。`
        : `${problem.count} references attached — H3 takes ${problem.limit} (${problem.soundtracks} of them are clip soundtracks).`;
    case 'over-audio-clips':
      return zh()
        ? `声音参考 ${problem.count} 条，超过上限 ${problem.limit} 条。`
        : `${problem.count} voice clips — H3 takes ${problem.limit}.`;
    case 'audio-without-visual':
      return zh()
        ? '只有声音参考，没有可依附的图片或动作片段。'
        : 'A voice clip with no picture or clip to attach to.';
    case 'clip-too-short':
      return zh() ? `有片段只有 ${problem.seconds}s，短于 ${problem.limit}s。` : `A clip is ${problem.seconds}s — under the ${problem.limit}s floor.`;
    case 'clip-too-long':
      return zh() ? `有片段长 ${problem.seconds}s，超过 ${problem.limit}s。` : `A clip is ${problem.seconds}s — over the ${problem.limit}s ceiling.`;
    case 'over-video-seconds':
      return zh() ? `动作参考合计 ${problem.seconds}s，超过 ${problem.limit}s。` : `${problem.seconds}s of motion reference — the ceiling is ${problem.limit}s.`;
    case 'over-audio-seconds':
      return zh()
        ? `声音合计 ${problem.seconds}s，超过 ${problem.limit}s（${problem.soundtracks} 条随片声轨也计入）。`
        : `${problem.seconds}s of audio — the ceiling is ${problem.limit}s, and ${problem.soundtracks} clip soundtrack(s) count toward it.`;
    default:
      return zh() ? '参考预算有问题。' : 'The reference budget has a problem.';
  }
}

/** One finding as a sentence. Returns '' for a code with nothing to say. */
export function describeCheckFinding(finding) {
  if (!finding) return '';
  if (finding.code.startsWith('budget:')) return budgetText(finding.budget);

  switch (finding.code) {
    case 'empty':
      return zh() ? '还没有提示词。' : 'Nothing written yet.';

    case 'over-chars':
      return zh()
        ? `提示词 ${finding.count.toLocaleString()} 字符，超过 H3 的 ${finding.limit.toLocaleString()} 上限——超出部分会被截断。`
        : `${finding.count.toLocaleString()} characters — H3 takes ${finding.limit.toLocaleString()}, and the rest is cut off.`;
    case 'near-chars':
      return zh()
        ? `提示词 ${finding.count.toLocaleString()} 字符，接近 ${finding.limit.toLocaleString()} 上限。`
        : `${finding.count.toLocaleString()} characters, close to the ${finding.limit.toLocaleString()} ceiling.`;

    case 'no-sections':
      return zh()
        ? '已附加参考，但提示词没有分节。参考模式下 H3 读的是六个字段，纯散文会让它自己猜谁是谁。'
        : 'References are attached but the prompt has no sections. With references H3 reads six fields; loose prose leaves it guessing who is who.';
    case 'partial-sections':
      return zh()
        ? `缺少字段：${finding.missing.map(sectionName).join('、')}。`
        : `Missing: ${finding.missing.map(sectionName).join(', ')}.`;
    case 'sections-out-of-order':
      return zh()
        ? 'H3 是按位置读这六个字段的——顺序乱了，摘要就成了对下文的摘要。'
        : 'H3 reads the six fields positionally — out of order, the summary summarises nothing.';
    case 'empty-section':
      return zh() ? `${sectionName(finding.section)} 是空的。` : `${sectionName(finding.section)} is empty.`;
    case 'no-soundscape':
      return zh()
        ? '没有写 overall_soundscape。H3 会连声音一起生成，没说就由它自己发挥。'
        : 'No overall_soundscape. H3 renders the audio too — unsaid means invented.';

    case 'shot-number':
      return zh()
        ? `第 ${finding.at} 个镜头标成了 [Shot ${finding.found}]，编号断了。`
        : `The ${finding.at}${finding.at === 2 ? 'nd' : finding.at === 3 ? 'rd' : 'th'} marker says [Shot ${finding.found}] — the numbering skips.`;
    case 'cut-past-end':
      return zh()
        ? `[Shot ${finding.shot}] 的切点在 ${seconds(finding.cutSec)}，而这段只有 ${seconds(finding.duration)}——这个镜头不会出现。`
        : `[Shot ${finding.shot}] cuts at ${seconds(finding.cutSec)} but the clip is ${seconds(finding.duration)} — that shot never happens.`;
    case 'cut-out-of-order':
      return zh()
        ? `[Shot ${finding.shot}] 的切点 ${seconds(finding.cutSec)} 早于上一镜的 ${seconds(finding.previous)}。`
        : `[Shot ${finding.shot}] cuts at ${seconds(finding.cutSec)}, before the previous shot's ${seconds(finding.previous)}.`;
    case 'shot-no-cut':
      return zh()
        ? `[Shot ${finding.shot}] 没写切点时间，切在哪由模型自己决定。`
        : `[Shot ${finding.shot}] has no timecode — where it cuts is the model's guess.`;

    case 'dialogue-unbalanced':
      return zh()
        ? `<d> 有 ${finding.opens} 个，</d> 有 ${finding.closes} 个——没闭合的台词会把后面的描述一起当成台词念出来。`
        : `${finding.opens} <d> and ${finding.closes} </d> — an unclosed line makes the model speak the description after it.`;
    case 'dialogue-no-language':
      return zh()
        ? `第 ${finding.index} 句台词没有语言标签（例如 [English]），口音由模型随机决定。`
        : `Line ${finding.index} has no language tag (e.g. [English]) — the accent becomes the model's guess.`;
    case 'dialogue-empty':
      return zh() ? `第 ${finding.index} 个 <d> 里没有台词。` : `Line ${finding.index} has an empty <d> block.`;
    case 'scenetrans-unpaired':
      return zh()
        ? `<scenetrans> 不成对：${finding.out} 句说要接下去，${finding.in} 句接得上。`
        : `<scenetrans> is unpaired: ${finding.out} line(s) run on, ${finding.in} pick up.`;
    case 'cutoff-not-last':
      return zh()
        ? `第 ${finding.index} 句带 <cutoff>，但它不是最后一句——这会让片子提前收在半句话上。`
        : `Line ${finding.index} carries <cutoff> but is not the last line — the clip is being told to end mid-word early.`;
    case 'speaker-ids-start':
      return zh()
        ? `说话人编号从 (S${finding.first}) 开始，应当从 (S1) 起，按出声先后编号。`
        : `Speaker ids start at (S${finding.first}) — they number from (S1), in the order voices are first heard.`;
    case 'speaker-ids-skip':
      return zh()
        ? `说话人编号从 (S${finding.after}) 跳到 (S${finding.found})。`
        : `Speaker ids jump from (S${finding.after}) to (S${finding.found}).`;

    case 'tag-unbacked':
      if (!finding.attached) {
        return zh()
          ? `提示词里写了 ${finding.tag}，但这一类参考一个都没挂——这个标签会被忽略。`
          : `The prompt names ${finding.tag} with none of that kind attached — the tag is ignored.`;
      }
      return zh()
        ? `提示词里写了 ${finding.tag}，但只挂了 ${finding.attached} 个——这个标签会被忽略。`
        : `The prompt names ${finding.tag} but only ${finding.attached} ${finding.attached === 1 ? 'is' : 'are'} attached — that tag is ignored.`;
    case 'pictures-unnamed':
      return zh()
        ? `挂了 ${finding.count} 张图片，但提示词里没有 <Picture N> 或 <Subject N>——模型不知道该拿它们做什么。`
        : `${finding.count} picture${finding.count === 1 ? '' : 's'} attached, but the prompt names no <Picture N> or <Subject N> — the model is not told what to do with them.`;
    case 'motion-unnamed':
      return zh()
        ? `${finding.labels.join('、')} 没有在提示词里出现。`
        : `${finding.labels.join(', ')} ${finding.labels.length === 1 ? 'is' : 'are'} never named in the prompt.`;
    case 'motion-no-exclusion':
      return zh()
        ? '有图片也有动作片段，但没写清哪些东西不要从片段里带过来——片段里的人可能会顶替掉你的角色。'
        : 'A picture and a motion clip, with nothing saying what must NOT carry from the clip — its performer can replace your character.';

    case 'voice-without-line':
      return zh()
        ? '挂了声音参考，但没有 <d> 台词——克隆出来的声音没有词可说，模型会自己编。'
        : 'A voice reference with no <d> line — the cloned voice has nothing to say, so the model invents words.';
    case 'unscripted-time':
      return zh()
        ? `台词约 ${finding.spoken}s，片长 ${finding.duration}s，还有约 ${finding.gap}s 没有交代——这段空白模型常拿来编话。`
        : `About ${finding.spoken}s of speech in a ${finding.duration}s clip leaves ~${finding.gap}s unaccounted for — the model tends to fill it with invented speech.`;
    case 'overscripted-time':
      return zh()
        ? `台词约需 ${finding.spoken}s，但片长只有 ${seconds(finding.duration)}——模型不会加快，只会说不完。`
        : `About ${finding.spoken}s of speech in a ${seconds(finding.duration)} clip — the model does not speed up, it runs out.`;

    default:
      return finding.code;
  }
}

/** The chip's one-line verdict. */
export function checkSummaryText(result) {
  if (!result) return '';
  if (result.findings.length === 1 && result.findings[0].code === 'empty') {
    return zh() ? '还没有提示词' : 'Nothing to check yet';
  }
  if (!result.findings.length) return zh() ? '未发现问题' : 'Nothing to flag';
  const bits = [];
  if (result.errors) bits.push(zh() ? `${result.errors} 处会出错` : `${result.errors} will break`);
  if (result.warnings) bits.push(zh() ? `${result.warnings} 处需留意` : `${result.warnings} worth a look`);
  return bits.join(zh() ? '，' : ' · ');
}
