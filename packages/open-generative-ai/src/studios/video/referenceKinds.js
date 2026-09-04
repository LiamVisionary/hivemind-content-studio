// What each reference row IS, in the user's words: its file filter, its title,
// the label the model will give what you put in it, and what belongs there.
//
// Lifted out of ReferencesMenu so the composer can refuse a drop in exactly the
// same words the panel would have used — a file rejected in one place and
// accepted in the other, or explained differently, reads as two features.
import { zh } from './videoLogic.js';

export const KIND_META = {
  images: {
    accept: 'image/*',
    label: () => (zh() ? '图片参考' : 'Image references'),
    add: () => (zh() ? '添加图片参考' : 'Add image reference'),
    tag: (index) => `<Picture ${index + 1}>`,
    icon: 'image',
    hint: () => (zh()
      ? '主体、服装、场景、风格。'
      : 'Subjects, clothing, environments, style.'),
  },
  // A picture that is a PLACE or a STAGING sheet, not a person. It rides in the
  // same <Picture N> row as the character pictures (order of supply is the
  // numbering, so scenes are supplied last), and lives in its own section here
  // because what it CONTRIBUTES is different: a character picture promises that
  // a face carries, a scene picture promises that a room does — and one told to
  // the model as the other is how an empty plate comes back with a stranger in
  // it.
  scene: {
    accept: 'image/*',
    label: () => (zh() ? '场景与分镜' : 'Scene & staging'),
    add: () => (zh() ? '添加场景参考' : 'Add scene reference'),
    tag: (index) => `<Picture ${index + 1}>`,
    icon: 'image',
    hint: () => (zh()
      ? '地点图或分镜图。地点：建筑、材质、光线与布局会带入；分镜：只作为动作顺序与构图方向，画风与分格都不会带入。两者都不是主体。'
      : 'A location plate or a storyboard. A place carries its architecture, materials, light and layout; '
        + 'staging is read as the order of the action and roughly where things sit, and its drawing style and '
        + 'panel grid do not carry. Neither is a subject.'),
  },
  videos: {
    accept: 'video/*',
    label: () => (zh() ? '动作参考' : 'Motion references'),
    add: () => (zh() ? '添加视频参考' : 'Add video reference'),
    tag: (index) => `<Video ${index + 1}>`,
    icon: 'film',
    hint: () => (zh()
      ? '动作方式：手势幅度、体态、神情。提示词决定是照搬动作还是只借用其举止。没有图片时，第一段动作参考同时也是角色参考。2-15 秒。'
      : 'How a body moves: gesture, posture, mannerisms, expressiveness. Your prompt decides whether the motion is copied outright or only its manner is borrowed. With no picture attached, the first motion clip is also the character reference. 2-15s.'),
  },
  audios: {
    accept: 'audio/*',
    label: () => (zh() ? '声音参考' : 'Voice references'),
    add: () => (zh() ? '添加声音参考' : 'Add voice reference'),
    tag: (index) => `<Audio ${index + 1}>`,
    icon: 'mic',
    hint: () => (zh()
      ? '克隆音色与语气。每段 2-15 秒，合计 15 秒，且不能作为唯一参考。'
      : 'Clones a voice — timbre and delivery. 2-15s each, 15s combined, and never the only reference.'),
  },
};

// The same reference, in the words a reader uses. `<Picture 3>` is the token the
// model is told about; "Picture 3" is what the row is CALLED. Angle brackets are
// grammar, and the grammar belongs in the advanced fold and in Prompt Check's
// detail view — not on every row of the first panel a new user opens.
export function plainReferenceLabel(tag) {
  const match = /^<(Picture|Video|Audio)\s+(\d+)>$/.exec(String(tag || '').trim());
  if (!match) return String(tag || '');
  const [, kind, number] = match;
  if (kind === 'Video') return zh() ? `动作 ${number}` : `Motion ${number}`;
  if (kind === 'Audio') return zh() ? `声音 ${number}` : `Voice ${number}`;
  return zh() ? `图片 ${number}` : `Picture ${number}`;
}

// One refused file, in one sentence: which file, and which of the three
// unrelated reasons it was.
export function describeReferenceRejection({ name, code, kind, limit, error, size } = {}) {
  const megabytes = size ? ` (${(size / 1024 / 1024).toFixed(1)} MB)` : '';
  const row = KIND_META[kind]?.label() || '';
  let reason;
  if (code === 'unsupported') {
    reason = zh() ? '不是图片、视频或音频文件' : 'not a picture, clip or voice file';
  } else if (code === 'full') {
    reason = zh() ? `${row}已满（上限 ${limit}）` : `the ${row} row is full (${limit} max)`;
  } else {
    reason = `${error?.message || (zh() ? '上传失败' : 'upload failed')}${megabytes}`;
  }
  return zh() ? `${name}：${reason}` : `${name} — ${reason}`;
}

// What a drop on the composer is about to do, said before the user lets go.
// The kinds come from the drag itself, so it names the row the file is heading
// for rather than offering the general case.
export function composerReferenceHint(kinds = []) {
  const only = kinds.length === 1 ? kinds[0] : null;
  if (only === 'videos') return zh() ? '作为动作参考附加' : 'Attach as a motion reference';
  if (only === 'audios') return zh() ? '作为声音参考附加' : 'Attach as a voice reference';
  if (only === 'images') return zh() ? '作为图片参考附加' : 'Attach as an image reference';
  return zh() ? '作为参考附加' : 'Attach as a reference';
}

// The same sentence for a studio whose model has no reference rows: there, a
// picture is the shot's first frame and a clip is the source video.
export function composerFrameHint(kinds = []) {
  const only = kinds.length === 1 ? kinds[0] : null;
  if (only === 'videos') return zh() ? '作为源视频附加' : 'Attach as the source video';
  if (only === 'audios') return zh() ? '该模型不接受声音参考' : 'This model takes no voice reference';
  return zh() ? '作为起始帧附加' : 'Attach as the start frame';
}

// A drop that landed: what went where, in one line.
export function describeReferenceAttachment({ images = 0, videos = 0, audios = 0 } = {}) {
  const parts = [];
  if (images) parts.push(zh() ? `${images} 张图片` : `${images} picture${images === 1 ? '' : 's'}`);
  if (videos) parts.push(zh() ? `${videos} 段动作` : `${videos} motion clip${videos === 1 ? '' : 's'}`);
  if (audios) parts.push(zh() ? `${audios} 段声音` : `${audios} voice clip${audios === 1 ? '' : 's'}`);
  if (!parts.length) return '';
  return zh()
    ? `已附加${parts.join('、')}作为参考`
    : `Attached ${parts.join(' and ')} as reference${parts.length === 1 && images + videos + audios === 1 ? '' : 's'}`;
}
