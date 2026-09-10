/* Where a model's picture, its blurb and its links come from.
 *
 * The Models page used to describe a workflow entirely in facts this repository
 * happens to hold: an id, a step count, a pixel size. None of that says what the
 * model LOOKS like, and a page of grey text is a page nobody reads. Every model
 * here is a public one — Z-Image, Krea, Flux Klein, LTX, MiniMax H3 — so its
 * artwork and its description already exist somewhere; this is the chain that
 * goes and finds them.
 *
 * The sources, and what each is good for:
 *
 *   1. civitai   — through the gateway, which holds the owner's Civitai key.
 *                  Its galleries are finished generations, already served
 *                  through a width=450 transform, so its art is both the
 *                  best-looking and by far the cheapest.
 *   2. civitai.red — the same API without a key. Reached only when the keyed
 *                  search came back without a confident answer (no key on this
 *                  machine, a rate limit, a region block).
 *   3. huggingface — the repo behind the weights, where the model's own words
 *                  live. It runs even when Civitai answered, because a source
 *                  can hold half of what a card needs: `mergeCards` takes the
 *                  picture from one and the prose from the other.
 *
 * Two rules keep this honest. A hit is only accepted when its NAME matches what
 * we searched for (`matchScore`), because a near-miss puts someone else's art on
 * your model and reads as fact. And whatever is accepted carries where it came
 * from, so the page can say "matched on Hugging Face" rather than implying this
 * repository knows something it does not.
 *
 * Everything network-shaped is injected (`deps`), so the resolution order is
 * testable without touching a third party.
 */

const HF_API = 'https://huggingface.co';
const CIVITAI_MIRROR = 'https://civitai.red';
const USER_AGENT = 'HivemindContentStudio/1.0';

// A card is worth re-checking about once a week; a miss is worth re-checking
// sooner than that, because "no match" is often a model that had not been
// published yet when the machine first asked.
const CARD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 12 * 60 * 60 * 1000;

// Above this a hit is used without hesitation; between the two it is used but
// labelled as a guess in the UI; below it, the source is skipped entirely.
//
// The floor started at 0.45 and put a ComfyUI installer's asset repo on four
// Anima workflows, complete with somebody else's artwork — a wrong picture is
// worse than no picture, and a card with a coloured tile is a card. Anything
// that only half-matches now gets nothing.
const MATCH_CONFIDENT = 0.7;
const MATCH_FLOOR = 0.6;

/* ---------------- text ---------------- */

// A paragraph that ends by handing off to a list — "Currently there are four
// variants:" — is quoted without the hand-off, which has nothing after it here.
function withoutDanglingClause(text) {
  if (!text.endsWith(':')) return text;
  const cut = text.slice(0, -1);
  const lastStop = cut.lastIndexOf('. ');
  const trimmed = lastStop > 60 ? cut.slice(0, lastStop + 1) : cut;
  // Only when what is left still says something. Trimming Z-Image's card down
  // to one line took it under the length a description has to reach, and the
  // reader got the next paragraph — a row of feature bullets — instead.
  return trimmed.length >= 120 ? trimmed : text;
}

// Model descriptions arrive as Civitai HTML and Hugging Face Markdown. Both are
// rendered as plain text, and unrendered markup is the kind of thing that ends
// up injected somewhere later.
function textFromHtml(value, limit = 600) {
  const text = String(value || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li|h\d)>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(nbsp|amp|lt|gt|quot|#39);/g, (_, entity) => (
      { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[entity] || ' '
    ))
    .replace(/\s+/g, ' ')
    .trim();
  const trimmed = withoutDanglingClause(text);
  return trimmed.length > limit ? `${trimmed.slice(0, limit - 1)}…` : trimmed;
}

