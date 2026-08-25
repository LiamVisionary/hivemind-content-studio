// The example the Story studio loads when you press "Load example".
//
// It exists so the six stages can be READ before any of them is run: every
// field filled with the kind of thing that belongs in it, so the difference
// between "wind" and "still cold air off the water lifts the timetable page and
// the moths at the lamp" is visible rather than described.
//
// Written for this studio, not borrowed from anywhere. It is deliberately a
// small ordinary situation with one behaviour only this pair would perform —
// which is the thing the concept stage is actually for.
export const STORY_EXAMPLE = Object.freeze({
  brief: {
    person: 'the driver of the last night bus',
    companion: 'a large pale moth that rides on the fare machine',
    tone: 'strange',
    world: 'an empty estuary bus terminus at 2am, sodium light, wet tarmac',
    count: 8,
    avoid: 'no dialogue, nothing cute-coded, no on-screen text',
  },
  style: 'muted painterly animation, soft grain, restrained palette',
  aspect: '9:16',
  title: 'Last Service',
  promise: 'The driver who has stopped noticing anyone is quietly kept company.',
  contract: {
    pressure: 'the last service of the night runs empty again',
    who: 'the driver',
    goal: 'finish the shift without looking up',
    other: 'the moth',
    behavior: 'landing on the ticket he has not printed',
    reward: 'the first thing he has looked at properly all night',
  },
  characters: [
    {
      name: 'Rell',
      role: 'night bus driver, late fifties',
      species: 'human',
      silhouette: 'heavy shoulders under a shapeless work coat, low centre of gravity, cap flattening the hair',
      face: 'long face, deep undereye shadow, mouth at rest slightly open, permanently tired',
      pattern: 'coat one flat navy, one hi-vis stripe at the cuff only, hands darker than the face',
      signature: 'a thermos lid worn as a cup, always in the left hand',
      behavior: 'looks at the mirror instead of the door; speaks to nobody',
      never: 'the cuff stripe stays on one arm; the thermos lid stays in the left hand; the cap never comes off',
    },
    {
      name: 'the moth',
      role: 'passenger',
      species: 'a pale moth the size of a hand',
      silhouette: 'broad triangular wings at rest, feathered antennae, body thicker than the wings suggest',
      face: 'two dark eyes with no highlight; no expression to read, so everything is posture',
      pattern: 'bone white with one smoke-grey band across both wings, matching on each side',
      signature: 'the grey band, and one wingtip that is torn short',
      behavior: 'lands on whatever the driver is about to touch',
      never: 'the torn wingtip stays on the same side; the band never becomes a pattern of spots',
    },
  ],
  location: {
    place: 'the last stand of an estuary bus terminus, one bus, shelter and timetable case',
    time: '2am',
    weather: 'still air, recent rain, mist off the water',
    palette: 'sodium orange against wet blue-grey',
    accent: 'the green of the ticket machine display',
    depth: 'foreground fare machine and windscreen, midground shelter and timetable case, background water and one channel marker',
    lights: 'one sodium lamp overhead, the bus interior strip, the green display',
    motion: ['mist off the water', 'the loose timetable page', 'moths at the lamp', 'reflections in wet tarmac', 'the wiper at rest'],
    forbid: 'no other people, no traffic, no signage text',
    aspect: '9:16',
    plateUrl: '',
  },
  board: {
    format: 'four',
    arc: 'unnoticed to noticed',
    panels: [
      { n: 1, job: 'Hook', asks: '', verb: 'the moth lands on the unprinted ticket', shot: 'macro', reason: 'that something is on the machine at all', motion: 'the ticket roll' },
      { n: 2, job: 'Setup', asks: '', verb: 'the driver reaches past it without looking', shot: 'overhead', reason: 'how routine the hand is', motion: 'his sleeve' },
      { n: 3, job: 'Turn', asks: '', verb: 'he stops, and looks at it properly', shot: 'close', reason: 'the moment the night changes', motion: 'his breath on the glass' },
      { n: 4, job: 'Reward', asks: '', verb: 'he drives off with the moth still aboard', shot: 'wide', reason: 'that neither of them is alone now', motion: 'mist, and the lamp going behind' },
    ],
    sheetUrl: '',
  },
  motion: {
    seconds: 15,
    force: 'still cold air off the water, and the pull of the one working lamp',
    layers: {
      subject: 'his shoulders drop on the exhale; the moth resettles its wings once',
      cloth: 'the work coat hangs and shifts when the arm moves',
      contact: 'the ticket roll turns a half-inch and stops',
      foreground: 'condensation creeping up the inside of the windscreen',
      midground: 'the loose timetable page lifting and falling in its case',
      background: 'mist crossing in front of the channel marker',
      light: 'the sodium lamp swelling and settling, the green display flickering once',
    },
    beats: [
      { from: 0, to: 5, action: 'the moth drops onto the ticket the machine never printed', emotion: 'he has not noticed' },
      { from: 5, to: 10, action: 'his hand reaches past it, stops, and comes back', emotion: 'irritation turning into attention' },
      { from: 10, to: 15, action: 'he leaves it where it is and pulls away from the stand', emotion: 'company, unacknowledged' },
    ],
    camera: 'macro on the machine, then overhead on the hand, then close on his face, then one wide as the bus leaves',
    audio: 'the idling engine, the ticket roll, one wing-beat, water somewhere behind',
    music: 'none',
    negatives: 'no dialogue, no music, no on-screen text',
    limit: 0,
  },
});
