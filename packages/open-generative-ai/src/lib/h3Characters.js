// MiniMax H3 character quick-add catalog — names the community reported as
// recreatable from pure T2V (reddit thread, collected 2026-08). Entries with
// `filled: true` are our picks for series the thread named without characters;
// they inherit the series' report, not a per-name confirmation.
//
// H3 identifies characters best through their SOURCE: the community-tested
// form is "<Name> as played by <Actor> from the television series <Series>
// (<year>)", so every entry carries `medium` + `year` (and `actor` for
// live-action likenesses). `prompt` overrides the base wording when the name
// alone is off ("the Joker"); `origin` overrides the whole from-clause when
// the series label isn't the natural source name (Marvel/DC/Disney groups).
//
// Real people from the thread (Terry Crews, Gordon Ramsay, IU, Lee Jong Suk,
// BTS) are deliberately absent — fictional characters only; actor names appear
// only as the on-screen casting of a fictional role. Also absent on purpose:
// Xander (thread says he fails) and Overwatch characters (style works, names
// don't). Ron Weasley used to be on that list and is now here: the usability
// index below tested the Rupert Grint likeness and filed it under `good`.
//
// 2026-08-22: 284 entries added from malcolmrey's H3 character usability index
// (huggingface.co/datasets/malcolmrey/various, h3-center/known-characters,
// generated 2026-08-21), which is a MEASURED list — one row per character, each
// backed by a test clip filed under good / onthefence / bad — where the reddit
// thread above was a report. Only `good` and `onthefence` were taken; the
// index's 835 `bad` characters were not, and an `onthefence` one carries a hint
// saying so. Its "Real Actor / Actress" column is a single column covering both
// kinds of performer, so it lands in `actor` for a live-action likeness and in
// `voiceActor` for an animated one — the distinction below is load-bearing and
// the index does not draw it. Its 78 real-celebrity rows and its talk-show and
// sports hosts (Joe Rogan, Conan O'Brien, Gordon Ramsay, Kobe Bryant …) are
// excluded by the fictional-characters-only rule above. `medium` and `year` are
// not in the index and were supplied per franchise here.
//
// The index also disagrees with this catalog in one direction worth knowing:
// twelve entries carried here are filed under its `bad` folder — Cosmo Kramer,
// Arya Stark, Monica Geller, Deanna Troi, Sarah Connor, Luke Skywalker,
// Superman, Joker, Trinity, Agent Smith, Ellen Ripley and Peter Parker — and
// Geralt of Rivia under `onthefence`. They are kept as they were: for Superman,
// Joker, Geralt and Peter Parker the index tested a live-action or film
// depiction while these entries name the comics or the game, so the two are not
// judging the same thing. The other eight are the same depiction and the index
// says they render badly; nothing here acts on that yet.

import {
  characterSubjectLines, formatSixSections, isSixSectionPrompt, parseSixSections,
} from './castPrompt.js';

const MEDIUM_PHRASE = Object.freeze({
  tv: 'the television series',
  animation: 'the animated series',
  'animated-film': 'the animated film',
  anime: 'the anime series',
  game: 'the video game',
  film: 'the film',
  films: 'the film series',
});

