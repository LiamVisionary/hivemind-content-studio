// The Story studio's pure logic. Every test is named after the thing that goes
// wrong when the rule is missing.
import assert from 'node:assert/strict';
import test from 'node:test';

const loadConcept = () => import('../src/studios/story/concept.js');
const loadSheet = () => import('../src/studios/story/characterSheet.js');
const loadLocation = () => import('../src/studios/story/location.js');
const loadBoard = () => import('../src/studios/story/board.js');
const loadMotion = () => import('../src/studios/story/motionScript.js');
const loadQa = () => import('../src/studios/story/qa.js');
const loadState = () => import('../src/studios/story/state.js');
const loadFields = () => import('../src/studios/story/fields.js');
const loadLayout = () => import('../src/studios/story/sheetLayout.js');

/* ---------------- concept: options before decisions ---------------- */

test('a half-filled brief still asks a complete question', async () => {
  const { conceptBrief } = await loadConcept();

  const brief = conceptBrief({ person: 'a lighthouse keeper', count: 10 });

  // Blank fields become "your choice" rather than vanishing: a brief missing
  // its "world" line reads to the producer as a brief about no world.
  assert.match(brief, /Human: a lighthouse keeper/);
  assert.match(brief, /Companion: your choice/);
  assert.match(brief, /How many concepts: 10/);
});

test('the concept count is clamped, because three is not a comparison', async () => {
  const { conceptCount } = await loadConcept();

  assert.equal(conceptCount(1), 3);
  assert.equal(conceptCount(50), 12);
  assert.equal(conceptCount('not a number'), 8);
});

