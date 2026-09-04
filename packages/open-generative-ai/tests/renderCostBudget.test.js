// What a long session costs the renderer: mounted media, and re-renders.
//
// Three separate leaks of the same kind, all structural rather than visible as
// bugs: the library mounted every page it ever loaded, the Image studio
// re-rendered its whole tree on a 300 ms timer, and a slider or region drag put
// that same whole-tree render on every pointer event.
//
// Deliberately textual: this file is about re-render cost and lifetime — what
// is memoised, what releases its decrypted bytes on unmount, what a drag keeps
// in local state until pointer-up. A static render happens once and measures
// none of it.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

test('every mounted media consumer holds its decrypted bytes, and lets go on unmount', () => {
  const hooks = read('../src/hooks/hooks.js');
  // Retained at the TOP of the effect, before the decrypt resolves: the window
  // between "asked for it" and "got it" is exactly when a burst of new media
  // could otherwise evict the entry the moment it lands.
  assert.match(hooks, /retainResolvedMedia\(url\);/);
  assert.match(hooks, /const done = \(\) => \{ alive = false; releaseResolvedMedia\(url\); \};/);

  const thumb = read('../src/hub/components/MediaThumb.jsx');
  assert.match(thumb, /retainResolvedMedia\(url\);/);
  assert.match(thumb, /const release = \(\) => releaseResolvedMedia\(url\);/);
  assert.match(thumb, /release\(\);/);
});

test('the library unmounts the output cards that are far off screen', () => {
  const view = read('../src/hub/views/HistoryView.jsx');
  // Two screens either way, which is what the sentinel's own margin implies.
  assert.match(view, /const WINDOW_MARGIN = '200% 0px';/);
  assert.match(view, /function Windowed\(\{ children \}\)/);
  assert.match(view, /\{mounted \? children : null\}/);
  // The placeholder keeps the height the card had, so a card leaving does not
  // jump the scroll position of the one you are looking at.
  assert.match(view, /heightRef\.current = height/);
  assert.match(view, /<Windowed key=\{entry\.history_id\}>/);
});

test('the Image studio progress tick repaints the progress card and nothing else', () => {
  const studio = read('../src/studios/ImageStudio.jsx');
  // The 300 ms interval writes the store; `bump()` — the whole-tree re-render —
  // is not in it.
  assert.match(studio, /s\.progressStore\.set\(\{ pct: s\.progressDisplay \}\);/);
  const interval = studio.slice(studio.indexOf('s.generationTimer = setInterval'));
  const body = interval.slice(0, interval.indexOf('}, 300);'));
  // A statement, not the comment that says why it is absent.
  assert.ok(!/^\s*bump\(\)/m.test(body), 'the timer must not re-render the panel and composer');
  // The bridge's progress messages land on the same store, for the same reason.
  assert.match(studio, /s\.progressStore\.set\(\{ label \}\);/);

  const card = read('../src/studios/image/GenerationProgressCard.jsx');
  assert.match(card, /useSyncExternalStore\(store\.subscribe, store\.get, store\.get\)/);
});

test('the Image gallery cards are memoised on stable handlers', () => {
  const gallery = read('../src/studios/image/GalleryAndViewer.jsx');
  assert.match(gallery, /export const GalleryCard = memo\(function GalleryCard/);
  // Handlers take the entry, so the caller passes one function per action
  // rather than a fresh closure per card — without which memo never holds.
  assert.match(gallery, /onClick=\{\(\) => onOpen\(entry\)\}/);
  assert.match(gallery, /onDownload\(entry\)/);
  assert.match(gallery, /onUpscale\(entry, 'fast'\)/);

  const studio = read('../src/studios/ImageStudio.jsx');
  assert.match(studio, /const openGalleryEntry = useCallback\(/);
  assert.match(studio, /onOpen=\{openGalleryEntry\}/);
  assert.match(studio, /onUpscale=\{isLocalAIAvailable\(\) \? upscaleGalleryEntry : undefined\}/);
});

test('a slider drag repaints the panel and commits to the studio on release', () => {
  const panel = read('../src/studios/image/ImageSettingsPanel.jsx');
  assert.match(panel, /const \[, repaint\] = useReducer\(\(n\) => n \+ 1, 0\);/);
  assert.match(panel, /s\.steps = v; repaint\(\); \}\}\s*\n\s*onCommit=\{\(\) => bump\(\)\}/);
  assert.match(panel, /s\.guidanceScale = v; repaint\(\); \}\}/);
  assert.match(panel, /s\.coupleSplit = v; repaint\(\); \}\}/);

  // Arrow keys raise no mouse or touch end, so a keyboard user would otherwise
  // never reach the commit at all.
  const kit = read('../src/ui/kit.jsx');
  assert.match(kit, /onKeyUp=\{onCommit \? \(e\) => onCommit\(Number\(e\.target\.value\)\) : undefined\}/);
});

test('a region box is dragged in local state and committed once, on pointer-up', () => {
  const editor = read('../src/studios/image/RegionBoxEditor.jsx');
  assert.match(editor, /const \[live, setLive\] = useState\(null\)/);
  assert.match(editor, /setLive\(\{ id: drag\.id, \.\.\.next \}\)/);
  // The ref is what pointer-up reads, for the same reason drawing uses one: a
  // gesture fast enough to batch with the release would commit a stale box.
  assert.match(editor, /drag\.next = next;/);
  assert.match(editor, /if \(drag\.next\) patch\(drag\.id, drag\.next\);/);
  assert.match(editor, /const region = live && live\.id === region0\.id \? \{ \.\.\.region0, \.\.\.live \} : region0;/);
});

test('a render waiting for the machine GPU says how many are ahead of it', () => {
  const poller = read('../src/lib/hivemindStudio.js');
  assert.match(poller, /queuePosition: Number\(payload\.queue_position\) \|\| null,/);

  const video = read('../src/studios/VideoStudio.jsx');
  // Not sticky, unlike the step counters: the field stops arriving the moment
  // the GPU frees up, and the card has to stop saying "waiting" with it.
  assert.match(video, /s\.progressQueuePosition = Number\(queuePosition\) > 0 \? Number\(queuePosition\) : null;/);
  assert.match(video, /Waiting behind \$\{s\.progressQueuePosition === 1 \? 'one render'/);
});