export const H3_CHARACTERS = Object.freeze([
  // ---- Games ----
  { name: 'Sonic the Hedgehog', series: 'Sonic the Hedgehog', medium: 'game', year: 1991, voiceQuality: 'bright, cocky and youthful with a quick energetic delivery — never deep or adult-sounding' },
  { name: 'Knuckles', series: 'Sonic the Hedgehog', prompt: 'Knuckles the Echidna', medium: 'game', year: 1994, voiceQuality: 'gruff and blunt, low for a young character, with a stubborn clipped delivery' },
  { name: 'Tails', series: 'Sonic the Hedgehog', medium: 'game', year: 1992, voiceQuality: 'a small boyish voice, high and eager — never deep or adult-sounding' },
  { name: 'Shadow the Hedgehog', series: 'Sonic the Hedgehog', medium: 'game', year: 2001, voiceQuality: 'low, cold and brooding with a flat serious delivery — never bright or cheerful' },
  { name: 'Mario', series: 'Super Mario', medium: 'game', year: 1985, voiceQuality: 'a high, bouncy Italian-American cartoon voice, bright and exclamatory — never deep or gravelly' },
  { name: 'Luigi', series: 'Super Mario', medium: 'game', year: 1985, voiceQuality: "a higher, timid, nervous take on Mario's Italian-American cartoon voice" },
  { name: 'Princess Peach', series: 'Super Mario', medium: 'game', year: 1985, voiceQuality: 'a soft, high, gentle feminine voice with a sweet lilting delivery' },
  { name: 'Bowser', series: 'Super Mario', medium: 'game', year: 1985, voiceQuality: 'a huge, deep, gravelly monster growl — never light or clear' },
  { name: 'Link', series: 'The Legend of Zelda', medium: 'game', year: 1986 },
  { name: 'Princess Zelda', series: 'The Legend of Zelda', medium: 'game', year: 1986, voiceQuality: 'a clear, measured feminine voice with a formal, regal delivery' },
  { name: 'Ganondorf', series: 'The Legend of Zelda', medium: 'game', year: 1998, voiceQuality: 'a deep, resonant voice with slow, deliberate menace' },
  { name: 'Leon Kennedy', series: 'Resident Evil', prompt: 'Leon S. Kennedy', medium: 'game', year: 1998, voiceQuality: "a low, dry young man's voice with a flat deadpan delivery" },
  { name: 'Claire Redfield', series: 'Resident Evil', medium: 'game', year: 1998 },
  { name: 'Jill Valentine', series: 'Resident Evil', medium: 'game', year: 1996 },
  { name: 'Ada Wong', series: 'Resident Evil', medium: 'game', year: 1998, voiceQuality: 'a low, cool, husky feminine voice with a slow teasing delivery' },
  { name: 'Arthur Morgan', series: 'Red Dead Redemption', medium: 'game', year: 2018, voiceQuality: 'a rough, low American Western drawl, weary and gravelly' },
  { name: 'Solid Snake', series: 'Metal Gear Solid', medium: 'game', year: 1998, voiceQuality: 'a low, gravelly, hard-boiled adult male voice with a clipped delivery' },
  { name: 'Cloud Strife', series: 'Final Fantasy VII', medium: 'game', year: 1997, voiceQuality: "a flat, reserved young man's voice, quiet and clipped" },
  { name: 'Tifa Lockhart', series: 'Final Fantasy VII', medium: 'game', year: 1997, voiceQuality: 'a warm, low feminine voice, calm and gentle' },
  { name: 'Aerith Gainsborough', series: 'Final Fantasy VII', medium: 'game', year: 1997, voiceQuality: 'a light, warm, cheerful feminine voice with a gentle lilt' },
  { name: 'Yuffie Kisaragi', series: 'Final Fantasy VII', medium: 'game', year: 1997, voiceQuality: "a hyperactive teenage girl's voice, high and brash — never adult-sounding" },
  { name: 'Sephiroth', series: 'Final Fantasy VII', medium: 'game', year: 1997, voiceQuality: 'a smooth, cold, low voice with an unhurried, menacing calm' },
  { name: 'Johnny Silverhand', series: 'Cyberpunk 2077', medium: 'game', year: 2020, actor: 'Keanu Reeves', hint: 'Needs some extra prompting' },
  { name: 'Samus Aran', series: 'Metroid', medium: 'game', year: 1986, hint: 'Confirmed in the power suit' },
  { name: '2B', series: 'NieR: Automata', medium: 'game', year: 2017, voiceQuality: 'a cool, restrained, softly spoken feminine voice, almost affectless' },
  { name: 'Nathan Drake', series: 'Uncharted', medium: 'game', year: 2007, voiceQuality: "a wry, easy-going American man's voice with a quick joking delivery" },
  { name: 'Chloe Frazer', series: 'Uncharted', medium: 'game', year: 2009, voiceQuality: 'an Australian-accented feminine voice, dry and playful' },
  { name: 'Nadine Ross', series: 'Uncharted', medium: 'game', year: 2016, voiceQuality: 'a South African-accented feminine voice, low and clipped' },
  { name: 'Geralt of Rivia', series: 'The Witcher', medium: 'game', year: 2015, voiceQuality: 'a low, gravelly growl, weary and almost unemotional' },
  { name: 'Commander Shepard', series: 'Mass Effect', medium: 'game', year: 2007, hint: 'Both default Shepards work' },
  { name: "Tali'Zorah", series: 'Mass Effect', medium: 'game', year: 2007, voiceQuality: "a young feminine voice heard through a suit's comm filter, with a faint accent" },
  { name: 'Garrus Vakarian', series: 'Mass Effect', medium: 'game', year: 2007, voiceQuality: 'a dry, gravelly alien voice with a subtle electronic buzz under it' },
  { name: "Liara T'Soni", series: 'Mass Effect', medium: 'game', year: 2007, voiceQuality: 'a soft, gentle feminine voice with a formal, precise delivery' },
  { name: 'Shadowheart', series: "Baldur's Gate 3", medium: 'game', year: 2023, voiceQuality: 'a measured English-accented feminine voice, wry and guarded' },
  { name: 'Astarion', series: "Baldur's Gate 3", medium: 'game', year: 2023, voiceQuality: 'a light, arch English-accented voice with a mocking, silken drawl' },
  { name: "Lae'zel", series: "Baldur's Gate 3", medium: 'game', year: 2023, voiceQuality: 'a harsh, guttural feminine voice with a clipped, aggressive delivery' },
  { name: 'Kazuma Kiryu', series: 'Yakuza', medium: 'game', year: 2005, voiceQuality: "a very deep, gruff Japanese man's voice, terse and restrained" },
  { name: 'Goro Majima', series: 'Yakuza', medium: 'game', year: 2005, voiceQuality: 'a wild, raspy Japanese voice that swings between a purr and a shriek' },
  { name: 'Ichiban Kasuga', series: 'Yakuza', medium: 'game', year: 2020, voiceQuality: "a loud, earnest, slightly goofy Japanese man's voice" },
  { name: 'Joel', series: 'The Last of Us', medium: 'game', year: 2013, voiceQuality: 'a low, weathered Texan drawl, gruff and slow' },
  { name: 'Ellie', series: 'The Last of Us', medium: 'game', year: 2013, voiceQuality: "a teenage girl's voice, husky and quick with a sardonic edge — never adult-sounding" },
  { name: 'Abby', series: 'The Last of Us', medium: 'game', year: 2020 },
  { name: 'Cal Kestis', series: 'Star Wars Jedi: Survivor', medium: 'game', year: 2019 },
  { name: 'Cere Junda', series: 'Star Wars Jedi: Survivor', medium: 'game', year: 2019 },
  { name: 'Bayonetta', series: 'Bayonetta', medium: 'game', year: 2009, voiceQuality: 'a low, sultry feminine voice with a teasing drawl' },
  { name: 'Kassandra', series: "Assassin's Creed", origin: "the video game Assassin's Creed Odyssey (2018)", voiceQuality: 'a Greek-accented feminine voice, low and dry' },
  { name: 'Master Chief', series: 'Halo', medium: 'game', year: 2001, voiceQuality: 'a calm, low, laconic adult male voice, flat and unhurried even under fire' },
  { name: 'Aloy', series: 'Horizon', medium: 'game', year: 2017, voiceQuality: "a determined young woman's voice, clear and even with a slight rasp" },
  { name: 'Doomguy', series: 'Doom', medium: 'game', year: 1993 },
  // Same marine, but the name picks the era: 1993 is the sprite-era green
  // armour, 2016 the Praetor suit. Both are worth having as separate entries
  // because the source clause is the whole of what H3 retrieves.
  { name: 'Doom Slayer', series: 'Doom', prompt: 'the Doom Slayer', medium: 'game', year: 2016, filled: true },
  { name: 'Senua', series: 'Hellblade', medium: 'game', year: 2017 },
  { name: 'Amicia', series: 'A Plague Tale', prompt: 'Amicia de Rune', medium: 'game', year: 2019 },
  { name: 'Sam Porter Bridges', series: 'Death Stranding', medium: 'game', year: 2019, actor: 'Norman Reedus' },
  { name: 'Amelie', series: 'Death Stranding', medium: 'game', year: 2019, actor: 'Lindsay Wagner' },
  { name: 'Peter Parker', series: "Marvel's Spider-Man", medium: 'game', year: 2018, hint: 'Game suit confirmed', voiceQuality: "a young adult man's voice, warm and quick with a joking delivery" },
  { name: 'Miles Morales', series: "Marvel's Spider-Man", medium: 'game', year: 2020, hint: 'Game suit confirmed', voiceQuality: "a teenage boy's voice, bright and quick — never adult-sounding" },
  { name: 'Kara', series: 'Detroit: Become Human', medium: 'game', year: 2018 },
  { name: 'Kratos', series: 'God of War', medium: 'game', year: 2018, voiceQuality: 'a deep, gravelly growl, quiet and controlled rather than shouted' },
  { name: 'Atreus', series: 'God of War', medium: 'game', year: 2018, voiceQuality: "a boy's voice, light and earnest — never adult-sounding" },
  { name: 'Dani Rojas', series: 'Far Cry 6', medium: 'game', year: 2021 },
  { name: 'Jin Sakai', series: 'Ghost of Tsushima', medium: 'game', year: 2020, voiceQuality: "a low, restrained Japanese man's voice, formal and quiet" },
  { name: 'Yuna', series: 'Ghost of Tsushima', medium: 'game', year: 2020 },
  { name: 'Aether', series: 'Genshin Impact', medium: 'game', year: 2020 },
  { name: 'Paimon', series: 'Genshin Impact', medium: 'game', year: 2020, voiceQuality: 'a tiny, extremely high-pitched squeaky child voice — never deep or adult-sounding' },
  { name: 'Dante', series: 'Devil May Cry', medium: 'game', year: 2001, voiceQuality: "a brash, cocky American man's voice with a laughing swagger" },
  { name: 'Nero', series: 'Devil May Cry', medium: 'game', year: 2008, voiceQuality: "a hot-headed young man's voice, rough and quick to shout" },

  // ---- Anime ----
  { name: 'Tanjiro Kamado', series: 'Demon Slayer', medium: 'anime', year: 2019, voiceQuality: 'a gentle, earnest boyish voice that strains into a shout in battle' },
  { name: 'Nezuko Kamado', series: 'Demon Slayer', medium: 'anime', year: 2019 },
  { name: 'Shinobu Kocho', series: 'Demon Slayer', medium: 'anime', year: 2019, voiceQuality: 'a soft, sing-song feminine voice, sweet on the surface with a cold edge' },
  { name: 'Naruto Uzumaki', series: 'Naruto', medium: 'anime', year: 2002, voiceQuality: 'a brash, scratchy boyish shout, loud and energetic — never deep or adult-sounding' },
  { name: 'Sakura Haruno', series: 'Naruto', medium: 'anime', year: 2002, voiceQuality: 'a bright young feminine voice that snaps loud when angry' },
  { name: 'Sasuke Uchiha', series: 'Naruto', medium: 'anime', year: 2002, filled: true, voiceQuality: "a cool, low young man's voice with a clipped, flat delivery" },
  { name: 'Kakashi Hatake', series: 'Naruto', medium: 'anime', year: 2002, filled: true, voiceQuality: 'a lazy, low adult male voice with an unhurried, bored drawl' },
  { name: 'Frieren', series: 'Frieren', origin: "the anime series Frieren: Beyond Journey's End (2023)", hint: 'May drift off-model without extra prompting', voiceQuality: 'a flat, quiet, unhurried feminine voice with almost no inflection' },
  { name: 'Goku', series: 'Dragon Ball', origin: 'the anime series Dragon Ball Z (1989)', voiceQuality: 'a high, boyish adult voice with an eager, simple delivery that turns to a roar when shouting — never deep or smooth' },
  { name: 'Android 18', series: 'Dragon Ball', origin: 'the anime series Dragon Ball Z (1989)', voiceQuality: 'a cool, flat feminine voice, bored and unimpressed' },
  { name: 'Vegeta', series: 'Dragon Ball', origin: 'the anime series Dragon Ball Z (1989)', filled: true, voiceQuality: 'a proud, gravelly adult male voice with a sneering, clipped delivery' },
  { name: 'Eren Yeager', series: 'Attack on Titan', medium: 'anime', year: 2013, voiceQuality: "a strained, intense young man's voice that breaks into a hoarse shout" },
  { name: 'Sailor Moon', series: 'Sailor Moon', medium: 'anime', year: 1992, filled: true, voiceQuality: "a high, bright, whiny teenage girl's voice — never deep or adult-sounding" },
  { name: 'Monkey D. Luffy', series: 'One Piece', medium: 'anime', year: 1999, filled: true, voiceQuality: 'a rough, boyish, carefree voice, loud and simple — never deep or adult-sounding' },
  { name: 'Roronoa Zoro', series: 'One Piece', medium: 'anime', year: 1999, filled: true, voiceQuality: "a deep, gruff young man's voice, terse and low" },
  { name: 'Nami', series: 'One Piece', medium: 'anime', year: 1999, filled: true, voiceQuality: 'a bright, sharp feminine voice that snaps when annoyed' },
  { name: 'Pikachu', series: 'Pokémon', medium: 'anime', year: 1997, filled: true, voiceQuality: 'a tiny, very high-pitched squeaky voice — never deep or adult-sounding' },
  { name: 'Ash Ketchum', series: 'Pokémon', medium: 'anime', year: 1997, filled: true, voiceQuality: 'a boyish, eager voice, high and enthusiastic — never adult-sounding' },
  { name: 'Charizard', series: 'Pokémon', medium: 'anime', year: 1997, filled: true },
  { name: 'Aang', series: 'Avatar: The Last Airbender', medium: 'animation', year: 2005, filled: true, voiceQuality: 'a light, boyish voice, playful and quick — never deep or adult-sounding' },
  { name: 'Katara', series: 'Avatar: The Last Airbender', medium: 'animation', year: 2005, filled: true, voiceQuality: "a warm teenage girl's voice, earnest and clear" },
  { name: 'Zuko', series: 'Avatar: The Last Airbender', medium: 'animation', year: 2005, filled: true, voiceQuality: "a tense, raspy teenage boy's voice, clipped and angry" },
  { name: 'Toph Beifong', series: 'Avatar: The Last Airbender', medium: 'animation', year: 2005, filled: true, voiceQuality: "a brash girl's voice, low for her age, with a cocky drawl" },

  // ---- Live-action TV ----
  { name: 'Captain Picard', series: 'Star Trek: The Next Generation', prompt: 'Captain Jean-Luc Picard', medium: 'tv', year: 1987, actor: 'Patrick Stewart' },
  { name: 'Commander Riker', series: 'Star Trek: The Next Generation', prompt: 'Commander William Riker', medium: 'tv', year: 1987, actor: 'Jonathan Frakes' },
  { name: 'Deanna Troi', series: 'Star Trek: The Next Generation', prompt: 'Counselor Deanna Troi', medium: 'tv', year: 1987, actor: 'Marina Sirtis' },
  { name: 'Data', series: 'Star Trek: The Next Generation', medium: 'tv', year: 1987, actor: 'Brent Spiner' },
  { name: 'Geordi La Forge', series: 'Star Trek: The Next Generation', medium: 'tv', year: 1987, actor: 'LeVar Burton' },
  { name: 'Worf', series: 'Star Trek: The Next Generation', medium: 'tv', year: 1987, actor: 'Michael Dorn' },
  { name: 'Jerry Seinfeld', series: 'Seinfeld', medium: 'tv', year: 1989, actor: 'Jerry Seinfeld' },
  { name: 'George Costanza', series: 'Seinfeld', medium: 'tv', year: 1989, actor: 'Jason Alexander' },
  { name: 'Elaine Benes', series: 'Seinfeld', medium: 'tv', year: 1989, actor: 'Julia Louis-Dreyfus' },
  { name: 'Cosmo Kramer', series: 'Seinfeld', medium: 'tv', year: 1989, actor: 'Michael Richards' },
  { name: 'Walter White', series: 'Breaking Bad', medium: 'tv', year: 2008, actor: 'Bryan Cranston' },
  { name: 'Jesse Pinkman', series: 'Breaking Bad', medium: 'tv', year: 2008, actor: 'Aaron Paul' },
  { name: 'Saul Goodman', series: 'Breaking Bad', medium: 'tv', year: 2008, actor: 'Bob Odenkirk' },
  { name: 'Buffy Summers', series: 'Buffy the Vampire Slayer', medium: 'tv', year: 1997, actor: 'Sarah Michelle Gellar' },
  { name: 'Willow Rosenberg', series: 'Buffy the Vampire Slayer', medium: 'tv', year: 1997, actor: 'Alyson Hannigan' },
  { name: 'Angel', series: 'Buffy the Vampire Slayer', medium: 'tv', year: 1997, actor: 'David Boreanaz' },
  { name: 'Spike', series: 'Buffy the Vampire Slayer', medium: 'tv', year: 1997, actor: 'James Marsters' },
  { name: 'Malcolm Reynolds', series: 'Firefly', medium: 'tv', year: 2002, actor: 'Nathan Fillion' },
  { name: 'Fox Mulder', series: 'The X-Files', medium: 'tv', year: 1993, actor: 'David Duchovny', filled: true },
  { name: 'Dana Scully', series: 'The X-Files', medium: 'tv', year: 1993, actor: 'Gillian Anderson', filled: true },
  { name: 'The Tenth Doctor', series: 'Doctor Who', prompt: 'the Tenth Doctor', medium: 'tv', year: 2005, actor: 'David Tennant', filled: true },
  { name: 'Dalek', series: 'Doctor Who', prompt: 'a Dalek', medium: 'tv', year: 1963, filled: true, voiceQuality: 'a harsh, grating electronic monotone, shouted and metallic — never human-sounding' },
  { name: 'Clara Oswald', series: 'Doctor Who', medium: 'tv', year: 1963, actor: 'Jenna Coleman' },
  { name: 'The Eleventh Doctor', series: 'Doctor Who', medium: 'tv', year: 1963, actor: 'Matt Smith' },
  { name: 'The Twelfth Doctor', series: 'Doctor Who', medium: 'tv', year: 1963, actor: 'Peter Capaldi' },
  { name: 'Jon Snow', series: 'Game of Thrones', medium: 'tv', year: 2011, actor: 'Kit Harington', filled: true, hint: 'GoT reported hit-or-miss' },
  { name: 'Daenerys Targaryen', series: 'Game of Thrones', medium: 'tv', year: 2011, actor: 'Emilia Clarke', filled: true, hint: 'GoT reported hit-or-miss' },
  { name: 'Tyrion Lannister', series: 'Game of Thrones', medium: 'tv', year: 2011, actor: 'Peter Dinklage', filled: true, hint: 'GoT reported hit-or-miss' },
  { name: 'Arya Stark', series: 'Game of Thrones', medium: 'tv', year: 2011, actor: 'Maisie Williams', filled: true, hint: 'GoT reported hit-or-miss' },
  { name: 'Oberyn Martell', series: 'Game of Thrones', medium: 'tv', year: 2011, actor: 'Pedro Pascal', hint: 'Mixed results in testing' },
  { name: 'Sheldon Cooper', series: 'The Big Bang Theory', medium: 'tv', year: 2007, actor: 'Jim Parsons', filled: true },
  { name: 'Leonard Hofstadter', series: 'The Big Bang Theory', medium: 'tv', year: 2007, actor: 'Johnny Galecki', filled: true },
  { name: 'Penny', series: 'The Big Bang Theory', medium: 'tv', year: 2007, actor: 'Kaley Cuoco', filled: true },
  { name: 'Amy Farrah Fowler', series: 'The Big Bang Theory', medium: 'tv', year: 2007, actor: 'Mayim Bialik' },
  { name: 'Bernadette Rostenkowski', series: 'The Big Bang Theory', medium: 'tv', year: 2007, actor: 'Melissa Rauch' },
  { name: 'Howard Wolowitz', series: 'The Big Bang Theory', medium: 'tv', year: 2007, actor: 'Simon Helberg' },
  { name: 'Raj Koothrappali', series: 'The Big Bang Theory', medium: 'tv', year: 2007, actor: 'Kunal Nayyar' },
  { name: 'Malcolm', series: 'Malcolm in the Middle', medium: 'tv', year: 2000, actor: 'Frankie Muniz', filled: true },
  { name: 'Hal', series: 'Malcolm in the Middle', medium: 'tv', year: 2000, actor: 'Bryan Cranston', filled: true },
  { name: 'Michael Scott', series: 'The Office', medium: 'tv', year: 2005, actor: 'Steve Carell', filled: true },
  { name: 'Dwight Schrute', series: 'The Office', medium: 'tv', year: 2005, actor: 'Rainn Wilson', filled: true },
  { name: 'Jim Halpert', series: 'The Office', medium: 'tv', year: 2005, actor: 'John Krasinski', filled: true },
  { name: 'Pam Beesly', series: 'The Office', medium: 'tv', year: 2005, actor: 'Jenna Fischer', filled: true },
  { name: 'Andy Bernard', series: 'The Office', medium: 'tv', year: 2005, actor: 'Ed Helms' },
  { name: 'Rachel Green', series: 'Friends', medium: 'tv', year: 1994, actor: 'Jennifer Aniston', filled: true },
  { name: 'Ross Geller', series: 'Friends', medium: 'tv', year: 1994, actor: 'David Schwimmer', filled: true },
  { name: 'Monica Geller', series: 'Friends', medium: 'tv', year: 1994, actor: 'Courteney Cox', filled: true },
  { name: 'Chandler Bing', series: 'Friends', medium: 'tv', year: 1994, actor: 'Matthew Perry', filled: true },
  { name: 'Joey Tribbiani', series: 'Friends', medium: 'tv', year: 1994, actor: 'Matt LeBlanc', filled: true },
  { name: 'Phoebe Buffay', series: 'Friends', medium: 'tv', year: 1994, actor: 'Lisa Kudrow', filled: true },
  { name: 'Homelander', series: 'The Boys', medium: 'tv', year: 2019, actor: 'Antony Starr', filled: true },
  { name: 'Billy Butcher', series: 'The Boys', medium: 'tv', year: 2019, actor: 'Karl Urban', filled: true },
  { name: 'Caroline Channing', series: '2 Broke Girls', medium: 'tv', year: 2011, actor: 'Beth Behrs' },
  { name: 'Max Black', series: '2 Broke Girls', medium: 'tv', year: 2011, actor: 'Kat Dennings' },
  { name: 'Jack Bauer', series: '24', medium: 'tv', year: 2001, actor: 'Kiefer Sutherland' },
  { name: 'Jack Donaghy', series: '30 Rock', medium: 'tv', year: 2006, actor: 'Alec Baldwin' },
  { name: 'Liz Lemon', series: '30 Rock', medium: 'tv', year: 2006, actor: 'Tina Fey' },
  { name: 'Bruce Wayne / Batman', series: 'Batman', medium: 'tv', year: 1966, actor: 'Adam West', hint: 'Mixed results in testing' },
  { name: 'Celeste Wright', series: 'Big Little Lies', medium: 'tv', year: 2017, actor: 'Nicole Kidman' },
  { name: 'Madeline Martha Mackenzie', series: 'Big Little Lies', medium: 'tv', year: 2017, actor: 'Reese Witherspoon' },
  { name: 'Dr. Temperance Brennan', series: 'Bones', medium: 'tv', year: 2005, actor: 'Emily Deschanel' },
  { name: 'Seeley Booth', series: 'Bones', medium: 'tv', year: 2005, actor: 'David Boreanaz' },
  { name: 'Captain Raymond Holt', series: 'Brooklyn Nine-Nine', medium: 'tv', year: 2013, actor: 'Andre Braugher' },
  { name: 'Detective Rosa Diaz', series: 'Brooklyn Nine-Nine', medium: 'tv', year: 2013, actor: 'Stephanie Beatriz' },
  { name: 'Jake Peralta', series: 'Brooklyn Nine-Nine', medium: 'tv', year: 2013, actor: 'Andy Samberg' },
  { name: 'Sergeant Terry Jeffords', series: 'Brooklyn Nine-Nine', medium: 'tv', year: 2013, actor: 'Terry Crews' },
  { name: 'Hank Moody', series: 'Californication', medium: 'tv', year: 2007, actor: 'David Duchovny' },
  { name: 'Kate Beckett', series: 'Castle', medium: 'tv', year: 2009, actor: 'Stana Katic' },
  { name: 'Richard Castle', series: 'Castle', medium: 'tv', year: 2009, actor: 'Nathan Fillion' },
  { name: 'Dr. Doug Ross', series: 'ER', medium: 'tv', year: 1994, actor: 'George Clooney' },
  { name: 'Agent Olivia Dunham', series: 'Fringe', medium: 'tv', year: 2008, actor: 'Anna Torv', hint: 'Mixed results in testing' },
  { name: 'Dr. Walter Bishop', series: 'Fringe', medium: 'tv', year: 2008, actor: 'John Noble' },
  { name: 'Melinda Gordon', series: 'Ghost Whisperer', medium: 'tv', year: 2005, actor: 'Jennifer Love Hewitt' },
  { name: 'Dr. Hannibal Lecter', series: 'Hannibal', medium: 'tv', year: 2013, actor: 'Mads Mikkelsen' },
  { name: 'Tim "The Tool Man" Taylor', series: 'Home Improvement', medium: 'tv', year: 1991, actor: 'Tim Allen' },
  { name: 'Carrie Mathison', series: 'Homeland', medium: 'tv', year: 2011, actor: 'Claire Danes' },
  { name: 'Nicholas Brody', series: 'Homeland', medium: 'tv', year: 2011, actor: 'Damian Lewis' },
  { name: 'Saul Berenson', series: 'Homeland', medium: 'tv', year: 2011, actor: 'Mandy Patinkin' },
  { name: 'Dr. Gregory House', series: 'House M.D.', medium: 'tv', year: 2004, actor: 'Hugh Laurie' },
  { name: 'Frank Underwood', series: 'House of Cards', medium: 'tv', year: 2013, actor: 'Kevin Spacey' },
  { name: 'Daemon Targaryen', series: 'House of the Dragon', medium: 'tv', year: 2022, actor: 'Matt Smith' },
  { name: 'Barney Stinson', series: 'How I Met Your Mother', medium: 'tv', year: 2005, actor: 'Neil Patrick Harris' },
  { name: 'Ted Mosby', series: 'How I Met Your Mother', medium: 'tv', year: 2005, actor: 'Josh Radnor' },
  { name: 'Annalise Keating', series: 'How to Get Away with Murder', medium: 'tv', year: 2014, actor: 'Viola Davis' },
  { name: 'Jessica Jones', series: 'Jessica Jones', medium: 'tv', year: 2015, actor: 'Krysten Ritter' },
  { name: 'Eve Polastri', series: 'Killing Eve', medium: 'tv', year: 2018, actor: 'Sandra Oh' },
  { name: 'Jack Shephard', series: 'Lost', medium: 'tv', year: 2004, actor: 'Matthew Fox' },
  { name: 'John Locke', series: 'Lost', medium: 'tv', year: 2004, actor: "Terry O'Quinn" },
  { name: 'Chloe Decker', series: 'Lucifer', medium: 'tv', year: 2016, actor: 'Lauren German' },
  { name: 'Lucifer Morningstar', series: 'Lucifer', medium: 'tv', year: 2016, actor: 'Tom Ellis' },
  { name: 'Luke Cage', series: 'Luke Cage', medium: 'tv', year: 2016, actor: 'Mike Colter' },
  { name: 'John Luther', series: 'Luther', medium: 'tv', year: 2010, actor: 'Idris Elba' },
  { name: 'Don Draper', series: 'Mad Men', medium: 'tv', year: 2007, actor: 'Jon Hamm' },
  { name: 'Adrian Monk', series: 'Monk', medium: 'tv', year: 2002, actor: 'Tony Shalhoub' },
  { name: 'Marc Spector / Moon Knight', series: 'Moon Knight', medium: 'tv', year: 2022, actor: 'Oscar Isaac', hint: 'Mixed results in testing' },
  { name: 'Mr. Bean', series: 'Mr. Bean', medium: 'tv', year: 1990, actor: 'Rowan Atkinson' },
  { name: 'Darlene Alderson', series: 'Mr. Robot', medium: 'tv', year: 2015, actor: 'Carly Chaikin' },
  { name: 'Elliot Alderson', series: 'Mr. Robot', medium: 'tv', year: 2015, actor: 'Rami Malek' },
  { name: 'Abby Sciuto', series: 'NCIS', medium: 'tv', year: 2003, actor: 'Pauley Perrette' },
  { name: 'Anthony DiNozzo', series: 'NCIS', medium: 'tv', year: 2003, actor: 'Michael Weatherly' },
  { name: 'Special Agent Leroy Jethro Gibbs', series: 'NCIS', medium: 'tv', year: 2003, actor: 'Mark Harmon' },
  { name: 'Ziva David', series: 'NCIS', medium: 'tv', year: 2003, actor: 'Cote de Pablo' },
  { name: 'Javier Peña', series: 'Narcos', medium: 'tv', year: 2015, actor: 'Pedro Pascal' },
  { name: 'Peacemaker', series: 'Peacemaker', medium: 'tv', year: 2022, actor: 'John Cena' },
  { name: 'Tommy Shelby', series: 'Peaky Blinders', medium: 'tv', year: 2013, actor: 'Cillian Murphy' },
  { name: 'Harold Finch', series: 'Person of Interest', medium: 'tv', year: 2011, actor: 'Michael Emerson' },
  { name: 'John Reese', series: 'Person of Interest', medium: 'tv', year: 2011, actor: 'Jim Caviezel' },
  { name: 'Michael Scofield', series: 'Prison Break', medium: 'tv', year: 2005, actor: 'Wentworth Miller' },
  { name: 'Carrie Bradshaw', series: 'Sex and the City', medium: 'tv', year: 1998, actor: 'Sarah Jessica Parker' },
  { name: 'Dr. John Watson', series: 'Sherlock', medium: 'tv', year: 2010, actor: 'Martin Freeman' },
  { name: 'Sherlock Holmes', series: 'Sherlock', medium: 'tv', year: 2010, actor: 'Benedict Cumberbatch' },
  { name: 'Clark Kent', series: 'Smallville', medium: 'tv', year: 2001, actor: 'Tom Welling' },
  { name: 'Jax Teller', series: 'Sons of Anarchy', medium: 'tv', year: 2008, actor: 'Charlie Hunnam' },
  { name: 'Jonathan Archer', series: 'Star Trek: Enterprise', medium: 'tv', year: 2001, actor: 'Scott Bakula', hint: 'Mixed results in testing' },
  { name: 'Spock', series: 'Star Trek: The Original Series', medium: 'tv', year: 1966, actor: 'Leonard Nimoy' },
  { name: 'Dr. Rodney McKay', series: 'Stargate Atlantis', medium: 'tv', year: 2004, actor: 'David Hewlett' },
  { name: 'Lt. Colonel John Sheppard', series: 'Stargate Atlantis', medium: 'tv', year: 2004, actor: 'Joe Flanigan' },
  { name: 'Eleven', series: 'Stranger Things', medium: 'tv', year: 2016, actor: 'Millie Bobby Brown' },
  { name: 'Bobby Singer', series: 'Supernatural', medium: 'tv', year: 2005, actor: 'Jim Beaver' },
  { name: 'Castiel', series: 'Supernatural', medium: 'tv', year: 2005, actor: 'Misha Collins' },
  { name: 'Dean Winchester', series: 'Supernatural', medium: 'tv', year: 2005, actor: 'Jensen Ackles' },
  { name: 'Sam Winchester', series: 'Supernatural', medium: 'tv', year: 2005, actor: 'Jared Padalecki' },
  { name: 'Michael Kelso', series: "That '70s Show", medium: 'tv', year: 1998, actor: 'Ashton Kutcher' },
  { name: 'Raymond Reddington', series: 'The Blacklist', medium: 'tv', year: 2013, actor: 'James Spader' },
  { name: 'Sam Wilson / Falcon', series: 'The Falcon and the Winter Soldier', medium: 'tv', year: 2021, actor: 'Anthony Mackie', hint: 'Mixed results in testing' },
  { name: 'Barry Allen / The Flash', series: 'The Flash', medium: 'tv', year: 2014, actor: 'Grant Gustin' },
  { name: 'Patrick Jane', series: 'The Mentalist', medium: 'tv', year: 2008, actor: 'Simon Baker' },
  { name: 'John Nolan', series: 'The Rookie', medium: 'tv', year: 2018, actor: 'Nathan Fillion' },
  { name: 'Tony Soprano', series: 'The Sopranos', medium: 'tv', year: 1999, actor: 'James Gandolfini' },
  { name: 'Daryl Dixon', series: 'The Walking Dead', medium: 'tv', year: 2010, actor: 'Norman Reedus' },
  { name: 'Glenn Rhee', series: 'The Walking Dead', medium: 'tv', year: 2010, actor: 'Steven Yeun' },
  { name: 'Michonne', series: 'The Walking Dead', medium: 'tv', year: 2010, actor: 'Danai Gurira' },
  { name: 'Negan', series: 'The Walking Dead', medium: 'tv', year: 2010, actor: 'Jeffrey Dean Morgan' },
  { name: 'Rick Grimes', series: 'The Walking Dead', medium: 'tv', year: 2010, actor: 'Andrew Lincoln' },
  { name: 'Josh Lyman', series: 'The West Wing', medium: 'tv', year: 1999, actor: 'Bradley Whitford' },
  { name: 'President Josiah "Jed" Bartlet', series: 'The West Wing', medium: 'tv', year: 1999, actor: 'Martin Sheen' },
  { name: 'Sam Seaborn', series: 'The West Wing', medium: 'tv', year: 1999, actor: 'Rob Lowe' },
  { name: 'Stringer Bell', series: 'The Wire', medium: 'tv', year: 2002, actor: 'Idris Elba' },
  { name: 'Rust Cohle', series: 'True Detective', medium: 'tv', year: 2014, actor: 'Matthew McConaughey' },
  { name: 'Alan Harper', series: 'Two and a Half Men', medium: 'tv', year: 2003, actor: 'Jon Cryer' },
  { name: 'Charlie Harper', series: 'Two and a Half Men', medium: 'tv', year: 2003, actor: 'Charlie Sheen' },
  { name: 'Bjorn Ironside', series: 'Vikings', medium: 'tv', year: 2013, actor: 'Alexander Ludwig' },
  { name: 'Ragnar Lothbrok', series: 'Vikings', medium: 'tv', year: 2013, actor: 'Travis Fimmel' },
  { name: 'Wednesday Addams', series: 'Wednesday', medium: 'tv', year: 2022, actor: 'Jenna Ortega' },
  { name: 'Dr. Robert Ford', series: 'Westworld', medium: 'tv', year: 2016, actor: 'Anthony Hopkins' },
  { name: 'John Dutton', series: 'Yellowstone', medium: 'tv', year: 2018, actor: 'Kevin Costner' },

  // ---- Animated TV ----
  { name: 'Homer Simpson', series: 'The Simpsons', medium: 'animation', year: 1989, voiceActor: 'Dan Castellaneta', voiceQuality: "a gruff, dopey adult male voice with a slack, slurring delivery" },
  { name: 'Marge Simpson', series: 'The Simpsons', medium: 'animation', year: 1989, voiceActor: 'Julie Kavner', filled: true },
  { name: 'Bart Simpson', series: 'The Simpsons', medium: 'animation', year: 1989, voiceActor: 'Nancy Cartwright', filled: true, voiceQuality: "a bratty ten-year-old boy's voice, raspy and mischievous — never adult" },
  { name: 'Lisa Simpson', series: 'The Simpsons', medium: 'animation', year: 1989, voiceActor: 'Yeardley Smith', filled: true, voiceQuality: "a bright, earnest eight-year-old girl's voice — never adult" },
  { name: 'Rick Sanchez', series: 'Rick and Morty', medium: 'animation', year: 2013, voiceActor: 'Justin Roiland', filled: true },
  { name: 'Morty Smith', series: 'Rick and Morty', medium: 'animation', year: 2013, voiceActor: 'Justin Roiland', filled: true },
  { name: 'Beth Smith', series: 'Rick and Morty', medium: 'animation', year: 2013, voiceActor: 'Sarah Chalke' },
  { name: 'Summer Smith', series: 'Rick and Morty', medium: 'animation', year: 2013, voiceActor: 'Spencer Grammer' },
  { name: 'SpongeBob SquarePants', series: 'SpongeBob SquarePants', medium: 'animation', year: 1999, voiceActor: 'Tom Kenny', filled: true, voiceQuality: "high-pitched, nasal, squeaky and childlike, with a bright excitable delivery — never deep, gravelly or adult-sounding" },
  { name: 'Patrick Star', series: 'SpongeBob SquarePants', medium: 'animation', year: 1999, voiceActor: 'Bill Fagerbakke', filled: true, voiceQuality: "slow, dopey and low-pitched with a dim, unhurried delivery — never sharp or quick" },
  { name: 'Squidward Tentacles', series: 'SpongeBob SquarePants', medium: 'animation', year: 1999, voiceActor: 'Rodger Bumpass', filled: true, voiceQuality: "nasal, droning and sardonic, with a weary put-upon delivery — never bright or cheerful" },
  { name: 'Peter Griffin', series: 'Family Guy', medium: 'animation', year: 1999, voiceActor: 'Seth MacFarlane', filled: true },
  { name: 'Stewie Griffin', series: 'Family Guy', medium: 'animation', year: 1999, voiceActor: 'Seth MacFarlane', filled: true, voiceQuality: "a small child's voice with a theatrical upper-class English accent — never American and never adult" },
  { name: 'Brian Griffin', series: 'Family Guy', medium: 'animation', year: 1999, voiceActor: 'Seth MacFarlane', filled: true },
  { name: 'Eric Cartman', series: 'South Park', medium: 'animation', year: 1997, voiceActor: 'Trey Parker', filled: true, voiceQuality: "a nasal, whining boy's voice with a bratty petulant delivery — never adult" },
  { name: 'Stan Marsh', series: 'South Park', medium: 'animation', year: 1997, voiceActor: 'Trey Parker', filled: true },
  { name: 'Kyle Broflovski', series: 'South Park', medium: 'animation', year: 1997, voiceActor: 'Matt Stone', filled: true },
  { name: 'Kenny McCormick', series: 'South Park', medium: 'animation', year: 1997, voiceActor: 'Matt Stone', filled: true },
  { name: 'Randy Marsh', series: 'South Park', medium: 'animation', year: 1997, voiceActor: 'Trey Parker' },
  { name: 'Beavis', series: 'Beavis and Butt-Head', medium: 'animation', year: 1993, voiceActor: 'Mike Judge', filled: true },
  { name: 'Butt-Head', series: 'Beavis and Butt-Head', medium: 'animation', year: 1993, voiceActor: 'Mike Judge', filled: true },
  { name: 'Woody', series: 'Toy Story', medium: 'animated-film', year: 1995, voiceActor: 'Tom Hanks', filled: true },
  { name: 'Buzz Lightyear', series: 'Toy Story', medium: 'animated-film', year: 1995, voiceActor: 'Tim Allen', filled: true },
  { name: 'Leonardo', series: 'Teenage Mutant Ninja Turtles', medium: 'animation', year: 1987, filled: true, voiceQuality: "a steady, earnest young man's voice, the level-headed one" },
  { name: 'Raphael', series: 'Teenage Mutant Ninja Turtles', medium: 'animation', year: 1987, filled: true, voiceQuality: "a gruff, wisecracking young man's voice with a Brooklyn accent" },
  { name: 'Donatello', series: 'Teenage Mutant Ninja Turtles', medium: 'animation', year: 1987, filled: true, voiceQuality: "a light, quick, nerdy young man's voice" },
  { name: 'Michelangelo', series: 'Teenage Mutant Ninja Turtles', medium: 'animation', year: 1987, filled: true, voiceQuality: 'a goofy, high-energy surfer-accented young voice' },
  { name: 'Mickey Mouse', series: 'Disney', origin: 'the classic Disney animated cartoons (1928)', filled: true, voiceQuality: "a very high, breathy, falsetto voice — never deep or adult-sounding" },
  { name: 'Elsa', series: 'Disney', origin: 'the animated film Frozen (2013)', voiceActor: 'Idina Menzel', filled: true },
  { name: 'Caitlyn', series: 'Arcane', medium: 'animation', year: 2021, voiceActor: 'Katie Leung', hint: 'Mixed results in testing' },
  { name: 'Jinx', series: 'Arcane', medium: 'animation', year: 2021, voiceActor: 'Ella Purnell', hint: 'Mixed results in testing' },
  { name: 'Silco', series: 'Arcane', medium: 'animation', year: 2021, voiceActor: 'Jason Spisak', hint: 'Mixed results in testing' },
  { name: 'Vi', series: 'Arcane', medium: 'animation', year: 2021, voiceActor: 'Hailee Steinfeld', hint: 'Mixed results in testing' },

  // ---- Film ----
  { name: 'Shrek', series: 'Shrek', medium: 'animated-film', year: 2001, voiceActor: 'Mike Myers' },
  { name: 'Patrick Bateman', series: 'American Psycho', medium: 'film', year: 2000, actor: 'Christian Bale' },
  { name: 'Jack Sparrow', series: 'Pirates of the Caribbean', medium: 'films', year: 2003, actor: 'Johnny Depp' },
  { name: 'Elizabeth Swann', series: 'Pirates of the Caribbean', medium: 'films', year: 2003, actor: 'Keira Knightley' },
  { name: 'Harry Potter', series: 'Harry Potter', medium: 'films', year: 2001, actor: 'Daniel Radcliffe' },
  { name: 'Hermione Granger', series: 'Harry Potter', medium: 'films', year: 2001, actor: 'Emma Watson' },
  { name: 'Dumbledore', series: 'Harry Potter', medium: 'films', year: 2001, actor: 'Michael Gambon' },
  { name: 'Ron Weasley', series: 'Harry Potter', medium: 'films', year: 2001, actor: 'Rupert Grint' },
  { name: 'Rubeus Hagrid', series: 'Harry Potter', medium: 'films', year: 2001, actor: 'Robbie Coltrane' },
  { name: 'The Terminator', series: 'The Terminator', prompt: 'the T-800 Terminator', medium: 'film', year: 1984, actor: 'Arnold Schwarzenegger', filled: true },
  { name: 'Sarah Connor', series: 'The Terminator', medium: 'film', year: 1984, actor: 'Linda Hamilton', filled: true },
  { name: 'Darth Vader', series: 'Star Wars', medium: 'films', year: 1977, voiceActor: 'James Earl Jones', filled: true },
  { name: 'Luke Skywalker', series: 'Star Wars', medium: 'films', year: 1977, actor: 'Mark Hamill', filled: true },
  { name: 'Princess Leia', series: 'Star Wars', medium: 'films', year: 1977, actor: 'Carrie Fisher', filled: true },
  { name: 'Han Solo', series: 'Star Wars', medium: 'films', year: 1977, actor: 'Harrison Ford', filled: true },
  { name: 'Yoda', series: 'Star Wars', medium: 'films', year: 1977, filled: true, voiceQuality: "a small, croaky, high-pitched old voice with slow deliberate phrasing" },
  { name: 'Chewbacca', series: 'Star Wars', medium: 'films', year: 1977, filled: true },
  { name: 'Stormtrooper', series: 'Star Wars', prompt: 'a stormtrooper', medium: 'films', year: 1977, filled: true, voiceQuality: 'a male voice through a helmet comm filter, clipped and slightly distorted' },
  { name: 'Anakin Skywalker', series: 'Star Wars', medium: 'films', year: 1977, actor: 'Hayden Christensen' },
  { name: 'Kylo Ren', series: 'Star Wars', medium: 'films', year: 1977, actor: 'Adam Driver' },
  { name: 'Mace Windu', series: 'Star Wars', medium: 'films', year: 1977, actor: 'Samuel L. Jackson' },
  { name: 'Qui-Gon Jinn', series: 'Star Wars', medium: 'films', year: 1977, actor: 'Liam Neeson' },
  { name: 'Obi-Wan Kenobi', series: 'Star Wars', medium: 'films', year: 1977, actor: 'Ewan McGregor', hint: 'Mixed results in testing' },
  { name: 'Deadpool', series: 'Marvel', origin: 'the superhero film Deadpool (2016)', actor: 'Ryan Reynolds' },
  { name: 'Wolverine', series: 'Marvel', origin: 'the X-Men films (2000)', actor: 'Hugh Jackman' },
  { name: 'Iron Man', series: 'Marvel', origin: 'the Marvel Avengers films (2008)', actor: 'Robert Downey Jr.', filled: true },
  { name: 'Captain America', series: 'Marvel', origin: 'the Marvel Avengers films (2011)', actor: 'Chris Evans', filled: true },
  { name: 'Thor', series: 'Marvel', origin: 'the Marvel Avengers films (2011)', actor: 'Chris Hemsworth', filled: true },
  { name: 'Hulk', series: 'Marvel', prompt: 'the Hulk', origin: 'the Marvel Avengers films (2012)', filled: true, voiceQuality: 'a huge, deep, guttural roar of a voice, simple and shouted' },
  { name: 'Black Widow', series: 'Marvel', origin: 'the Marvel Avengers films (2010)', actor: 'Scarlett Johansson', filled: true },
  { name: 'Clint Barton / Hawkeye', series: 'Marvel', origin: 'the Marvel Avengers films (2012)', actor: 'Jeremy Renner' },
  { name: 'Doctor Strange', series: 'Marvel', origin: 'the Marvel superhero film Doctor Strange (2016)', actor: 'Benedict Cumberbatch' },
  { name: 'Loki', series: 'Marvel', origin: 'the Marvel Avengers films (2011)', actor: 'Tom Hiddleston' },
  { name: 'Nick Fury', series: 'Marvel', origin: 'the Marvel Avengers films (2008)', actor: 'Samuel L. Jackson' },
  { name: 'Scarlet Witch', series: 'Marvel', origin: 'the Marvel Avengers films (2015)', actor: 'Elizabeth Olsen' },
  { name: 'Scott Lang / Ant-Man', series: 'Marvel', origin: 'the Marvel superhero film Ant-Man (2015)', actor: 'Paul Rudd' },
  { name: 'Star-Lord', series: 'Marvel', origin: 'the Marvel film Guardians of the Galaxy (2014)', actor: 'Chris Pratt' },
  { name: 'Thanos', series: 'Marvel', origin: 'the Marvel Avengers films (2018)', actor: 'Josh Brolin' },
  { name: 'Batman', series: 'DC', origin: 'the DC comics (1939)', filled: true, voiceQuality: 'a low, gravelly growled male voice, quiet and clipped' },
  { name: 'Superman', series: 'DC', origin: 'the DC comics (1938)', filled: true },
  { name: 'Wonder Woman', series: 'DC', origin: 'the DC comics (1941)', filled: true },
  { name: 'Joker', series: 'DC', prompt: 'the Joker', origin: 'the DC comics (1940)', filled: true, voiceQuality: 'a manic, high, sing-song male voice that cracks into laughter' },
  { name: 'Neo', series: 'The Matrix', medium: 'film', year: 1999, actor: 'Keanu Reeves', filled: true },
  { name: 'Trinity', series: 'The Matrix', medium: 'film', year: 1999, actor: 'Carrie-Anne Moss', filled: true },
  { name: 'Morpheus', series: 'The Matrix', medium: 'film', year: 1999, actor: 'Laurence Fishburne', filled: true },
  { name: 'Agent Smith', series: 'The Matrix', medium: 'film', year: 1999, actor: 'Hugo Weaving', filled: true },
  { name: 'Ellen Ripley', series: 'Alien', medium: 'film', year: 1979, actor: 'Sigourney Weaver', filled: true },
  { name: 'Xenomorph', series: 'Alien', prompt: 'the xenomorph', medium: 'film', year: 1979, filled: true },
  { name: 'RoboCop', series: 'RoboCop', medium: 'film', year: 1987, actor: 'Peter Weller' },
  { name: 'Hellboy', series: 'Hellboy', medium: 'film', year: 2004, actor: 'Ron Perlman' },
  { name: 'Ace Ventura', series: 'Ace Ventura', medium: 'films', year: 1994, actor: 'Jim Carrey' },
  { name: 'Frank Lucas', series: 'American Gangster', medium: 'film', year: 2007, actor: 'Denzel Washington' },
  { name: 'Brick Tamland', series: 'Anchorman', medium: 'film', year: 2004, actor: 'Steve Carell' },
  { name: 'Ron Burgundy', series: 'Anchorman', medium: 'film', year: 2004, actor: 'Will Ferrell' },
  { name: 'Alvy Singer', series: 'Annie Hall', medium: 'film', year: 1977, actor: 'Woody Allen' },
  { name: 'Neytiri', series: 'Avatar', medium: 'film', year: 2009, actor: 'Zoe Saldana' },
  { name: 'Marty McFly', series: 'Back to the Future', medium: 'films', year: 1985, actor: 'Michael J. Fox' },
  { name: 'Barbie', series: 'Barbie', medium: 'film', year: 2023, actor: 'Margot Robbie', hint: 'Mixed results in testing' },
  { name: 'Bruce Wayne / Batman', series: 'Batman & Robin', medium: 'film', year: 1997, actor: 'George Clooney' },
  { name: 'Edward Nygma / The Riddler', series: 'Batman Forever', medium: 'film', year: 1995, actor: 'Jim Carrey' },
  { name: 'Catwoman / Selina Kyle', series: 'Batman Returns', medium: 'film', year: 1992, actor: 'Michelle Pfeiffer' },
  { name: 'Bruce Wayne / Batman', series: 'Batman v Superman', medium: 'film', year: 2016, actor: 'Ben Affleck' },
  { name: 'Lex Luthor', series: 'Batman v Superman', medium: 'film', year: 2016, actor: 'Jesse Eisenberg', hint: 'Mixed results in testing' },
  { name: 'Axel Foley', series: 'Beverly Hills Cop', medium: 'film', year: 1984, actor: 'Eddie Murphy' },
  { name: 'Erik Killmonger', series: 'Black Panther', medium: 'film', year: 2018, actor: 'Michael B. Jordan' },
  { name: "T'Challa / Black Panther", series: 'Black Panther', medium: 'film', year: 2018, actor: 'Chadwick Boseman', hint: 'Mixed results in testing' },
  { name: 'Rick Deckard', series: 'Blade Runner', medium: 'film', year: 1982, actor: 'Harrison Ford' },
  { name: 'God', series: 'Bruce Almighty', medium: 'film', year: 2003, actor: 'Morgan Freeman' },
  { name: 'Sam Ace Rothstein', series: 'Casino', medium: 'film', year: 1995, actor: 'Robert De Niro' },
  { name: 'James Bond', series: 'Casino Royale', medium: 'film', year: 2006, actor: 'Daniel Craig' },
  { name: 'Willy Wonka', series: 'Charlie and the Chocolate Factory', medium: 'film', year: 2005, actor: 'Johnny Depp' },
  { name: 'Alex Munday', series: "Charlie's Angels", medium: 'film', year: 2000, actor: 'Lucy Liu' },
  { name: 'Dylan Sanders', series: "Charlie's Angels", medium: 'film', year: 2000, actor: 'Drew Barrymore' },
  { name: 'Natalie Cook', series: "Charlie's Angels", medium: 'film', year: 2000, actor: 'Cameron Diaz' },
  { name: 'Cameron Poe', series: 'Con Air', medium: 'film', year: 1997, actor: 'Nicolas Cage' },
  { name: 'Conan', series: 'Conan the Barbarian', medium: 'film', year: 1982, actor: 'Arnold Schwarzenegger' },
  { name: 'Adonis Creed', series: 'Creed', medium: 'film', year: 2015, actor: 'Michael B. Jordan' },
  { name: 'Annette Hargrove', series: 'Cruel Intentions', medium: 'film', year: 1999, actor: 'Reese Witherspoon' },
  { name: 'Cruella de Vil', series: 'Cruella', medium: 'film', year: 2021, actor: 'Emma Stone', hint: 'Mixed results in testing' },
  { name: 'Matt Murdock', series: 'Daredevil', medium: 'film', year: 2003, actor: 'Ben Affleck' },
  { name: 'John McClane', series: 'Die Hard', medium: 'film', year: 1988, actor: 'Bruce Willis' },
  { name: 'Harry Callahan', series: 'Dirty Harry', medium: 'film', year: 1971, actor: 'Clint Eastwood' },
  { name: 'Calvin Candie', series: 'Django Unchained', medium: 'film', year: 2012, actor: 'Leonardo DiCaprio' },
  { name: 'Django Freeman', series: 'Django Unchained', medium: 'film', year: 2012, actor: 'Jamie Foxx' },
  { name: 'Rufus', series: 'Dogma', medium: 'film', year: 1999, actor: 'Chris Rock', hint: 'Mixed results in testing' },
  { name: 'Driver', series: 'Drive', medium: 'film', year: 2011, actor: 'Ryan Gosling' },
  { name: 'Lloyd Christmas', series: 'Dumb and Dumber', medium: 'film', year: 1994, actor: 'Jim Carrey' },
  { name: 'Paul Atreides', series: 'Dune', medium: 'film', year: 2021, actor: 'Timothée Chalamet' },
  { name: 'Edward Scissorhands', series: 'Edward Scissorhands', medium: 'film', year: 1990, actor: 'Johnny Depp' },
  { name: 'Giselle', series: 'Enchanted', medium: 'film', year: 2007, actor: 'Amy Adams', hint: 'Mixed results in testing' },
  { name: 'Tyler Rake', series: 'Extraction', medium: 'film', year: 2020, actor: 'Chris Hemsworth' },
  { name: 'Castor Troy', series: 'Face/Off', medium: 'film', year: 1997, actor: 'Nicolas Cage' },
  { name: 'Sean Archer', series: 'Face/Off', medium: 'film', year: 1997, actor: 'John Travolta' },
  { name: 'Gellert Grindelwald', series: 'Fantastic Beasts', medium: 'films', year: 2016, actor: 'Mads Mikkelsen' },
  { name: 'Dominic Toretto', series: 'Fast & Furious', medium: 'films', year: 2001, actor: 'Vin Diesel' },
  { name: 'The Narrator', series: 'Fight Club', medium: 'film', year: 1999, actor: 'Edward Norton' },
  { name: 'Tyler Durden', series: 'Fight Club', medium: 'film', year: 1999, actor: 'Brad Pitt' },
  { name: 'Ren McCormack', series: 'Footloose', medium: 'film', year: 1984, actor: 'Kevin Bacon', hint: 'Mixed results in testing' },
  { name: 'Forrest Gump', series: 'Forrest Gump', medium: 'film', year: 1994, actor: 'Tom Hanks' },
  { name: 'Johnny Blaze / Ghost Rider', series: 'Ghost Rider', medium: 'film', year: 2007, actor: 'Nicolas Cage' },
  { name: 'Commodus', series: 'Gladiator', medium: 'film', year: 2000, actor: 'Joaquin Phoenix' },
  { name: 'Maximus Decimus Meridius', series: 'Gladiator', medium: 'film', year: 2000, actor: 'Russell Crowe' },
  { name: 'Will Hunting', series: 'Good Will Hunting', medium: 'film', year: 1997, actor: 'Matt Damon' },
  { name: 'Jimmy Conway', series: 'Goodfellas', medium: 'film', year: 1990, actor: 'Robert De Niro' },
  { name: 'Ryan Stone', series: 'Gravity', medium: 'film', year: 2013, actor: 'Sandra Bullock', hint: 'Mixed results in testing' },
  { name: 'Danny Zuko', series: 'Grease', medium: 'film', year: 1978, actor: 'John Travolta', hint: 'Mixed results in testing' },
  { name: 'Happy Gilmore', series: 'Happy Gilmore', medium: 'film', year: 1996, actor: 'Adam Sandler' },
  { name: 'Vincent Hanna', series: 'Heat', medium: 'film', year: 1995, actor: 'Al Pacino' },
  { name: 'Pennywise', series: 'IT', medium: 'film', year: 2017, actor: 'Bill Skarsgård' },
  { name: 'Ray', series: 'In Bruges', medium: 'film', year: 2008, actor: 'Colin Farrell' },
  { name: 'Indiana Jones', series: 'Indiana Jones', medium: 'films', year: 1981, actor: 'Harrison Ford' },
  { name: 'Aldo Raine', series: 'Inglourious Basterds', medium: 'film', year: 2009, actor: 'Brad Pitt' },
  { name: 'Joseph Cooper', series: 'Interstellar', medium: 'film', year: 2014, actor: 'Matthew McConaughey' },
  { name: 'John Wick', series: 'John Wick', medium: 'films', year: 2014, actor: 'Keanu Reeves' },
  { name: 'Arthur Fleck as Joker', series: 'Joker', medium: 'film', year: 2019, actor: 'Joaquin Phoenix', hint: 'Mixed results in testing' },
  { name: 'Judge Joseph Dredd', series: 'Judge Dredd', medium: 'film', year: 1995, actor: 'Sylvester Stallone' },
  { name: 'Dr. Ian Malcolm', series: 'Jurassic Park', medium: 'film', year: 1993, actor: 'Jeff Goldblum', hint: 'Mixed results in testing' },
  { name: 'Owen Grady', series: 'Jurassic World', medium: 'film', year: 2015, actor: 'Chris Pratt' },
  { name: 'Benoit Blanc', series: 'Knives Out', medium: 'film', year: 2019, actor: 'Daniel Craig' },
  { name: 'Ransom Drysdale', series: 'Knives Out', medium: 'film', year: 2019, actor: 'Chris Evans' },
  { name: 'Lara Croft', series: 'Lara Croft: Tomb Raider', medium: 'film', year: 2001, actor: 'Angelina Jolie', hint: 'Mixed results in testing' },
  { name: 'Jean Valjean', series: 'Les Misérables', medium: 'film', year: 2012, actor: 'Hugh Jackman', hint: 'Mixed results in testing' },
  { name: 'Martin Riggs', series: 'Lethal Weapon', medium: 'films', year: 1987, actor: 'Mel Gibson' },
  { name: 'Fletcher Reede', series: 'Liar Liar', medium: 'film', year: 1997, actor: 'Jim Carrey' },
  { name: 'Max Rockatansky', series: 'Mad Max', medium: 'film', year: 1979, actor: 'Mel Gibson' },
  { name: 'Max Rockatansky', series: 'Mad Max: Fury Road', medium: 'film', year: 2015, actor: 'Tom Hardy' },
  { name: 'Maleficent', series: 'Maleficent', medium: 'film', year: 2014, actor: 'Angelina Jolie' },
  { name: 'Gracie Hart', series: 'Miss Congeniality', medium: 'film', year: 2000, actor: 'Sandra Bullock' },
  { name: 'Ethan Hunt', series: 'Mission: Impossible', medium: 'films', year: 1996, actor: 'Tom Cruise' },
  { name: 'Jane Smith', series: 'Mr. & Mrs. Smith', medium: 'film', year: 2005, actor: 'Angelina Jolie' },
  { name: 'Daniel Hillard / Mrs. Doubtfire', series: 'Mrs. Doubtfire', medium: 'film', year: 1993, actor: 'Robin Williams' },
  { name: 'Benjamin Franklin Gates', series: 'National Treasure', medium: 'film', year: 2004, actor: 'Nicolas Cage' },
  { name: 'Lou Bloom', series: 'Nightcrawler', medium: 'film', year: 2014, actor: 'Jake Gyllenhaal' },
  { name: 'Cliff Booth', series: 'Once Upon a Time in Hollywood', medium: 'film', year: 2019, actor: 'Brad Pitt' },
  { name: 'Rick Dalton', series: 'Once Upon a Time in Hollywood', medium: 'film', year: 2019, actor: 'Leonardo DiCaprio', hint: 'Mixed results in testing' },
  { name: 'J Robert Oppenheimer', series: 'Oppenheimer', medium: 'film', year: 2023, actor: 'Cillian Murphy' },
  { name: 'Alan Dutch Schaefer', series: 'Predator', medium: 'film', year: 1987, actor: 'Arnold Schwarzenegger' },
  { name: 'Jules Winnfield', series: 'Pulp Fiction', medium: 'film', year: 1994, actor: 'Samuel L. Jackson' },
  { name: 'Vincent Vega', series: 'Pulp Fiction', medium: 'film', year: 1994, actor: 'John Travolta' },
  { name: 'Alluri Sitarama Raju', series: 'RRR', medium: 'film', year: 2022, actor: 'Ram Charan' },
  { name: 'Komaram Bheem', series: 'RRR', medium: 'film', year: 2022, actor: 'N. T. Rama Rao Jr.' },
  { name: 'John Rambo', series: 'Rambo', medium: 'films', year: 1982, actor: 'Sylvester Stallone' },
  { name: 'Rocky Balboa', series: 'Rocky', medium: 'films', year: 1976, actor: 'Sylvester Stallone' },
  { name: 'James Hunt', series: 'Rush', medium: 'film', year: 2013, actor: 'Chris Hemsworth' },
  { name: 'Inspector Lee', series: 'Rush Hour', medium: 'film', year: 1998, actor: 'Jackie Chan' },
  { name: 'Tony Montana', series: 'Scarface', medium: 'film', year: 1983, actor: 'Al Pacino' },
  { name: 'Frank Slade', series: 'Scent of a Woman', medium: 'film', year: 1992, actor: 'Al Pacino' },
  { name: 'William Somerset', series: 'Se7en', medium: 'film', year: 1995, actor: 'Morgan Freeman' },
  { name: 'Sherlock Holmes', series: 'Sherlock Holmes', medium: 'film', year: 2009, actor: 'Robert Downey Jr.' },
  { name: 'Annie Porter', series: 'Speed', medium: 'film', year: 1994, actor: 'Sandra Bullock', hint: 'Mixed results in testing' },
  { name: 'Norman Osborn', series: 'Spider-Man', medium: 'film', year: 2002, actor: 'Willem Dafoe' },
  { name: 'Brennan Huff', series: 'Step Brothers', medium: 'film', year: 2008, actor: 'Will Ferrell' },
  { name: 'Seth', series: 'Superbad', medium: 'film', year: 2007, actor: 'Jonah Hill' },
  { name: 'Lex Luthor', series: 'Superman Returns', medium: 'film', year: 2006, actor: 'Kevin Spacey' },
  { name: 'Bryan Mills', series: 'Taken', medium: 'film', year: 2008, actor: 'Liam Neeson' },
  { name: 'Ricky Bobby', series: 'Talladega Nights', medium: 'film', year: 2006, actor: 'Will Ferrell' },
  { name: 'Travis Bickle', series: 'Taxi Driver', medium: 'film', year: 1976, actor: 'Robert De Niro' },
  { name: 'Andy Stitzer', series: 'The 40-Year-Old Virgin', medium: 'film', year: 2005, actor: 'Steve Carell' },
  { name: 'Bruce Wayne / Batman', series: 'The Batman', medium: 'film', year: 2022, actor: 'Robert Pattinson' },
  { name: 'Commissioner James Gordon', series: 'The Batman', medium: 'film', year: 2022, actor: 'Jeffrey Wright', hint: 'Mixed results in testing' },
  { name: 'Jason Bourne', series: 'The Bourne Identity', medium: 'films', year: 2002, actor: 'Matt Damon' },
  { name: 'Richard B. Riddick', series: 'The Chronicles of Riddick', medium: 'film', year: 2004, actor: 'Vin Diesel' },
  { name: 'Alfred Pennyworth', series: 'The Dark Knight', medium: 'film', year: 2008, actor: 'Michael Caine', hint: 'Mixed results in testing' },
  { name: 'Bruce Wayne / Batman', series: 'The Dark Knight', medium: 'film', year: 2008, actor: 'Christian Bale' },
  { name: 'Billy Costigan', series: 'The Departed', medium: 'film', year: 2006, actor: 'Leonardo DiCaprio' },
  { name: 'Frank Costello', series: 'The Departed', medium: 'film', year: 2006, actor: 'Jack Nicholson' },
  { name: 'Sean Dignam', series: 'The Departed', medium: 'film', year: 2006, actor: 'Mark Wahlberg' },
  { name: 'Andy Sachs', series: 'The Devil Wears Prada', medium: 'film', year: 2006, actor: 'Anne Hathaway' },
  { name: 'Miranda Priestly', series: 'The Devil Wears Prada', medium: 'film', year: 2006, actor: 'Meryl Streep' },
  { name: 'Robert McCall', series: 'The Equalizer', medium: 'film', year: 2014, actor: 'Denzel Washington' },
  { name: 'Barney Ross', series: 'The Expendables', medium: 'film', year: 2010, actor: 'Sylvester Stallone' },
  { name: 'Richard Kimble', series: 'The Fugitive', medium: 'film', year: 1993, actor: 'Harrison Ford' },
  { name: 'Samuel Gerard', series: 'The Fugitive', medium: 'film', year: 1993, actor: 'Tommy Lee Jones', hint: 'Mixed results in testing' },
  { name: 'Michael Corleone', series: 'The Godfather', medium: 'film', year: 1972, actor: 'Al Pacino' },
  { name: 'P.T. Barnum', series: 'The Greatest Showman', medium: 'film', year: 2017, actor: 'Hugh Jackman', hint: 'Mixed results in testing' },
  { name: 'Phil Wenneck', series: 'The Hangover', medium: 'film', year: 2009, actor: 'Bradley Cooper' },
  { name: 'Major Marquis Warren', series: 'The Hateful Eight', medium: 'film', year: 2015, actor: 'Samuel L. Jackson' },
  { name: 'Bilbo Baggins', series: 'The Hobbit', medium: 'films', year: 2012, actor: 'Martin Freeman' },
  { name: 'Navin R. Johnson', series: 'The Jerk', medium: 'film', year: 1979, actor: 'Steve Martin' },
  { name: 'Idi Amin', series: 'The Last King of Scotland', medium: 'film', year: 2006, actor: 'Forest Whitaker', hint: 'Mixed results in testing' },
  { name: 'Gandalf', series: 'The Lord of the Rings', medium: 'films', year: 2001, actor: 'Ian McKellen' },
  { name: 'Mark Watney', series: 'The Martian', medium: 'film', year: 2015, actor: 'Matt Damon' },
  { name: 'Stanley Ipkiss as The Mask', series: 'The Mask', medium: 'film', year: 1994, actor: 'Jim Carrey' },
  { name: "Rick O'Connell", series: 'The Mummy', medium: 'film', year: 1999, actor: 'Brendan Fraser', hint: 'Mixed results in testing' },
  { name: 'Mathayus', series: 'The Scorpion King', medium: 'film', year: 2002, actor: 'Dwayne Johnson' },
  { name: "Ellis Boyd 'Red' Redding", series: 'The Shawshank Redemption', medium: 'film', year: 1994, actor: 'Morgan Freeman' },
  { name: 'Dr. Hannibal Lecter', series: 'The Silence of the Lambs', medium: 'film', year: 1991, actor: 'Anthony Hopkins' },
  { name: 'Frank Martin', series: 'The Transporter', medium: 'film', year: 2002, actor: 'Jason Statham' },
  { name: 'Jordan Belfort', series: 'The Wolf of Wall Street', medium: 'film', year: 2013, actor: 'Leonardo DiCaprio' },
  { name: 'Jack Dawson', series: 'Titanic', medium: 'film', year: 1997, actor: 'Leonardo DiCaprio' },
  { name: 'Maverick / Pete Mitchell', series: 'Top Gun', medium: 'film', year: 1986, actor: 'Tom Cruise' },
  { name: 'Douglas Quaid', series: 'Total Recall', medium: 'film', year: 1990, actor: 'Arnold Schwarzenegger' },
  { name: 'Alonzo Harris', series: 'Training Day', medium: 'film', year: 2001, actor: 'Denzel Washington' },
  { name: 'Kirk Lazarus', series: 'Tropic Thunder', medium: 'film', year: 2008, actor: 'Robert Downey Jr.' },
  { name: 'Bella Swan', series: 'Twilight', medium: 'films', year: 2008, actor: 'Kristen Stewart' },
  { name: 'Edward Cullen', series: 'Twilight', medium: 'films', year: 2008, actor: 'Robert Pattinson' },
  { name: 'William Munny', series: 'Unforgiven', medium: 'film', year: 1992, actor: 'Clint Eastwood' },
  { name: 'Eddie Brock', series: 'Venom', medium: 'film', year: 2018, actor: 'Tom Hardy' },
  { name: 'Gordon Gekko', series: 'Wall Street', medium: 'film', year: 1987, actor: 'Michael Douglas' },
  { name: 'Jeremy Grey', series: 'Wedding Crashers', medium: 'film', year: 2005, actor: 'Vince Vaughn' },
  { name: 'Diana Prince / Wonder Woman', series: 'Wonder Woman', medium: 'film', year: 2017, actor: 'Gal Gadot' },
  { name: 'Magneto', series: 'X-Men', medium: 'films', year: 2000, actor: 'Michael Fassbender', hint: 'Mixed results in testing' },
  { name: 'Tallahassee', series: 'Zombieland', medium: 'film', year: 2009, actor: 'Woody Harrelson' },
  { name: 'Derek Zoolander', series: 'Zoolander', medium: 'film', year: 2001, actor: 'Ben Stiller' },
  { name: 'Hansel', series: 'Zoolander', medium: 'film', year: 2001, actor: 'Owen Wilson' },
]);

