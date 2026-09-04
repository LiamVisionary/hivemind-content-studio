// The video composer's action row, pinned by shape: the chips wrap as ONE group
// and Generate stays pinned right on every width. One flex-wrap row used to
// hold both, so below ~1280px the primary button dropped to a second row,
// left-aligned, under the chips.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (relative) => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');

test('the chips wrap as a group and Generate is a pinned sibling', () => {
    const studio = read('src/studios/VideoStudio.jsx');
    const row = studio.slice(studio.indexOf('<div className="flex items-end gap-2">'), studio.indexOf('/* ---------------- canvas ---------------- */'));
    assert.match(row, /<div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">/, 'the chip group wraps');
    // The looser gap allows the completion chime, which now sits beside Generate.
    assert.match(row, /<div className="ml-auto flex shrink-0 items-center gap-2">[\s\S]{0,300}?<Button\s+variant="primary"/, 'Generate sits in a pinned sibling group');
    // The all-studio completion chime rides beside Generate, not in Advanced.
    assert.match(row, /<CompletionPingToggle \/>/);
    assert.doesNotMatch(studio, /checked=\{s\.pingWhenComplete\}/);
    // ONE primary per view REGION (DESIGN.md): Generate owns the composer, and the
    // result row owns exactly one leading next step — Continue scene where the
    // model can chain, New where it cannot. Download and the rest stay neutral,
    // and the rarer actions live in a More menu rather than as more grey buttons.
    const result = studio.slice(studio.indexOf('{s.resultUrl ? ('), studio.indexOf('{/* The manual timeline'));
    // Two occurrences in the source, one on screen: they are the two branches of
    // the same ternary, so exactly one leading action ever renders.
    assert.equal(result.match(/variant="primary"/g).length, 2, 'the leading action is one ternary, not a row of primaries');
    assert.match(result, /\{canContinue \? \(\s*<Button\s+variant="primary"\s+icon="arrowRight"[\s\S]*?Continue scene[\s\S]*?\) : \(\s*<Button variant="primary" icon="plus" onClick=\{newPrompt\}/);
    assert.match(result, /variant="neutral"\s+icon="download"/);
    assert.match(result, /<MenuItem[\s\S]*?Post to Civitai/, 'publishing moved under More');
    assert.match(result, /meta=\{zh\(\) \? '离开本机' : 'leaves device'\}/, 'and says it leaves the device');
});

test('one trigger primitive, distinct icons, H3-only grammar chips, no chips on a disabled prompt', () => {
    const studio = read('src/studios/VideoStudio.jsx');
    // FrameSlotsPicker and ReferencesMenu triggers are ChipButtons now.
    assert.match(read('src/studios/video/FrameSlotsPicker.jsx'), /<ChipButton\s+icon="film"/);
    assert.match(read('src/studios/video/ReferencesMenu.jsx'), /<ChipButton\s+icon=\{persona\?\.name \? 'persona' : 'layers'\}/);
    // The clip button is a labelled chip with an H3-specific title.
    assert.match(studio, /<ChipButton\s+icon="video"\s+label=\{zh\(\) \? '片段' : 'Clip'\}/);
    assert.match(studio, /Continue from a clip/);
    // Camera is "Camera" with the camera icon; Style is the wand; Refine keeps sparkles as a VALUE.
    assert.match(read('src/studios/video/CameraMotionMenu.jsx'), /icon="camera"\s+label=\{zh\(\) \? '运镜' : 'Camera'\}/);
    assert.match(read('src/studios/video/RestyleMenu.jsx'), /icon="wand"/);
    assert.match(studio, /icon="sparkles"\s+value=\{zh\(\) \? '润色' : 'Refine'\}/);
    // UGC, Style, Shots and Check all write H3 grammar: gated together on isH3().
    assert.match(studio, /\{isH3\(\) \? \(\s*<>\s*<UgcMenu/);
    // The prompt-writing chips go with a disabled textarea.
    assert.match(studio, /\{promptUi\.disabled \? null : \(\s*<>\s*<SavedPromptsMenu/);
});

test('keyboard, confirms, and the canvas actions behave', () => {
    const studio = read('src/studios/VideoStudio.jsx');
    // ⌘/Ctrl+Enter generates from the textarea, behind the same guards as the button.
    assert.match(studio, /if \(e\.key !== 'Enter' \|\| !\(e\.metaKey \|\| e\.ctrlKey\)\) return;[\s\S]*?if \(rentedBlocked \|\| s\.generating\) return;\s*void generate\(\);/);
    // No native confirm anywhere in the studio; the source-clip switch resolves a ConfirmModal.
    assert.doesNotMatch(studio, /window\.confirm/);
    assert.match(studio, /confirmLabel=\{zh\(\) \? '切换并附加' : 'Switch and attach'\}/);
    assert.match(studio, /if \(cost && !\(await confirmSourceVideoSwitch\(cost\)\)\) return;/);
    // "Back to setup" only clears the canvas.
    const back = studio.match(/const backToSetup = \(\) => \{[\s\S]*?\n  \};/)[0];
    assert.doesNotMatch(back, /restoreGenerationContext/);
    // History cards and timeline tiles: Space activates, hover actions show on focus.
    assert.match(studio, /group-focus-within:opacity-100 group-hover:opacity-100/);
    assert.match(read('src/studios/video/ChainTimeline.jsx'), /group-focus-within:opacity-100 group-hover:opacity-100/);
    assert.match(studio, /if \(e\.key !== 'Enter' && e\.key !== ' '\) return;/);
    // Strip tiles draw a poster <img>, not a <video> per entry.
    assert.match(studio, /function HistoryThumb\(\{ url \}\) \{\s*const \{ poster, resolved, pending \} = useMediaPoster\(url, \{ kind: 'video' \}\);/);
    assert.match(read('src/studios/video/ChainTimeline.jsx'), /useMediaPoster\(url, \{ kind: 'video' \}\)/);
    // The failure callout offers Try again and says it once (no duplicate toast) —
    // and, since the failure is read through describeFailure, the repair it named.
    assert.match(studio, /s\.generateError = failure\.title \|\| \(zh\(\) \? '生成失败' : 'Generation failed'\);/);
    assert.match(studio, /<FailureCallout/);
    assert.match(studio, /remedy=\{s\.generateFailure\?\.remedy \|\| null\}/);
    assert.doesNotMatch(studio, /toast\.error\(e\.message\)/);
    // The "still stopping" notice has a lifetime.
    assert.doesNotMatch(studio, /toast\.loading\(zh\(\)\s*\? '正在停止/);
    // The joined tile: static honey border, animated only while building, no cyan/violet.
    const css = read('src/style.css');
    assert.doesNotMatch(css, /#7dd3fc|#c084fc|#f472b6/);
    assert.match(css, /\.chain-combined-tile--building \{[\s\S]*?animation: chain-cut-spin/);
    assert.doesNotMatch(css.match(/\.chain-combined-tile \{[\s\S]*?\n\}/)[0], /animation/);
});
