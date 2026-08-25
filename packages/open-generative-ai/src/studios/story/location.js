// Stage 3 — the location: one empty reference that ends scene description.
//
// Without it, every video prompt spends a third of its budget rebuilding the
// room, and the model rebuilds it differently each time — the shelter gains a
// second bench, the harbour becomes a river. With it, the prompt says what
// HAPPENS and the reference says where.
//
// Empty on purpose. The character sheets own the characters; if the location
// reference has people in it, the two references argue and the render splits
// the difference. It also means one location serves a whole series.

/** Aspect ratios worth offering for a location plate. Vertical first: the
 *  method is aimed at short-form, and a 16:9 plate reframed to 9:16 loses the
 *  foreground the motion layers live in. */
export const LOCATION_ASPECTS = Object.freeze(['9:16', '4:5', '1:1', '16:9']);

/**
 * Things that can move, grouped by the force that moves them.
 *
 * This is the list the motion stage draws from, which is why it is collected
 * here rather than there: what can move is a property of the PLACE, decided
 * while looking at it, not remembered later while writing a prompt.
 */
export const MOTION_SOURCES = Object.freeze([
  { id: 'wind', label: 'Wind', examples: ['hanging signs', 'loose paper', 'curtains', 'grass', 'hair and cloth', 'dust'] },
  { id: 'rain', label: 'Rain or snow', examples: ['falling layers at different depths', 'puddle reflections', 'drips off an edge', 'wet fabric'] },
  { id: 'water', label: 'Water', examples: ['waves', 'a running tap', 'steam off a surface', 'ripples', 'condensation'] },
  { id: 'heat', label: 'Heat', examples: ['steam', 'shimmer', 'a flame', 'melting', 'rising smoke'] },
  { id: 'traffic', label: 'Passing traffic', examples: ['a tram or train light', 'headlight sweep', 'a shadow crossing the wall', 'a rattle in the glass'] },
  { id: 'light', label: 'Changing light', examples: ['cloud shadow', 'a flickering practical', 'a sign cycling', 'reflected light travelling'] },
  { id: 'life', label: 'Living things', examples: ['birds', 'leaves', 'a distant figure', 'petals', 'insects'] },
]);

export function blankLocation() {
  return {
    place: '',
    time: '',
    weather: '',
    palette: '',
    accent: '',
    depth: '',
    lights: '',
    motion: [],
    forbid: '',
    aspect: '9:16',
    plateUrl: '',
  };
}

const text = (value) => String(value ?? '').trim().replace(/\s+/g, ' ');
const clause = (label, value) => (text(value) ? `${label}: ${text(value)}.` : '');

/** The moving elements as one readable list, whatever mix of picked sources and
 *  free text the user left. */
export function motionElements(location = {}) {
  const picked = Array.isArray(location.motion) ? location.motion.map(text).filter(Boolean) : [];
  return [...new Set(picked)];
}

/**
 * The empty-plate prompt.
 *
 * "No characters" is stated twice — once as an instruction and once as a
 * consequence — because a location prompt that mentions a tram shelter and a
 * rainy night gets a lone figure under it by default, and one figure in the
 * plate is enough to fight the character sheet in every later render.
 */
export function locationPrompt(location = {}, { style = '', aspect = '' } = {}) {
  const place = text(location.place);
  if (!place) return '';
  const ratio = text(aspect) || text(location.aspect) || '9:16';
  const moving = motionElements(location);
  return [
    `One clean ${ratio} location reference with no characters in it: ${place}.`,
    clause('Time and weather', [text(location.time), text(location.weather)].filter(Boolean).join(', ')),
    clause('Spatial layout, foreground to background', location.depth),
    clause('Practical light sources', location.lights),
    clause('Palette', [text(location.palette), text(location.accent) && `single accent: ${text(location.accent)}`].filter(Boolean).join('; ')),
    moving.length ? `Include these elements, positioned so they could move: ${moving.join(', ')}.` : '',
    style ? `Style: ${text(style)}.` : '',
    clause('Must not appear', location.forbid),
    'Empty of people and animals — the characters are defined by separate reference sheets.',
    'No typography, no collage borders, no duplicated objects, no vignette.',
  ].filter(Boolean).join('\n');
}

/** What is missing before the plate is worth generating. Ordered by how badly
 *  its absence shows up later. */
export function locationGaps(location = {}) {
  const gaps = [];
  if (!text(location.place)) gaps.push('Name the place.');
  if (!text(location.time) && !text(location.weather)) gaps.push('Say the time of day or the weather — the light has to come from somewhere.');
  if (!text(location.depth)) gaps.push('Describe foreground, midground and background, or the plate comes back flat.');
  if (!motionElements(location).length) gaps.push('Pick at least one thing that can move, or the motion stage has nothing to animate.');
  return gaps;
}