// "the television series Buffy the Vampire Slayer (1997)" — the source clause
// the community format hangs a character on.
export function characterOriginText(entry) {
  if (!entry) return '';
  if (entry.origin) return entry.origin;
  const medium = MEDIUM_PHRASE[entry.medium] || 'the series';
  const year = entry.year ? ` (${entry.year})` : '';
  return `${medium} ${entry.series}${year}`;
}

// The full community-tested insert form:
// "Buffy Summers as played by Sarah Michelle Gellar from the television series
//  Buffy the Vampire Slayer (1997)".
export function characterPromptText(entry) {
  if (!entry) return '';
  const base = entry.prompt || entry.name;
  const played = entry.actor ? `${base} as played by ${entry.actor}` : base;
  return `${played} from ${characterOriginText(entry)}`;
}

// How a known character SOUNDS. H3 knows a character's voice the same way it
// knows their face, and it is invoked inside the dialogue LANGUAGE tag rather
// than through a cloned reference clip:
//
//   <d>[English in Willow's voice from Buffy the Vampire Slayer as played by
//   Alyson Hannigan] …</d>
//
// The source here is the bare series — what the community form uses — not the
// "the television series X (1997)" clause that identifies a likeness.
//
// The SOURCE and the PERFORMER are the two halves that make a voice
// retrievable, so both are always named when known. An earlier version of this
// collapsed to "their own voice" when the character shared its title with the
// series, to avoid reading as a mistake — and rendered SpongeBob in a voice
// that was not his (2026-08-12), because "SpongeBob SquarePants' own voice"
// asks for nothing the model can look up. Repetition beats a content-free tag.
//
// `voiceActor` is separate from `actor` on purpose: for a live-action likeness
// the on-screen performer IS the voice, but for animation the person who
// identifies the sound never appears, and naming the wrong one is worse than
// naming none.
export function characterVoiceText(entry) {
  if (!entry) return '';
  const base = entry.prompt || entry.name;
  const owner = `${base}${/s$/i.test(base) ? "'" : "'s"}`;
  const performer = entry.voiceActor
    ? ` as voiced by ${entry.voiceActor}`
    : (entry.actor ? ` as played by ${entry.actor}` : '');
  return entry.series
    ? `${owner} voice from ${entry.series}${performer}`
    : `${owner} voice${performer}`;
}

