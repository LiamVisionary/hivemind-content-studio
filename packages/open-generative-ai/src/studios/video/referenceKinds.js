// What each reference row IS, in the user's words: its file filter, its title,
// the label the model will give what you put in it, and what belongs there.
//
// Lifted out of ReferencesMenu so the composer can refuse a drop in exactly the
// same words the panel would have used — a file rejected in one place and
// accepted in the other, or explained differently, reads as two features.
export const KIND_META = {
  images: {
    accept: 'image/*',
    label: () => 'Image references',
    add: () => 'Add image reference',
    tag: (index) => `<Picture ${index + 1}>`,
    icon: 'image',
    hint: () => 'Subjects, clothing, environments, style.',
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
    label: () => 'Scene & staging',
    add: () => 'Add scene reference',
    tag: (index) => `<Picture ${index + 1}>`,
    icon: 'image',
    hint: () => ('A location plate or a storyboard. A place carries its architecture, materials, light and layout; '
        + 'staging is read as the order of the action and roughly where things sit, and its drawing style and '
        + 'panel grid do not carry. Neither is a subject.'),
  },
  videos: {
    accept: 'video/*',
    label: () => 'Motion references',
    add: () => 'Add video reference',
    tag: (index) => `<Video ${index + 1}>`,
    icon: 'film',
    hint: () => 'How a body moves: gesture, posture, mannerisms, expressiveness. Your prompt decides whether the motion is copied outright or only its manner is borrowed. With no picture attached, the first motion clip is also the character reference. 2-15s.',
  },
  audios: {
    accept: 'audio/*',
    label: () => 'Voice references',
    add: () => 'Add voice reference',
    tag: (index) => `<Audio ${index + 1}>`,
    icon: 'mic',
    hint: () => 'Clones a voice — timbre and delivery. 2-15s each, 15s combined, and never the only reference.',
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
  if (kind === 'Video') return `Motion ${number}`;
  if (kind === 'Audio') return `Voice ${number}`;
  return `Picture ${number}`;
}

// One refused file, in one sentence: which file, and which of the three
// unrelated reasons it was.
export function describeReferenceRejection({ name, code, kind, limit, error, size } = {}) {
  const megabytes = size ? ` (${(size / 1024 / 1024).toFixed(1)} MB)` : '';
  const row = KIND_META[kind]?.label() || '';
  let reason;
  if (code === 'unsupported') {
    reason = 'not a picture, clip or voice file';
  } else if (code === 'full') {
    reason = `the ${row} row is full (${limit} max)`;
  } else {
    reason = `${error?.message || 'upload failed'}${megabytes}`;
  }
  return `${name} — ${reason}`;
}

// What a drop on the composer is about to do, said before the user lets go.
// The kinds come from the drag itself, so it names the row the file is heading
// for rather than offering the general case.
export function composerReferenceHint(kinds = []) {
  const only = kinds.length === 1 ? kinds[0] : null;
  if (only === 'videos') return 'Attach as a motion reference';
  if (only === 'audios') return 'Attach as a voice reference';
  if (only === 'images') return 'Attach as an image reference';
  return 'Attach as a reference';
}

// The same sentence for a studio whose model has no reference rows: there, a
// picture is the shot's first frame and a clip is the source video.
export function composerFrameHint(kinds = []) {
  const only = kinds.length === 1 ? kinds[0] : null;
  if (only === 'videos') return 'Attach as the source video';
  if (only === 'audios') return 'This model takes no voice reference';
  return 'Attach as the start frame';
}

// A drop that landed: what went where, in one line.
export function describeReferenceAttachment({ images = 0, videos = 0, audios = 0 } = {}) {
  const parts = [];
  if (images) parts.push(`${images} picture${images === 1 ? '' : 's'}`);
  if (videos) parts.push(`${videos} motion clip${videos === 1 ? '' : 's'}`);
  if (audios) parts.push(`${audios} voice clip${audios === 1 ? '' : 's'}`);
  if (!parts.length) return '';
  return `Attached ${parts.join(' and ')} as reference${parts.length === 1 && images + videos + audios === 1 ? '' : 's'}`;
}
