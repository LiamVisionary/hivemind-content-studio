// The chain that finds a model's picture, its blurb and its links.
//
// Every network call is injected, so these are the decisions themselves: which
// name is searched for where, which of two candidates is the model rather than
// a repack of it, which picture is the model's output rather than a diagram of
// its architecture, and which paragraph is a description rather than a referral
// code. Each case below is one that actually went wrong against the live APIs
// while this was being built.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  aboutQuality, matchScore, mergeCards, modelPhrase, modelSearchQueries,
  pickRepoImage, readmeSummary, resolveModelCard,
} = require('../model-artwork.js');

const sibling = (rfilename, size = 100_000) => ({ rfilename, size });

/* ---------------- what gets searched for ---------------- */

test('a lane title is cut back to the model it runs', () => {
  assert.equal(modelPhrase('Krea 2 Turbo - Identity Optional'), 'Krea 2 Turbo');
  assert.equal(modelPhrase('LTX 2.3 Transition LoRA'), 'LTX 2.3');
  assert.equal(modelPhrase('MiniMax H3 Head Replacement'), 'MiniMax H3');
  assert.equal(modelPhrase('Z-Image Turbo LoRA Optimizer'), 'Z-Image Turbo');
});

test('the two catalogues are searched under the names they each use', () => {
  const model = {
    name: 'LTX 2.3 Regular FP8',
    family: 'ltx-2.3',
    compatibleBaseModels: ['LTXV'],
  };
  // Civitai's vocabulary is the base-model tag, so it leads there.
  assert.equal(modelSearchQueries(model)[0], 'LTXV');
  // Hugging Face names repos after the release. Searching it for "LTXV" finds a
  // GGUF repack and never reaches Lightricks' own repo.
  assert.equal(modelSearchQueries(model, { prefer: 'name' })[0], 'LTX 2.3');
});

test('a camel-cased base model is also offered spelled out', () => {
  const queries = modelSearchQueries({ name: 'Z-Image Turbo LoRA Optimizer', compatibleBaseModels: ['ZImageTurbo'] });
  assert.ok(queries.includes('ZImageTurbo'));
  assert.ok(queries.includes('ZImage Turbo'), `expected a spelled-out spelling in ${queries.join(', ')}`);
});

/* ---------------- which hit is the model ---------------- */

test('a name match separates the model from something built on it', () => {
  assert.equal(matchScore('MiniMax H3', 'MiniMax H3'), 1);
  // Somebody's workflow post, not the model.
  assert.ok(matchScore('MiniMax H3', 'MiniMax H3 Remix') < 1);
  // A quantisation is the same model, so its extra word costs nothing.
  assert.equal(matchScore('MiniMax H3', 'MiniMax-H3-GGUF'), 1);
  // A different model that happens to share a word is not a match.
  assert.ok(matchScore('Krea 2', 'Flux.2 Klein 9B') < 0.6);
  // The one that put an installer's asset repo on four Anima workflows: one
  // generic word in common, three words of its own.
  assert.ok(matchScore('auto', 'ComfyUI-Auto-Installer-Assets') < 0.6);
});

test('a family slug that is bookkeeping is never searched for', () => {
  // "comfy-auto" is where auto-detected workflows are filed, not a model.
  const queries = modelSearchQueries({ name: 'Wai Anima 4b Aligned', family: 'comfy-auto', compatibleBaseModels: ['Anima'] });
  assert.ok(!queries.some((query) => /auto/i.test(query)), `bookkeeping leaked into ${queries.join(', ')}`);
  assert.ok(queries.includes('Anima'));
});

/* ---------------- which picture is the model's ---------------- */

test('a showcase beats a diagram, whatever their sizes', () => {
  // The real Z-Image repo: the diagrams are small and the showcase is 6 MB, and
  // ranking on size first put the architecture sketch on the card.
  const picked = pickRepoImage([
    sibling('assets/decoupled-dmd.webp', 152_062),
    sibling('assets/leaderboard.webp', 63_754),
    sibling('assets/showcase.jpg', 6_433_750),
  ]);
  assert.equal(picked.path, 'assets/showcase.jpg');
});

test('a repo that only ships figures gets no picture at all', () => {
  assert.equal(pickRepoImage([sibling('assets/full-arch.png'), sibling('pipeline.png')]), null);
  assert.equal(pickRepoImage([]), null);
  assert.equal(pickRepoImage(undefined), null);
});

test('an unnamed picture is used when there is no named one', () => {
  const picked = pickRepoImage([sibling('images/31.jpg', 406_000), sibling('images/15.png', 480_000)]);
  assert.equal(picked.path, 'images/31.jpg');
});

/* ---------------- which paragraph is a description ---------------- */

test('promotion, disclaimers and install steps are not descriptions', () => {
  const real = 'Krea 2 is Krea’s first foundation image model, trained from scratch with a focus on how images feel rather than just what they contain. It ships in two sizes and is tuned for photorealism.';
  assert.ok(aboutQuality(real) >= 0.5);
  assert.ok(aboutQuality(`\u{1F381} Fan Registration Bonus Register to receive 1000 coins free: https://example.com/?inviteCode=rh-1325 ${real}`) < 0.5);
  assert.ok(aboutQuality(`This is not my model. Don't ask me questions. I don't know the answers. ${real}`) < 0.5);
  assert.ok(aboutQuality(`1. Setup the official codebase 2. Download the weights 3. Run inference with the command below and wait for it to finish rendering`) < 0.5);
  // A spec sheet is a list of fields, and a model card often opens with one.
  assert.ok(aboutQuality('- Model Name: Krea 2 - Version: v1.0 - Release Date: June 22 - Parameters: 12B - License: open weights for research and commercial use') < 0.5);
  // So is a code line that lost its fence.
  assert.ok(aboutQuality('pipe = Krea2Pipeline.from_pretrained("krea/Krea-2-Turbo", torch_dtype=torch.bfloat16).to("cuda") and then call it with your prompt string') < 0.5);
  // A label is not a description either.
  assert.equal(aboutQuality('Welcome to the official repository!'), 0);
});