// Name + series substring match; empty query returns the whole catalog.
//
// The `prompt` override is searched too, because it is the fuller name and
// therefore the one a person is likely to type: the row displays "Amicia" and
// "Leon Kennedy", but "Amicia de Rune", "Leon S. Kennedy", "Knuckles the
// Echidna" and "the T-800 Terminator" are what they are actually called.
export function searchH3Characters(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return H3_CHARACTERS;
  return H3_CHARACTERS.filter((entry) => (
    entry.name.toLowerCase().includes(q)
    || entry.series.toLowerCase().includes(q)
    || (entry.prompt || '').toLowerCase().includes(q)
  ));
}

// Group for display, preserving catalog order of both series and characters.
export function groupH3Characters(list = H3_CHARACTERS) {
  const groups = [];
  const bySeries = new Map();
  for (const entry of list) {
    let group = bySeries.get(entry.series);
    if (!group) {
      group = { series: entry.series, characters: [] };
      bySeries.set(entry.series, group);
      groups.push(group);
    }
    group.characters.push(entry);
  }
  return groups;
}

const escapeRegExp = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Characters are plain prompt text (unlike the derived camera/restyle phrases).
// Four cases, in order:
//  1. the full phrase is already present → unchanged (re-picking never stacks);
//  2. the prompt already names the character (exact-case word match, so "Data"
//     enriches but "data center" does not) → the bare name is enriched in place;
//  3. the prompt is one of H3's six-section prompts → the character is defined
//     as a subject of its own, numbered after the ones already there, with its
//     VOICE named beside its likeness. A six-section prompt has no tail to
//     append to: the end of the text is the inside of non_diegetic_music, and a
//     character filed under the music is a character the model never renders.
//     The voice belongs there because "as played by X" in an identity line is
//     about how a character LOOKS — nothing in it asks for that person's voice,
//     and a subject whose voice goes unnamed is voiced by H3's generic adult
//     male the moment somebody writes it a line. No speaker id is assigned:
//     H3 numbers speakers by who talks first and this character has no line
//     yet, so guessing one is how two characters' lines get swapped;
//  4. otherwise the full phrase is appended with a separator.
export function applyCharacterToPrompt(prompt, entry) {
  const text = characterPromptText(entry);
  const original = String(prompt || '');
  if (!text) return original;
  const base = original.trim();
  if (!base) return text;
  if (base.toLowerCase().includes(text.toLowerCase())) return original;
  const bareName = new RegExp(`\\b${escapeRegExp(entry.name)}\\b`);
  if (bareName.test(base)) return base.replace(bareName, text);
  if (isSixSectionPrompt(base)) {
    const sections = parseSixSections(base);
    const defined = String(sections.subject_definitions || '').trim();
    const taken = [...defined.matchAll(/<Subject (\d+)>/g)].map((hit) => Number(hit[1]));
    const next = (taken.length ? Math.max(...taken) : 0) + 1;
    const lines = characterSubjectLines({
      subject: `<Subject ${next}>`,
      sourceForm: text,
      voice: characterVoiceText(entry),
      voiceQuality: entry.voiceQuality || '',
      unbilled: true,
    });
    return formatSixSections({
      ...sections,
      subject_definitions: [defined, ...lines].filter(Boolean).join('\n'),
    });
  }
  const separator = /[.!?,;:]$/.test(base) ? ' ' : ', ';
  return `${base}${separator}${text}`;
}