test('a concept with no usable text is dropped rather than shown as an empty card', async () => {
  const { normalizeConcepts } = await loadConcept();

  const rows = normalizeConcepts({
    concepts: [
      { pair: 'a keeper and a gull', hook: 'the lamp', friction: '', reward: '', signature: '' },
      { id: 'B', title: 'nothing' },
      {},
    ],
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'A');
});

test('normalizing never returns more concepts than were asked for', async () => {
  const { normalizeConcepts } = await loadConcept();
  const concepts = Array.from({ length: 11 }, (_, i) => ({ pair: `pair ${i}` }));

  assert.equal(normalizeConcepts({ concepts }, { count: 5 }).length, 5);
});

test('an unfinished contract shows its blanks instead of reading as finished', async () => {
  const { contractSentence, contractBlanks } = await loadConcept();

  const contract = { pressure: 'the shop has to close', who: 'the florist' };

  assert.match(contractSentence(contract), /When the shop has to close happens, the florist tries to ___/);
  assert.deepEqual(contractBlanks(contract), ['goal', 'other', 'behavior', 'reward']);
});

test('a contact sheet of one direction is not a comparison, but of none is nothing', async () => {
  const { contactSheetPrompt } = await loadConcept();

  assert.equal(contactSheetPrompt([]), '');
  assert.match(contactSheetPrompt([{ pair: 'a keeper and a gull' }]), /1 numbered cells/);
});

/* ---------------- character sheet: the identity contract ---------------- */

test('the sheet prompt refuses the four things that stop a sheet being a reference', async () => {
  const { characterSheetPrompt } = await loadSheet();

  const prompt = characterSheetPrompt({ name: 'Rell', silhouette: 'heavy shoulders' });

  for (const banned of [/no dramatic perspective/, /no action pose/, /no extra props/, /no decorative typography/]) {
    assert.match(prompt, banned);
  }
  assert.match(prompt, /front, exact side profile, and back/);
});

test('a character with nothing locked produces no sheet prompt at all', async () => {
  const { characterSheetPrompt, unlockedCharacters, blankCharacter } = await loadSheet();

  // Otherwise the model is handed "draw three views of the character" with no
  // character in it, and invents one — which then becomes the reference.
  assert.equal(characterSheetPrompt(blankCharacter()), '');
  assert.equal(unlockedCharacters([blankCharacter(), { silhouette: 'tall' }]).length, 1);
});

test('an empty never-change list falls back to the locks rather than to nothing', async () => {
  const { neverChangeLine } = await loadSheet();

  const line = neverChangeLine({ silhouette: 'broad wings', signature: 'a torn wingtip' });

  assert.equal(line, 'broad wings; a torn wingtip');
  assert.equal(neverChangeLine({ never: 'the band stays one band' }), 'the band stays one band');
});

/* ---------------- location: empty on purpose ---------------- */

test('the plate prompt says "no characters" twice, because once is ignored', async () => {
  const { locationPrompt } = await loadLocation();

  const prompt = locationPrompt({ place: 'a tram shelter', motion: ['rain'] }, { aspect: '9:16' });

  assert.match(prompt, /with no characters in it/);
  assert.match(prompt, /Empty of people and animals/);
});

test('a location with nothing that can move is reported before it is drawn', async () => {
  const { locationGaps } = await loadLocation();

  const gaps = locationGaps({ place: 'a tram shelter', time: 'dusk', depth: 'shelter then harbour' });

  assert.equal(gaps.length, 1);
  assert.match(gaps[0], /nothing to animate/);
});

test('a nameless place produces no prompt', async () => {
  const { locationPrompt, blankLocation } = await loadLocation();

  assert.equal(locationPrompt(blankLocation()), '');
});

/* ---------------- board: change, not four copies ---------------- */

test('four panels is the default, and a critical action overrides everything', async () => {
  const { recommendBoard } = await loadBoard();

  assert.equal(recommendBoard({ beats: 3, seconds: 15 }).id, 'four');
  assert.equal(recommendBoard({ beats: 3, seconds: 15, criticalAction: true }).id, 'precision');
  assert.equal(recommendBoard({ beats: 12, seconds: 15 }).id, 'sixteen');
});

test('beats crowded past one every two and a half seconds is montage, not performance', async () => {
  const { recommendBoard } = await loadBoard();

  assert.equal(recommendBoard({ beats: 8, seconds: 15 }).id, 'sixteen');
  assert.equal(recommendBoard({ beats: 4, seconds: 15 }).id, 'four');
});

test('a board where every panel is the same shot fails the squint test', async () => {
  const { boardWarnings } = await loadBoard();

  const panels = Array.from({ length: 4 }, (_, i) => ({
    n: i + 1, verb: `action ${i}`, shot: 'close', reason: 'a thing',
  }));

  assert.match(boardWarnings(panels).join(' '), /same shot/);
});

test('the same action written into two panels is reported', async () => {
  const { boardWarnings } = await loadBoard();

  const panels = [
    { n: 1, verb: 'she closes the shop', shot: 'wide', reason: 'a' },
    { n: 2, verb: 'She closes the shop', shot: 'close', reason: 'b' },
  ];

  assert.match(boardWarnings(panels).join(' '), /same action appears/);
});

test('a shot with no reason is caught, because that is what an unmotivated camera is', async () => {
  const { boardWarnings, CAMERA_MOTIVATION_TEST } = await loadBoard();

  const warnings = boardWarnings([{ n: 1, verb: 'she closes up', shot: 'wide', reason: '' }]);

  assert.match(warnings.join(' '), new RegExp(CAMERA_MOTIVATION_TEST.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('precision mode is one or two frames and says so when it is handed more', async () => {
  const { boardWarnings, defaultPanels } = await loadBoard();

  assert.equal(defaultPanels('precision').length, 2);
  assert.match(boardWarnings(defaultPanels('four'), 'precision').join(' '), /one or two frames/);
});

test('the board prompt quotes the never-change list instead of redescribing anyone', async () => {
  const { boardPrompt } = await loadBoard();

  const prompt = boardPrompt({
    format: 'four',
    panels: [{ n: 1, job: 'Hook', verb: 'the moth lands', shot: 'macro', reason: 'the machine' }],
    locks: ['the torn wingtip stays on the same side'],
  });

  assert.match(prompt, /Must not drift: the torn wingtip stays on the same side/);
  assert.match(prompt, /do not redesign either/);
});

/* ---------------- motion: what the references cannot say ---------------- */

test('a beat past the end of the clip is reported, because it silently never happens', async () => {
  const { scriptWarnings } = await loadMotion();

  const warnings = scriptWarnings({
    seconds: 5,
    beats: [{ from: 0, to: 8, action: 'she opens the umbrella' }],
  });

  assert.match(warnings.join(' '), /runs to 8s but the clip is 5s/);
});

test('unscripted time is reported as time the model fills by itself', async () => {
  const { scriptWarnings } = await loadMotion();

  const warnings = scriptWarnings({ seconds: 15, beats: [{ from: 0, to: 5, action: 'a ticket blows away' }] });

  assert.match(warnings.join(' '), /Only 5s of 15s is scripted/);
});

test('three actions inside one short beat is the mushy-action failure', async () => {
  const { scriptWarnings } = await loadMotion();

  const warnings = scriptWarnings({
    seconds: 4,
    beats: [{ from: 0, to: 4, action: 'she turns then kneels then opens the umbrella', emotion: 'relief' }],
  });

  assert.match(warnings.join(' '), /packs 3 actions into 4s/);
});

test('a world with fewer than three moving depths is an animated poster', async () => {
  const { scriptWarnings } = await loadMotion();

  const warnings = scriptWarnings({
    seconds: 5,
    beats: [{ from: 0, to: 5, action: 'she waits', emotion: 'patience' }],
    force: 'rain',
    layers: { subject: 'her breath' },
    camera: 'one wide',
    audio: 'rain on the awning',
  });

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Only 1 depth moves/);
});

test('the world-breathes sentence names the cause first', async () => {
  const { worldBreathesSentence } = await loadMotion();

  const sentence = worldBreathesSentence({
    force: 'wind off the harbour',
    layers: { cloth: 'the coat', background: 'rain layers' },
  });

  assert.equal(
    sentence,
    'Keep the world alive throughout \u2014 everything here is a response to wind off the harbour: '
    + 'the coat; rain layers.',
  );
});

test('a layer written as a clause does not end up inside "the force moves ___"', async () => {
  const { worldBreathesSentence } = await loadMotion();

  // Measured 2026-08-24: the producer writes noun phrases about half the time
  // and whole clauses the other half. "wind moves the coat shifts when the arm
  // moves" is not a sentence, and the model reads it as one anyway.
  const sentence = worldBreathesSentence({
    force: 'cold air off the water',
    layers: { cloth: 'the work coat shifts when the arm moves', light: 'the lamp swells and settles' },
  });

  assert.match(
    sentence,
    /response to cold air off the water: the work coat shifts when the arm moves; the lamp swells and settles\.$/,
  );
});

test('a force with nothing responding to it says so rather than pretending to a list', async () => {
  const { worldBreathesSentence } = await loadMotion();

  assert.equal(worldBreathesSentence({ force: 'rain' }), 'Keep the world alive throughout: rain runs through the whole shot.');
  assert.equal(worldBreathesSentence({}), '');
});

test('a script with no timed action is not a script', async () => {
  const { motionScript } = await loadMotion();

  assert.equal(motionScript({ seconds: 15, beats: [{ from: 0, to: 5, action: '' }] }), '');
});

test('the script tells the model the board is direction, not a shot list', async () => {
  const { motionScript } = await loadMotion();

  const script = motionScript({ seconds: 15, beats: [{ from: 0, to: 5, action: 'a ticket blows away' }] });

  assert.match(script, /not a rigid shot list/);
  assert.match(script, /No aimless zoom/);
});

test('tightening takes the article with the noun it removes', async () => {
  const { tighten } = await loadMotion();

  // "a masterpiece, wind lifts the coat" losing only the noun leaves "a, wind
  // lifts the coat" — a worse sentence than the one it replaced.
  assert.equal(tighten('a masterpiece, 8k, slow zoom on the dog.'), 'on the dog.');
  assert.equal(
    tighten('rain crosses the frame, cinematic lighting, and the coat lifts.'),
    'rain crosses the frame, and the coat lifts.',
  );
});

test('the budget report says what would be saved before anything is edited', async () => {
  const { budgetReport } = await loadMotion();

  const report = budgetReport('a masterpiece shot, 8k, of the dog.', { limit: 10 });

  assert.equal(report.fits, false);
  assert.equal(report.over, report.chars - 10);
  assert.ok(report.savings > 0);
  assert.deepEqual(report.emptyPhrases.sort(), ['8k', 'masterpiece']);
});

test('no limit means the compressor stays out of the way', async () => {
  const { budgetReport } = await loadMotion();

  assert.equal(budgetReport('anything at all', { limit: 0 }).fits, true);
  assert.equal(budgetReport('anything at all', { limit: 0 }).over, 0);
});

test('a thirty-second story is split into generations that each have one job', async () => {
  const { segmentPlan } = await loadMotion();

  const plan = segmentPlan({ totalSeconds: 30, perGeneration: 15 });

  assert.equal(plan.length, 2);
  assert.equal(plan[0].seconds, 15);
  // Only the seam carries a handoff rule; the last generation has nothing to
  // hand off to, and a boundary note there would be noise.
  assert.match(plan[0].boundary, /stable pose/);
  assert.equal(plan[1].boundary, '');
});

test('a story that fits in one generation is not split', async () => {
  const { segmentPlan } = await loadMotion();

  assert.equal(segmentPlan({ totalSeconds: 15, perGeneration: 15 }).length, 1);
});

/* ---------------- the gate ---------------- */

test('one blocking failure blocks, however many soft checks pass', async () => {
  const { shipVerdict, QA_CHECKS } = await loadQa();

  const verdicts = Object.fromEntries(QA_CHECKS.map((check) => [check.id, 'pass']));
  verdicts.identity = 'fail';

  assert.equal(shipVerdict(verdicts).state, 'blocked');
});

test('a soft failure is a repair decision, not a block', async () => {
  const { shipVerdict, QA_CHECKS } = await loadQa();

  const verdicts = Object.fromEntries(QA_CHECKS.map((check) => [check.id, 'pass']));
  verdicts.world = 'fail';

  assert.equal(shipVerdict(verdicts).state, 'repair');
});

test('an unrun check is not a pass', async () => {
  const { shipVerdict } = await loadQa();

  const verdict = shipVerdict({ identity: 'pass' });

  assert.equal(verdict.state, 'untested');
  assert.ok(verdict.untested.length > 0);
});

test('every check offers a repair, and every repair names one stage to change', async () => {
  const { QA_CHECKS, repairsFor } = await loadQa();

  for (const check of QA_CHECKS) {
    const repairs = repairsFor(check.id);
    assert.ok(repairs.length, `${check.id} has no repair`);
    for (const repair of repairs) assert.ok(repair.stage, `${repair.id} names no stage`);
  }
});

test('two calls to action are reported, because splitting attention costs both', async () => {
  const { buildCaption } = await loadQa();

  const { problems } = buildCaption({ hook: 'He had not looked up all night.', cta: 'save this and follow' });

  assert.match(problems.join(' '), /2 calls to action/);
});

test('a caption with no hook is reported before it is published', async () => {
  const { buildCaption } = await loadQa();

  assert.match(buildCaption({ cta: 'save' }).problems.join(' '), /No micro-hook/);
});


/* ---------------- restore: a production outlives the shape it was saved in ---------------- */

test('a story saved before a field existed comes back with that field', async () => {
  const { restoreStory, blankStory } = await loadState();

  // A shallow spread replaces the whole sub-object, so a board saved without
  // `panels` restores as `panels: undefined` and the first render throws.
  const restored = restoreStory({ board: { format: 'sixteen', sheetUrl: 'ref://board' } });

  assert.equal(restored.board.format, 'sixteen');
  assert.equal(restored.board.sheetUrl, 'ref://board');
  assert.equal(restored.board.panels.length, 16);
  assert.deepEqual(Object.keys(restored).sort(), Object.keys(blankStory()).sort());
});

test('a restore keeps what was written and fills only what is missing', async () => {
  const { restoreStory } = await loadState();

  const restored = restoreStory({
    motion: { seconds: 8, beats: [{ from: 0, to: 8, action: 'she waits', emotion: 'patience' }] },
    location: { place: 'a pier' },
  });

  assert.equal(restored.motion.seconds, 8);
  assert.equal(restored.motion.beats.length, 1);
  assert.equal(restored.motion.beats[0].action, 'she waits');
  assert.equal(restored.location.place, 'a pier');
  assert.deepEqual(restored.location.motion, []);
  assert.equal(restored.motion.music, 'none');
});

test('a corrupt restore renders the defaults rather than a blank studio', async () => {
  const { restoreStory } = await loadState();

  const restored = restoreStory({
    concepts: 'not a list', characters: null, board: { panels: 'nope' }, motion: { beats: [] },
    location: { motion: 'rain' },
  });

  assert.deepEqual(restored.concepts, []);
  assert.deepEqual(restored.characters, []);
  assert.equal(restored.board.panels.length, 4);
  assert.equal(restored.motion.beats.length, 3);
  assert.deepEqual(restored.location.motion, []);
});

test('nothing saved yet restores as a fresh production', async () => {
  const { restoreStory, blankStory } = await loadState();

  assert.deepEqual(restoreStory(null).brief, blankStory().brief);
  assert.deepEqual(restoreStory({}).brief, blankStory().brief);
});

test('a saved board keeps its writing when the scaffold is rebuilt to match the format', async () => {
  const { restoreStory } = await loadState();

  const restored = restoreStory({
    board: { format: 'sixteen', panels: [{ n: 1, job: 'Hook', verb: 'the moth lands' }] },
  });

  assert.equal(restored.board.panels.length, 16);
  assert.equal(restored.board.panels[0].verb, 'the moth lands');
  assert.equal(restored.board.panels[15].n, 16);
});

/* ---------------- the producer client, and the wiring that broke ---------------- */

test('a short answer comes back with its notes rather than as a bare result', async () => {
  // The studio has to be able to say "two of eight". Returning `payload.result`
  // alone presented a salvaged answer as the whole one.
  const { askProducer } = await import('../src/lib/localProducer.js');
  const calls = [];
  global.fetch = async (path, init) => {
    calls.push(path);
    const body = path === '/api/prompt-helper/runtime'
      ? { models: [{ id: 'm', fit: 'loaded' }] }
      : { ok: true, result: { concepts: [{ id: 'A' }] }, notes: ['ran out of room'] };
    return { ok: true, json: async () => body };
  };

  const answer = await askProducer({ modelId: 'm', task: 'concepts', brief: 'x' });

  assert.deepEqual(answer.result, { concepts: [{ id: 'A' }] });
  assert.deepEqual(answer.notes, ['ran out of room']);
  assert.ok(calls.includes('/api/story/producer'));
});

test('a response with no notes still answers with a list, not undefined', async () => {
  const { askProducer } = await import('../src/lib/localProducer.js');
  global.fetch = async (path) => ({
    ok: true,
    json: async () => (path === '/api/prompt-helper/runtime'
      ? { models: [{ id: 'm', fit: 'loaded' }] }
      : { ok: true, result: {} }),
  });

  const answer = await askProducer({ modelId: 'm', task: 'concepts' });

  assert.deepEqual(answer.notes, []);
});

test('a loaded model is not loaded again', async () => {
  const { ensureProducerModel } = await import('../src/lib/localProducer.js');
  const calls = [];
  global.fetch = async (path) => {
    calls.push(path);
    return { ok: true, json: async () => ({ models: [{ id: 'm', fit: 'loaded' }] }) };
  };

  await ensureProducerModel('m');

  assert.deepEqual(calls, ['/api/prompt-helper/runtime']);
});

test('no producer button gates its spinner on the status text', async () => {
  // The bug this pins: the busy flag and the status message were one string.
  // `setThinking('concepts…')` drove `loading={thinking === 'concepts…'}`, and
  // askProducer's own onStatus overwrote it on the first tick — so the spinner
  // vanished while the button stayed disabled, which is a dead button.
  const { readFile } = await import('node:fs/promises');
  const raw = await readFile(new URL('../src/studios/StoryStudio.jsx', import.meta.url), 'utf8');
  // Comment lines are dropped: the fix's own comment quotes the broken
  // expression, and an assertion that its own explanation trips is useless.
  const source = raw.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');

  assert.equal(/loading=\{thinking\s*===/.test(source), false);
  assert.equal(/disabled=\{Boolean\(thinking\)\}/.test(source), false);
  // Every task the studio asks for has a spinner keyed to the run itself.
  for (const task of ['concepts', 'shortlist', 'contract', 'location', 'board', 'beats', 'compress']) {
    assert.ok(source.includes(`busy === '${task}'`), `${task} has no spinner of its own`);
  }
});

test('one character card drawing a sheet does not spin the other card', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/studios/StoryStudio.jsx', import.meta.url), 'utf8');

  // Both cards rendered `loading={drawing === 'character sheet'}`, so drawing
  // the second one showed the first one working too.
  assert.equal(source.includes("drawing === 'character sheet'"), false);
  assert.ok(source.includes('drawing === `sheet:${index}`'));
});

test('an idle row does not report itself as working', async () => {
  // Both sides are empty in their resting state — nothing running is busy: '',
  // and a row that is not the one asking passes task: ''. A bare `busy !== task`
  // bail let every idle row through, so each concept card carried a permanent
  // "Working…" and a Cancel button beside its Lock button.
  const { producerIsRunning } = await loadState();

  assert.equal(producerIsRunning('', ''), false);
  assert.equal(producerIsRunning('', 'concepts'), false);
  assert.equal(producerIsRunning('concepts', ''), false);
});

test('only the row whose ask is running reports itself as working', async () => {
  const { producerIsRunning } = await loadState();

  assert.equal(producerIsRunning('concepts', 'concepts'), true);
  assert.equal(producerIsRunning('concepts', 'board'), false);
});

test('the running-status row is never gated on a bare inequality again', async () => {
  const { readFile } = await import('node:fs/promises');
  const raw = await readFile(new URL('../src/studios/StoryStudio.jsx', import.meta.url), 'utf8');
  const source = raw.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');

  assert.equal(/if\s*\(busy\s*!==\s*task\)/.test(source), false);
  assert.ok(source.includes('producerIsRunning(busy, task)'));
});

/* ---------------- auto-fill: what the producer is told, and what it may write ---------------- */


test('a path reads and writes through lists as well as objects', async () => {
  const { readPath, writePath } = await loadFields();
  const story = { characters: [{ name: 'Rell' }, { name: 'the moth' }] };

  assert.equal(readPath(story, 'characters[1].name'), 'the moth');

  const next = writePath(story, 'characters[1].name', 'the gull');
  assert.equal(next.characters[1].name, 'the gull');
  // The original is untouched and only the nodes on the path are new, so React
  // re-renders the row that changed rather than every row.
  assert.equal(story.characters[1].name, 'the moth');
  assert.equal(next.characters[0], story.characters[0]);
});

test('a path that does not exist yet reads as empty rather than throwing', async () => {
  const { readPath } = await loadFields();

  // A character removed while its fill was in flight.
  assert.equal(readPath({}, 'characters[3].silhouette'), '');
});

test('the fields of a list section are stamped out per row, named by the row', async () => {
  const { fieldsFor } = await loadFields();

  const fields = fieldsFor('characters', { characters: [{ name: 'Rell' }, {}] });

  assert.ok(fields.some((entry) => entry.id === 'characters[1].silhouette'));
  // The guidance names who it is for, so a wand in a two-character stage does
  // not ask for "a silhouette" with no idea whose.
  assert.match(fields.find((entry) => entry.id === 'characters[0].face').hint, /Rell/);
  assert.match(fields.find((entry) => entry.id === 'characters[1].face').hint, /character 2/);
});

test('a section fill asks only for what is blank', async () => {
  const { blankFieldsIn } = await loadFields();

  const blanks = blankFieldsIn('location', { location: { place: 'a pier', time: 'dusk' } });

  // Overwriting what the director wrote is the destructive option, and a button
  // that quietly rewrites your sentences is not one you press twice.
  assert.equal(blanks.some((entry) => entry.id === 'location.place'), false);
  assert.ok(blanks.some((entry) => entry.id === 'location.weather'));
});

test('the context is the whole production, not the stage the field is in', async () => {
  const { storyContext } = await loadFields();

  const context = storyContext({
    brief: { person: 'a night bus driver' },
    contract: { behavior: 'landing on the ticket' },
    location: { place: 'a terminus' },
    motion: { force: 'cold air', seconds: 15, layers: {}, beats: [] },
  });

  // A caption's hook is better for knowing the signature detail six stages up.
  assert.equal(context['brief.person'], 'a night bus driver');
  assert.equal(context['contract.behavior'], 'landing on the ticket');
  assert.equal(context['location.place'], 'a terminus');
  assert.equal(context['motion.seconds'], '15s');
});

test('a field is not offered as evidence for itself', async () => {
  const { storyContext } = await loadFields();
  const story = { location: { place: 'a terminus', time: 'dusk' } };

  const context = storyContext(story, { omit: ['location.time'] });

  // Sent its own current value, a small model returns it unchanged and the
  // button looks broken.
  assert.equal(context['location.place'], 'a terminus');
  assert.equal('location.time' in context, false);
});

test('empty fields are dropped rather than sent as blanks', async () => {
  const { storyContext } = await loadFields();

  const context = storyContext({ brief: { person: 'a driver', world: '   ' } });

  // A wall of empty keys reads to a small model as a form, and it fills all of it.
  assert.equal('brief.world' in context, false);
  assert.deepEqual(Object.keys(context), ['brief.person']);
});

test('the ask puts the id first, because it has to come back spelled the same', async () => {
  const { fillBrief } = await loadFields();

  const brief = fillBrief([
    { id: 'location.time', label: 'Time', hint: 'Time of day.' },
    { id: 'board.panels[0].shot', label: 'Panel 1 — shot', hint: 'Which shot.', options: ['macro', 'wide'] },
  ]);

  assert.match(brief, /^Write these 2 fields:/);
  assert.match(brief, /- location\.time \(Time\): Time of day\./);
  assert.match(brief, /Answer with exactly one of: macro, wide\./);
  assert.match(brief, /spelled exactly as written here/);
});

test('one field asks in the singular', async () => {
  const { fillBrief } = await loadFields();

  assert.match(fillBrief([{ id: 'title', label: 'Title', hint: 'Two or three words.' }]), /^Write this one field:/);
  assert.equal(fillBrief([]), '');
});

test('only the fields that were asked for may be written', async () => {
  const { acceptedValues } = await loadFields();

  const accepted = acceptedValues(
    [{ id: 'location.time' }, { id: 'location.weather' }],
    { 'location.time': 'dusk', 'location.smell': 'salt', 'location.weather': '  ' },
  );

  // A field nobody asked for would be written into a path the studio has not
  // got; an empty one would blank a box the director might have filled.
  assert.deepEqual(accepted, { 'location.time': 'dusk' });
});

test('an options field refuses prose', async () => {
  const { acceptedValues } = await loadFields();
  const entries = [{ id: 'board.panels[0].shot', options: ['macro', 'wide'] }];

  assert.deepEqual(acceptedValues(entries, { 'board.panels[0].shot': 'a tight macro shot' }), {});
  assert.deepEqual(acceptedValues(entries, { 'board.panels[0].shot': 'macro' }), { 'board.panels[0].shot': 'macro' });
});

test('every fillable field carries guidance the producer can act on', async () => {
  const { allFields } = await loadFields();

  const fields = allFields({
    characters: [{ name: 'Rell' }],
    board: { panels: [{ n: 1, job: 'Hook' }] },
    motion: { beats: [{ from: 0, to: 5 }], layers: {} },
  });

  assert.ok(fields.length > 30);
  for (const entry of fields) {
    assert.ok(entry.label, `${entry.id} has no label`);
    assert.ok(entry.hint && entry.hint.length > 15, `${entry.id} has no usable guidance`);
  }
  // Ids are unique — two fields sharing one would write into each other.
  assert.equal(new Set(fields.map((entry) => entry.id)).size, fields.length);
});

/* ---------------- sheet geometry: the stretched board ---------------- */

test('a grid sheet is asked for on the canvas its own cells fit, not a guessed one', async () => {
  const { sheetLayout } = await loadLayout();

  // The reported bug, as arithmetic: four 9:16 panels 2x2 were drawn on a 16:9
  // canvas, whose 2x2 cells are 16:9. Nothing can be both, so the panels came
  // back stretched sideways.
  const vertical = sheetLayout({ cell: '9:16', cols: 2, rows: 2 });
  assert.equal(vertical.canvas, '9:16');
  assert.equal(vertical.panel, '9:16');
  assert.equal(vertical.exact, true);

  const landscape = sheetLayout({ cell: '16:9', cols: 2, rows: 2 });
  assert.equal(landscape.canvas, '16:9');
  assert.equal(landscape.panel, '16:9');
});

test('the stated panel ratio is the one the canvas yields, never the one that was wanted', async () => {
  const { sheetLayout, ratioValue } = await loadLayout();

  // Two frames side by side of a 9:16 clip needs a 9:8 canvas, which no model
  // offers. The layout says what the cells will ACTUALLY be, and flags it.
  const pair = sheetLayout({ cell: '9:16', cols: 2, rows: 1 });
  assert.equal(pair.exact, false);
  const cell = ratioValue(pair.canvas) * (pair.rows / pair.cols);
  assert.ok(Math.abs(cell - ratioValue(pair.panel)) < 1e-9, 'the panel ratio must be the canvas divided by the grid');
});

test('the board prompt and the board canvas come from one decision', async () => {
  const { boardLayout, boardPrompt, defaultPanels } = await loadBoard();

  for (const aspect of ['9:16', '16:9', '1:1']) {
    for (const format of ['four', 'sixteen']) {
      const layout = boardLayout(format, aspect);
      const prompt = boardPrompt({ format, panels: defaultPanels(format), aspect });
      assert.equal(layout.canvas, aspect, `${format} @ ${aspect} should be drawn at the clip's own ratio`);
      assert.match(prompt, new RegExp(`in a ${layout.grid} grid`));
      assert.match(prompt, new RegExp(`single ${layout.canvas} canvas`));
      // No cell ratio is claimed: a cell IS the canvas divided by the grid, and
      // a stated number can be contradicted by a provider that snaps the canvas.
      assert.equal(/numbered \d+:\d+ panels/.test(prompt), false);
    }
  }
});

test('when the panels cannot be the clip ratio the board says what to compose for', async () => {
  const { boardPrompt, defaultPanels } = await loadBoard();

  const prompt = boardPrompt({ format: 'precision', panels: defaultPanels('precision'), aspect: '16:9' });

  assert.match(prompt, /while the clip is 16:9/);
  assert.match(prompt, /rather than stretching anything to fill it/);
});

test('a contact sheet of four directions is not four slivers on a square canvas', async () => {
  const { contactSheetLayout, contactSheetPrompt } = await loadConcept();

  const layout = contactSheetLayout(4);
  assert.ok(layout.cols > 1 && layout.rows > 1, `4 cells should be a block, got ${layout.grid}`);

  const prompt = contactSheetPrompt([{ pair: 'a' }, { pair: 'b' }, { pair: 'c' }, { pair: 'd' }]);
  assert.match(prompt, new RegExp(`${layout.cols}-across grid on a single ${layout.canvas} canvas`));
});

/* ---------------- auto-fill: one ask that cannot finish ---------------- */

test('a section fill is split into asks a local model can finish', async () => {
  const { fieldsFor, fillChunks } = await loadFields();

  const story = { motion: { seconds: 15, beats: [{ from: 0, to: 5 }, { from: 5, to: 10 }, { from: 10, to: 15 }] } };
  const entries = fieldsFor('motion', story);
  assert.ok(entries.length > 12, 'the motion stage is the big one');

  const chunks = fillChunks(entries);
  assert.ok(chunks.length > 1, 'seventeen prose fields in one answer is what ran out of room');
  // Nothing dropped, nothing reordered, nothing asked for twice.
  assert.deepEqual(chunks.flat().map((entry) => entry.id), entries.map((entry) => entry.id));
  for (const chunk of chunks) {
    const weight = chunk.reduce((total, entry) => total + (entry.kind === 'text' ? 2 : 1), 0);
    assert.ok(weight <= 6 || chunk.length === 1, `a chunk weighing ${weight} is another answer that will not finish`);
  }
});

test('one field asked for on its own stays one ask', async () => {
  const { fillChunks } = await loadFields();

  assert.equal(fillChunks([{ id: 'style', kind: 'text' }]).length, 1);
  assert.deepEqual(fillChunks([]), []);
});
