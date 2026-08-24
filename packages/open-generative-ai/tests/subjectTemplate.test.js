// Subject stand-ins: the anchor that lets a prose prompt be recast onto
// whoever is in the shot. See src/lib/subjectTemplate.js.
import assert from 'node:assert/strict';
import test from 'node:test';

const load = () => import('../src/lib/subjectTemplate.js');

const KOREAN = '[Shot 1] {subject:A Korean {woman} in {her} early twenties} (S1) sits on a low concrete wall'
  + '{look:; {she} has natural skin texture and {f:almost no makeup, black wavy hair}{m:short black hair}{nb:black wavy hair tied back}, '
  + 'black canvas sneakers}. {She} smiles to {herself}.';

test('a template renders to plain prose for a gender, and records the stand-in as rendered', async () => {
    const { renderSubjectTemplate } = await load();
    const female = renderSubjectTemplate(KOREAN, { gender: 'female' });
    assert.equal(female.text,
        '[Shot 1] A Korean woman in her early twenties (S1) sits on a low concrete wall; she has natural skin '
        + 'texture and almost no makeup, black wavy hair, black canvas sneakers. She smiles to herself.');
    assert.deepEqual(female.standIns, [{
        index: 1,
        phrases: ['A Korean woman in her early twenties'],
        looks: ['; she has natural skin texture and almost no makeup, black wavy hair, black canvas sneakers'],
    }]);

    const male = renderSubjectTemplate(KOREAN, { gender: 'male' });
    assert.match(male.text, /^\[Shot 1\] A Korean man in his early twenties \(S1\) sits/);
    assert.equal(male.standIns[0].phrases[0], 'A Korean man in his early twenties');
    assert.match(male.standIns[0].looks[0], /short black hair/);
});

test('a template with no stand-in tokens is ordinary gender-templated text', async () => {
    const { renderSubjectTemplate, hasSubjectTokens } = await load();
    const out = renderSubjectTemplate('The {woman} waves at {her} friend.', { gender: 'male' });
    assert.equal(out.text, 'The man waves at his friend.');
    assert.deepEqual(out.standIns, []);
    assert.equal(hasSubjectTokens('The {woman} waves.'), false);
    assert.equal(hasSubjectTokens('{subject:The {woman}} waves.'), true);
});

test('binding swaps every phrase for the slot label and drops the look, punctuation intact', async () => {
    const { renderSubjectTemplate, bindStandIns } = await load();
    const { text, standIns } = renderSubjectTemplate(KOREAN, { gender: 'female' });
    const bound = bindStandIns(text, standIns, (index) => `<Subject ${index}>`);
    assert.equal(bound.text,
        '[Shot 1] <Subject 1> (S1) sits on a low concrete wall. She smiles to herself.');
    assert.deepEqual(bound.bound, [1]);
    assert.deepEqual(bound.remaining, []);
    assert.deepEqual(bound.unmatched, []);
});

test('a second stand-in binds independently, and an unfilled slot stays as written', async () => {
    const { renderSubjectTemplate, bindStandIns } = await load();
    const template = '{subject:A tall {woman}} argues with {subject2:a short bald man}{look2:, in a brown coat}.';
    const { text, standIns } = renderSubjectTemplate(template, { gender: 'female' });
    assert.equal(text, 'A tall woman argues with a short bald man, in a brown coat.');
    assert.equal(standIns.length, 2);
    // Only one member in the cast: subject 2 has nobody to bind to.
    const one = bindStandIns(text, standIns, (index) => (index === 1 ? '<Subject 1>' : null));
    assert.equal(one.text, '<Subject 1> argues with a short bald man, in a brown coat.');
    assert.deepEqual(one.bound, [1]);
    assert.equal(one.remaining.length, 1);
    assert.equal(one.remaining[0].index, 2);
    // Binding the remainder later finishes the job.
    const two = bindStandIns(one.text, one.remaining, () => 'SpongeBob SquarePants');
    assert.equal(two.text, '<Subject 1> argues with SpongeBob SquarePants.');
});

test('a phrase the user has edited away is refused, never half-bound', async () => {
    const { bindStandIns } = await load();
    const standIns = [{ index: 1, phrases: ['A Korean woman in her early twenties'], looks: ['; she has black hair'] }];
    const edited = 'A Korean girl in her early twenties sits; she has black hair.';
    const out = bindStandIns(edited, standIns, () => '<Subject 1>');
    assert.equal(out.text, edited, 'nothing touched');
    assert.deepEqual(out.unmatched, [1]);
    assert.equal(out.remaining.length, 1);
});

test('a stand-in named twice binds at both mentions', async () => {
    const { renderSubjectTemplate, bindStandIns } = await load();
    const template = '{subject:A young {woman}} walks in. Later {subject:the same young {woman}} leaves.';
    const { text, standIns } = renderSubjectTemplate(template, { gender: 'female' });
    assert.equal(standIns[0].phrases.length, 2);
    const bound = bindStandIns(text, standIns, () => '<Subject 1>');
    assert.equal(bound.text, '<Subject 1> walks in. Later <Subject 1> leaves.');
});

test('liveStandIns keeps only the records whose words are still in the text', async () => {
    const { liveStandIns } = await load();
    const standIns = [
        { index: 1, phrases: ['A young woman'], looks: [] },
        { index: 2, phrases: ['a short man'], looks: [] },
    ];
    assert.deepEqual(liveStandIns('A young woman waves.', standIns).map((s) => s.index), [1]);
    assert.deepEqual(liveStandIns('', standIns), []);
});

test('the grammar tolerates an unterminated token by leaving the rest alone', async () => {
    const { renderSubjectTemplate } = await load();
    const out = renderSubjectTemplate('{subject:A {woman} walks', { gender: 'male' });
    assert.equal(out.text, '{subject:A man walks');
    assert.deepEqual(out.standIns, []);
});