// Words too generic to identify a character on their own; full names still match.
const GENERIC_TOKENS = new Set([
  'the', 'and', 'from', 'princess', 'captain', 'commander', 'counselor',
  'doctor', 'agent', 'sailor', 'american', 'white', 'green', 'black', 'star',
  'moon', 'snow', 'widow', 'america', 'iron', 'wonder', 'shadow',
]);

// Catalog entries the text plausibly refers to, full-name matches first.
// Loose on purpose: these become CONTEXT for the prompt helper, which is told
// to expand only the characters the idea actually mentions — so a spurious
// token hit costs a few prompt bytes, while a miss loses the enrichment.
export function charactersMentionedIn(text) {
  const haystack = ` ${String(text || '').toLowerCase()} `;
  if (!haystack.trim()) return [];
  const contains = (needle) => new RegExp(`(^|\\W)${escapeRegExp(needle.toLowerCase())}(\\W|$)`).test(haystack);
  const byFullName = [];
  const byToken = [];
  for (const entry of H3_CHARACTERS) {
    if (contains(entry.name)) {
      byFullName.push(entry);
      continue;
    }
    const tokens = entry.name.split(/[^\p{L}\p{N}']+/u)
      .filter((token) => token.length >= 4 && !GENERIC_TOKENS.has(token.toLowerCase()));
    if (tokens.some(contains)) byToken.push(entry);
  }
  return [...byFullName, ...byToken].slice(0, 12);
}

// One line per matched character, for injection into the helper's instruction.
export function characterNoteLines(entries) {
  return (entries || []).map((entry) => {
    const played = entry.actor ? ` — played by ${entry.actor}` : '';
    return `${entry.name}${played} — from ${characterOriginText(entry)}`;
  });
}