// Is this paragraph the model being DESCRIBED, or something else that happens to
// sit in a description field? Both sources are full of the something else —
// Civitai pages open with giveaway spam and referral codes, model repos open
// with install steps and a list of mirror links — and printing that under a
// model's name reads as if the studio believes it. 0..1; anything under 0.5 is
// not a description.
function aboutQuality(value) {
  const text = String(value || '').trim();
  if (text.length < 120) return 0;
  // Length is a weak signal, so it is worth a little and no more: a 600-word
  // Civitai announcement is not a better description than four accurate lines
  // from the model's own card, and scoring purely on length said it was.
  let score = 0.6 + Math.min(0.4, text.length / 1500);
  const links = (text.match(/https?:\/\//g) || []).length;
  if (links >= 2) score -= 0.4;
  // Promotion, not description.
  if (/(invite ?code|register to receive|coins?\b.*(bonus|free)|discord\.gg|patreon|buy me a coffee|subscribe)/i.test(text)) score -= 0.7;
  // A re-uploader disclaiming the thing they uploaded.
  if (/(this is not my model|don'?t ask me questions|i (just|only) (uploaded|converted|quantized))/i.test(text)) score -= 0.7;
  // A list, not a paragraph: install steps, or the spec sheet a model card
  // opens with ("- Model Name: Krea 2 - Version: v1.0 - Release Date: …").
  if (/^\s*(\d[.)]\s|[-*]\s)/.test(text)) score -= 0.5;
  // A list flattened into one line: MiniMax H3's card opens with a sentence and
  // then three "- H3-Base: …" entries. No amount of length redeems that under a
  // model's name, so it is disqualifying rather than a deduction.
  if ((text.match(/\s-\s\w/g) || []).length >= 2) return 0;
  if (/^(welcome to|this (is the )?(repo|repository))/i.test(text)) score -= 0.4;
  // Code that lost its fence, or a shell line.
  if (/(\bimport\s+\w|pip install|from_pretrained|[\w)]\s*=\s*[\w"'[]|>>>|\$ \w)/.test(text)) score -= 0.5;
  return Math.max(0, Math.min(1, score));
}

// "<name> is a 2 billion parameter text-to-image model", in the first sentence
// and near its front — the shape of a sentence that introduces a thing.
const DEFINITION = /^[^.!?]{0,80}\b(is|are)\s+(a|an|the|one of|our)\b/i;

// The first real paragraph of a model card. A README opens with YAML
// frontmatter, then usually a banner image, a row of badges, a title and a
// links table — none of which is the description, so they are walked past
// rather than truncated into.
function readmeSummary(markdown, limit = 600) {
  const body = String(markdown || '')
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
    // A fenced block is code, and code with its fence stripped reads as a
    // paragraph: Krea's card put `pipe = Krea2Pipeline.from_pretrained(...)`
    // under the model's name that way.
    .replace(/```[\s\S]*?```/g, '\n\n');
  const paragraphs = body.split(/\r?\n\s*\r?\n/);
  const found = [];
  for (const raw of paragraphs) {
    const block = raw.trim();
    if (!block) continue;
    if (block.startsWith('#') || block.startsWith('<') || block.startsWith('|')) continue;
    if (/^!\[/.test(block) || /^\[!\[/.test(block)) continue;
    // Four spaces or a tab is the other way Markdown marks code.
    if (/^(?: {4}|\t)/.test(raw)) continue;
    const text = textFromHtml(block
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*_`>#]/g, ' ')
      // Markdown escapes: a card written with them reads as "cross\-modal".
      .replace(/\\([\\`*_{}[\]()#+\-.!])/g, '$1'), limit);
    if (aboutQuality(text) >= 0.5) found.push(text);
  }
  // Best first: a paragraph that DEFINES the model ("Krea 2 is a text-to-image
  // diffusion model…") is what a card wants; then anything that does not open
  // on a pronoun, which was written to follow a paragraph this is not showing;
  // then whatever qualified at all.
  return found.find((text) => DEFINITION.test(text))
    || found.find((text) => !/^(it|its|they|these|this|that|there)\b/i.test(text))
    || found[0]
    || '';
}

/* ---------------- name matching ---------------- */

const NAME_NOISE = new Set([
  'the', 'a', 'an', 'and', 'of', 'for', 'with', 'v', 'ai',
  'model', 'models', 'workflow', 'lane', 'comfy', 'comfyui', 'mlx', 'native',
  'fp8', 'q8', 'bf16', 'fp16', 'gguf', 'safetensors', 'pruned', 'quantized',
  'lora', 'loras', 'ic', 'dmd', 'distilled', 'optimizer', 'optional',
  'regular', 'better', 'edit', 'image', 'video', 'base', 'full', 'official',
]);

function nameTokens(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[._/\\-]+/g, ' ')
    .replace(/[^a-z0-9. ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** How well `candidate` answers `query`, 0..1. Shared tokens over what was asked
 *  for — a repo called "Z-Image-Turbo" answers "Z Image Turbo" completely, while
 *  "Z-Image-Turbo-Fun-Controlnet-Union" answers it fully too and is separated by
 *  the length penalty rather than by pretending it is a different model. */
function matchScore(query, candidate) {
  const wanted = nameTokens(query).filter((token) => !NAME_NOISE.has(token));
  if (!wanted.length) return 0;
  const have = new Set(nameTokens(candidate));
  const hits = wanted.filter((token) => have.has(token)).length;
  const base = hits / wanted.length;
  // Extra words in the candidate mean it is something more specific than what
  // was asked for — "MiniMax H3 Remix" is somebody's workflow post, not the
  // model — so each one costs it. They cost more against a ONE-WORD query,
  // where a single shared word is thin evidence to begin with: "auto" against
  // "ComfyUI-Auto-Installer-Assets" is not a model, and it matched.
  const extra = Math.max(0, [...have].filter((token) => !NAME_NOISE.has(token)).length - wanted.length);
  return Math.max(0, base - Math.min(0.6, extra * (wanted.length === 1 ? 0.25 : 0.15)));
}

/* ---------------- what to search for ---------------- */

// Registry titles name a LANE, not a model: "LTX 2.3 Transition LoRA",
// "MiniMax H3 Head Replacement", "Krea 2 Turbo - Identity Optional". The model
// is the front of that phrase, so the tail — everything from the first word
// that describes the lane rather than the model — is dropped.
const LANE_WORDS = new Set([
  'lora', 'ingredients', 'transition', 'motion', 'dual', 'character', 'inpaint',
  'head', 'replacement', 'reference', 'identity', 'optional', 'edit', 'comfy',
  'lane', 'optimizer', 'fp8', 'q8', 'bf16', 'gguf', 'mlx', 'native', 'dmd',
  'distilled', 'regular', 'better', 'image', 'video', 'workflow',
]);

function modelPhrase(title) {
  const words = String(title || '').split(/\s+/).filter(Boolean);
  const kept = [];
  for (const word of words) {
    const bare = word.toLowerCase().replace(/[^a-z0-9.]/g, '');
    if (!bare) break;
    if (LANE_WORDS.has(bare)) break;
    kept.push(word);
    if (kept.length >= 4) break;
  }
  return kept.join(' ').replace(/[-–—:]$/, '').trim();
}

/** The queries to try for one model, best first and without repeats.
 *
 *  `prefer` decides which name goes first, and the two catalogues genuinely
 *  disagree. `compatible_base_models` is CIVITAI's vocabulary — "LTXV",
 *  "ZImageTurbo" are its base-model tags — so it leads there. Hugging Face
 *  names repos after the release ("LTX-2.3"), which is what the registry title
 *  says, so the title's leading phrase leads there instead. Searching Hugging
 *  Face for "LTXV" finds a GGUF repack and never reaches Lightricks. */
// Family slugs that are bookkeeping rather than the name of anything: a
// workflow found by auto-detection is filed under "comfy-auto", and searching a
// model catalogue for "comfy auto" finds an installer's asset repo.
const NON_MODEL_FAMILIES = new Set(['comfy auto', 'auto', 'local image', 'local video', 'hivemind media studio']);

function modelSearchQueries(model, { prefer = 'base' } = {}) {
  const bases = Array.isArray(model?.compatibleBaseModels) ? model.compatibleBaseModels : [];
  const baseNames = bases.map((base) => String(base || '').trim());
  const phrase = modelPhrase(model?.name);
  const familyName = String(model?.family || model?.workflowFamily || '').replace(/[-_]+/g, ' ').trim();
  const family = NON_MODEL_FAMILIES.has(familyName.toLowerCase()) ? '' : familyName;
  const candidates = [
    // "ltx 2.3" is what Lightricks calls the release and what its repo is named;
    // it is the second thing Hugging Face is asked, because a lane title like
    // "LTX 2.3 IC-LoRA Ingredients" matches nothing there and the base-model tag
    // "LTXV" matches a GGUF repack.
    ...(prefer === 'name' ? [phrase, family, ...baseNames] : [...baseNames, phrase]),
    // "ZImageTurbo" and "Z-Image Turbo" are the same model spelled two ways;
    // splitting the camel case gives the search engines the second spelling.
    ...bases.map((base) => String(base || '').replace(/([a-z])([A-Z])/g, '$1 $2').trim()),
    family,
  ];
  const seen = new Set();
  return candidates
    .map((value) => value.replace(/\s+/g, ' ').trim())
    .filter((value) => {
      const key = value.toLowerCase();
      if (value.length < 3 || value.length > 60 || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 4);
}

/* ---------------- Hugging Face ---------------- */

// A model repo holds two kinds of picture and only one of them is worth showing:
// what the model MAKES, versus a diagram of how it works. Names are the only
// signal available before downloading them, and they are a good one.
const REPO_IMAGE_GOOD = /(showcase|teaser|cover|banner|sample|example|demo|preview|gallery|hero|result)/i;
// Everything a paper ships that is not the model's output. `arch` catches
// "full-arch.png", which is how MiniMax H3's architecture diagram nearly became
// its cover art.
const REPO_IMAGE_BAD = /(^|[^a-z])(arch|architecture|pipeline|diagram|chart|graph|leaderboard|benchmark|metric|table|logo|icon|badge|comparison|ablation|framework|overview|radar|curve|loss|plot|scaling|dmd)/i;
const REPO_IMAGE_EXT = /\.(png|jpe?g|webp)$/i;
// Bigger than this and it is a poster, not card art. Everything under it is fair
// game: the bridge downscales what it caches, so a 6 MB showcase costs its bytes
// exactly once and beats a 150 KB diagram every time.
const REPO_IMAGE_MAX_BYTES = 12 * 1024 * 1024;

/** The best picture in a repo's file list, or null when it only ships diagrams. */
function pickRepoImage(siblings) {
  const files = (Array.isArray(siblings) ? siblings : [])
    .map((entry) => ({
      path: String(entry?.rfilename || ''),
      size: Number(entry?.size) || 0,
    }))
    .filter((entry) => REPO_IMAGE_EXT.test(entry.path)
      && !REPO_IMAGE_BAD.test(entry.path)
      && !(entry.size && entry.size > REPO_IMAGE_MAX_BYTES));
  if (!files.length) return null;
  // What the picture IS decides; how big it is only breaks ties. Ranking size
  // first is how a 148 KB architecture sketch outranked a showcase render.
  const ranked = files
    .map((entry) => ({ ...entry, rank: REPO_IMAGE_GOOD.test(entry.path) ? 0 : 1 }))
    .sort((a, b) => a.rank - b.rank || (a.size || Infinity) - (b.size || Infinity));
  return ranked[0] || null;
}

function huggingFaceLinks(repoId) {
  return [{ kind: 'huggingface', url: `${HF_API}/${repoId}` }];
}

// Best of two opened repos: a picture beats no picture, a model card beats a
// README of install steps, and only then does the name match decide.
function betterRepo(a, b) {
  if (!a) return b;
  if (!b) return a;
  const rank = (card) => [
    card.artUrl ? 1 : 0,
    aboutQuality(card.about) >= 0.5 ? 1 : 0,
    card.matched,
    Number(card.stats?.likes || 0),
  ];
  const [left, right] = [rank(a), rank(b)];
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index] ? a : b;
  }
  return a;
}

async function fromHuggingFace(queries, deps) {
  let found = null;
  for (const query of queries) {
    let hits = [];
    try {
      // Sorted by LIKES, not downloads. Every popular model has a shelf of
      // re-quantized mirrors that out-download the original (a ComfyUI repack of
      // MiniMax H3 has 4x the downloads of MiniMax's own repo), and the mirrors
      // carry neither the model card nor the showcase art. Likes track the repo
      // people treat as the model's home.
      hits = await deps.getJson(`${HF_API}/api/models?search=${encodeURIComponent(query)}&limit=8&sort=likes&direction=-1`);
    } catch {
      continue;
    }
    const scored = (Array.isArray(hits) ? hits : [])
      .map((hit) => ({ hit, score: matchScore(query, String(hit?.id || '').split('/').pop() || '') }))
      .filter((entry) => entry.score >= MATCH_FLOOR)
      .sort((a, b) => b.score - a.score || Number(b.hit?.likes || 0) - Number(a.hit?.likes || 0));
    // The top few are all plausibly the model; which of them is worth showing
    // depends on what is actually inside, so they are opened and compared. A
    // ComfyUI repack scores as highly as the model's own repo on name alone and
    // carries neither a picture nor a model card.
    const opened = [];
    for (const { hit, score } of scored.slice(0, 3)) {
      const repoId = String(hit.id || '');
      if (!repoId) continue;
      let repo = null;
      try {
        repo = await deps.getJson(`${HF_API}/api/models/${repoId}?blobs=true`);
      } catch {
        continue;
      }
      const image = pickRepoImage(repo?.siblings);
      const readme = await deps.getText(`${HF_API}/${repoId}/resolve/main/README.md`).catch(() => '');
      const about = readmeSummary(readme);
      if (!image && !about) continue;
      opened.push({
        source: 'huggingface',
        sourceName: repoId,
        sourceUrl: `${HF_API}/${repoId}`,
        artUrl: image ? `${HF_API}/${repoId}/resolve/main/${image.path.split('/').map(encodeURIComponent).join('/')}` : '',
        artKind: 'image',
        about,
        links: huggingFaceLinks(repoId),
        stats: { downloads: Number(repo?.downloads || hit.downloads || 0), likes: Number(repo?.likes || hit.likes || 0) },
        matched: Number(score.toFixed(2)),
        query,
      });
    }
    for (const card of opened) found = betterRepo(found, card);
    // "LTXV" finds a GGUF repack and stops there; "LTX 2.3" finds Lightricks'
    // own repo. So a query that answered only half the question does not end
    // the search — the next spelling of the name gets its turn.
    if (found && found.artUrl && found.matched >= MATCH_CONFIDENT && aboutQuality(found.about) >= 0.5) break;
  }
  return found;
}

/* ---------------- Civitai (keyed, and the open mirror) ---------------- */

function civitaiCard(item, { source, score, query, origin }) {
  const versions = Array.isArray(item?.modelVersions) ? item.modelVersions : [];
  const version = versions[0] || {};
  // The newest version is often a weights-only upload with no gallery, while an
  // older one carries the model's whole showcase. Reading only version[0] is why
  // Krea 2 and MiniMax H3 came back with a description and no picture.
  const image = versions
    .flatMap((entry) => (Array.isArray(entry?.images) ? entry.images : []))
    .find((entry) => entry && entry.url) || {};
  const stats = item?.stats || {};
  const modelId = String(item?.id || '');
  const url = modelId
    ? `${origin}/models/${encodeURIComponent(modelId)}${version.id ? `?modelVersionId=${encodeURIComponent(String(version.id))}` : ''}`
    : '';
  return {
    source,
    sourceName: String(item?.name || ''),
    sourceUrl: url,
    artUrl: String(image.url || ''),
    artKind: /\.(mp4|webm|mov)(?:[?#]|$)/i.test(String(image.url || '')) ? 'video' : 'image',
    about: textFromHtml(item?.description),
    links: url ? [{ kind: source === 'civitai-mirror' ? 'civitai-mirror' : 'civitai', url }] : [],
    stats: {
      downloads: Number(stats.downloadCount || 0),
      likes: Number(stats.thumbsUpCount ?? stats.favoriteCount ?? 0),
    },
    matched: Number(score.toFixed(2)),
    query,
  };
}

// Only checkpoints: a LoRA search matches the base model's name too, and its
// art would then be shown as if it were the model's own.
const CIVITAI_LOOKUP = 'types=Checkpoint&limit=6&nsfw=false&sort=Most%20Downloaded';

async function fromCivitai(queries, deps) {
  if (typeof deps.civitaiSearch !== 'function') return null;
  for (const query of queries) {
    let data = null;
    try {
      data = await deps.civitaiSearch(query);
    } catch {
      continue;
    }
    const items = Array.isArray(data?.items) ? data.items : [];
    const best = items
      .map((item) => ({ item, score: matchScore(query, item?.name) }))
      .filter((entry) => entry.score >= MATCH_FLOOR && entry.item)
      .sort((a, b) => b.score - a.score)[0];
    if (!best) continue;
    const card = civitaiCard(best.item, { source: 'civitai', score: best.score, query, origin: 'https://civitai.com' });
    if (card.artUrl || card.about) return card;
  }
  return null;
}

async function fromCivitaiMirror(queries, deps) {
  for (const query of queries) {
    let data = null;
    try {
      data = await deps.getJson(`${CIVITAI_MIRROR}/api/v1/models?query=${encodeURIComponent(query)}&${CIVITAI_LOOKUP}`);
    } catch {
      continue;
    }
    const items = Array.isArray(data?.items) ? data.items : [];
    const best = items
      .map((item) => ({ item, score: matchScore(query, item?.name) }))
      .filter((entry) => entry.score >= MATCH_FLOOR && entry.item)
      .sort((a, b) => b.score - a.score)[0];
    if (!best) continue;
    const card = civitaiCard(best.item, { source: 'civitai-mirror', score: best.score, query, origin: CIVITAI_MIRROR });
    if (card.artUrl || card.about) return card;
  }
  return null;
}

/* ---------------- the chain ---------------- */

const EMPTY_CARD = Object.freeze({
  source: '', sourceName: '', sourceUrl: '', artUrl: '', artKind: 'image',
  artSource: '', about: '', links: [], stats: {}, matched: 0, query: '',
});

/** One card out of everything the chain found.
 *
 *  A source can answer half the question — Civitai had Krea 2's description and
 *  no gallery, Hugging Face has the showcase image and the model's own words —
 *  so the picture and the prose are chosen separately, each from the best
 *  source that actually has one, and every link found is kept.
 */
function mergeCards(cards) {
  const found = cards.filter(Boolean);
  if (!found.length) return { ...EMPTY_CARD };
  const byScore = [...found].sort((a, b) => b.matched - a.matched);
  const best = byScore[0];
  // Art: Civitai first whenever it has any, at either origin. Its galleries are
  // finished generations served through a width=450 transform, where a repo's
  // showcase is a multi-megabyte press image.
  const withArt = [...byScore]
    .filter((card) => card.artUrl)
    .sort((a, b) => (a.source === 'huggingface' ? 1 : 0) - (b.source === 'huggingface' ? 1 : 0) || b.matched - a.matched)[0];
  // Prose: the best-matching source that wrote something which reads like a
  // description at all. Quality is a GATE, not a ranking — ranked, it just
  // picks the longest text, and the longest text is usually a Civitai page
  // describing Civitai. A model whose every source fails the gate keeps no
  // description here, and the page falls back to the one the registry wrote.
  const withAbout = [...byScore]
    .filter((card) => aboutQuality(card.about) >= 0.5)
    .sort((a, b) => b.matched - a.matched || aboutQuality(b.about) - aboutQuality(a.about))[0];
  // One link per SITE. civitai.red mirrors civitai.com, so a weak keyed hit
  // followed by a mirrored one would otherwise offer the same model twice.
  const site = (link) => String(link?.kind || '').replace('-mirror', '');
  const links = [];
  for (const card of byScore) {
    for (const link of card.links || []) {
      if (link?.url && !links.some((existing) => site(existing) === site(link))) links.push(link);
    }
  }
  const described = withAbout || best;
  return {
    ...described,
    // Spelled out rather than inherited from the spread: `described` falls back
    // to the best-matching card, and that card's text may be exactly the
    // referral code the gate above just rejected.
    about: withAbout ? withAbout.about : '',
    artUrl: withArt ? withArt.artUrl : '',
    artKind: withArt ? withArt.artKind : 'image',
    artSource: withArt ? withArt.source : '',
    links,
  };
}

/** Artwork, a blurb and links for one model — or an empty card when no source
 *  had a confident answer. Never throws: a page without a picture is a page,
 *  and a page that failed to load is not. */
async function resolveModelCard(model, deps = {}) {
  const queries = modelSearchQueries(model);
  const repoQueries = modelSearchQueries(model, { prefer: 'name' });
  if (!queries.length) return { ...EMPTY_CARD };
  const attemptWith = async (step, terms) => {
    try {
      return await step(terms, deps);
    } catch {
      return null;
    }
  };
  const attempt = (step) => attemptWith(step, queries);
  const cards = [];
  // Civitai twice over: through the gateway, which spends the owner's key, and
  // then the open mirror — but the mirror only when the keyed search came back
  // without a confident answer, since it is the same database.
  const keyed = await attempt(fromCivitai);
  if (keyed) cards.push(keyed);
  if (!keyed || keyed.matched < MATCH_CONFIDENT || !keyed.artUrl) {
    const mirrored = await attempt(fromCivitaiMirror);
    if (mirrored) cards.push(mirrored);
  }
  // Hugging Face runs even when Civitai answered everything: it is where the
  // model's own words live, and `mergeCards` decides which half of each source
  // is worth keeping.
  const repo = await attemptWith(fromHuggingFace, repoQueries);
  if (repo) cards.push(repo);
  return mergeCards(cards);
}

module.exports = {
  CARD_TTL_MS,
  EMPTY_CARD,
  MISS_TTL_MS,
  MATCH_CONFIDENT,
  MATCH_FLOOR,
  CIVITAI_LOOKUP,
  CIVITAI_MIRROR,
  HF_API,
  USER_AGENT,
  aboutQuality,
  matchScore,
  mergeCards,
  modelPhrase,
  modelSearchQueries,
  pickRepoImage,
  readmeSummary,
  resolveModelCard,
  textFromHtml,
};