test('a model card is read past its badges and its title', () => {
  const readme = [
    '---', 'license: apache-2.0', '---', '',
    '# LTX-2.3', '',
    '[![badge](https://img.shields.io/badge/x-y)](https://example.com)', '',
    '![banner](assets/banner.png)', '',
    'This model card focuses on the LTX-2.3 model, which is a significant update to LTX-2 with improved audio and visual quality as well as enhanced prompt adherence.',
  ].join('\n');
  assert.match(readmeSummary(readme), /^This model card focuses on the LTX-2\.3 model/);
});

/* ---------------- putting one card together ---------------- */

const card = (overrides = {}) => ({
  source: 'civitai-mirror', sourceName: 'Something', sourceUrl: 'https://civitai.red/models/1',
  artUrl: '', artKind: 'image', about: '', links: [], stats: {}, matched: 1, query: 'q',
  ...overrides,
});

test('the picture and the prose are chosen separately', () => {
  // Civitai had Krea 2's description and no gallery; the repo had the showcase.
  const description = 'Krea 2 is a foundation image model trained from scratch, tuned for how images feel rather than only for what they contain, and it ships in two sizes.';
  const merged = mergeCards([
    card({ about: description, links: [{ kind: 'civitai', label: 'Civitai', url: 'https://civitai.red/models/1' }] }),
    card({ source: 'huggingface', sourceName: 'krea/Krea-2-Turbo', artUrl: 'https://huggingface.co/x.jpg', matched: 0.9, links: [{ kind: 'huggingface', label: 'Hugging Face', url: 'https://huggingface.co/krea/Krea-2-Turbo' }] }),
  ]);
  assert.equal(merged.about, description);
  assert.equal(merged.artUrl, 'https://huggingface.co/x.jpg');
  assert.equal(merged.artSource, 'huggingface');
  // Every link found is kept: both pages are worth offering.
  assert.deepEqual(merged.links.map((link) => link.kind), ['civitai', 'huggingface']);
});

test('Civitai art wins when both have one — it is a finished generation, thumbnailed', () => {
  const merged = mergeCards([
    card({ source: 'huggingface', artUrl: 'https://huggingface.co/press.png', matched: 1 }),
    card({ source: 'civitai', artUrl: 'https://image.civitai.com/a.jpeg', matched: 0.9 }),
  ]);
  assert.equal(merged.artUrl, 'https://image.civitai.com/a.jpeg');
});

test('a page whose text is a referral code leaves the model with no blurb', () => {
  const merged = mergeCards([
    card({ about: '\u{1F381} Register to receive 1000 coins free with this invite code, then run the workflow!' }),
  ]);
  assert.equal(merged.about, '');
});

test('nothing found is an empty card, not a failure', async () => {
  const resolved = await resolveModelCard({ name: 'Nothing At All' }, {
    getJson: async () => { throw new Error('offline'); },
    getText: async () => { throw new Error('offline'); },
  });
  assert.equal(resolved.source, '');
  assert.equal(resolved.artUrl, '');
  assert.deepEqual(resolved.links, []);
});

test('a model with no name and no base model is never searched for', async () => {
  let asked = 0;
  const resolved = await resolveModelCard({}, {
    getJson: async () => { asked += 1; return []; },
    getText: async () => { asked += 1; return ''; },
  });
  assert.equal(asked, 0);
  assert.equal(resolved.source, '');
});

test('the keyed Civitai search answers first, and the open mirror is skipped', async () => {
  const asked = [];
  const resolved = await resolveModelCard({ name: 'Krea 2 Turbo', compatibleBaseModels: ['Krea 2'] }, {
    civitaiSearch: async (query) => {
      asked.push(`civitai:${query}`);
      return {
        items: [{
          id: 42,
          name: 'Krea 2',
          description: '<p>Krea 2 is a foundation image model trained from scratch, tuned for how images feel rather than only what they contain, and it ships in two sizes.</p>',
          modelVersions: [{ id: 7, images: [{ url: 'https://image.civitai.com/a.jpeg' }] }],
          stats: { downloadCount: 10, thumbsUpCount: 2 },
        }],
      };
    },
    getJson: async (url) => {
      asked.push(url);
      return [];
    },
    getText: async () => '',
  });
  assert.equal(resolved.source, 'civitai');
  assert.equal(resolved.artUrl, 'https://image.civitai.com/a.jpeg');
  // Markup never reaches the page.
  assert.match(resolved.about, /^Krea 2 is a foundation image model/);
  assert.equal(resolved.sourceUrl, 'https://civitai.com/models/42?modelVersionId=7');
  assert.ok(!asked.some((entry) => entry.includes('civitai.red')), `the mirror was asked anyway: ${asked.join(', ')}`);
  // Hugging Face still runs — it is where the model's own words live.
  assert.ok(asked.some((entry) => entry.includes('huggingface.co')));
});
