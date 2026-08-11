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
// Ron Weasley and Xander (thread says they fail) and Overwatch characters
// (style works, names don't).

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
  { name: 'Sonic the Hedgehog', series: 'Sonic the Hedgehog', medium: 'game', year: 1991 },
  { name: 'Knuckles', series: 'Sonic the Hedgehog', prompt: 'Knuckles the Echidna', medium: 'game', year: 1994 },
  { name: 'Tails', series: 'Sonic the Hedgehog', medium: 'game', year: 1992 },
  { name: 'Shadow the Hedgehog', series: 'Sonic the Hedgehog', medium: 'game', year: 2001 },
  { name: 'Mario', series: 'Super Mario', medium: 'game', year: 1985 },
  { name: 'Luigi', series: 'Super Mario', medium: 'game', year: 1985 },
  { name: 'Princess Peach', series: 'Super Mario', medium: 'game', year: 1985 },
  { name: 'Bowser', series: 'Super Mario', medium: 'game', year: 1985 },
  { name: 'Link', series: 'The Legend of Zelda', medium: 'game', year: 1986 },
  { name: 'Princess Zelda', series: 'The Legend of Zelda', medium: 'game', year: 1986 },
  { name: 'Ganondorf', series: 'The Legend of Zelda', medium: 'game', year: 1998 },
  { name: 'Leon Kennedy', series: 'Resident Evil', medium: 'game', year: 1998 },
  { name: 'Claire Redfield', series: 'Resident Evil', medium: 'game', year: 1998 },
  { name: 'Jill Valentine', series: 'Resident Evil', medium: 'game', year: 1996 },
  { name: 'Ada Wong', series: 'Resident Evil', medium: 'game', year: 1998 },
  { name: 'Arthur Morgan', series: 'Red Dead Redemption', medium: 'game', year: 2018 },
  { name: 'Solid Snake', series: 'Metal Gear Solid', medium: 'game', year: 1998 },
  { name: 'Cloud Strife', series: 'Final Fantasy VII', medium: 'game', year: 1997 },
  { name: 'Tifa Lockhart', series: 'Final Fantasy VII', medium: 'game', year: 1997 },
  { name: 'Aerith Gainsborough', series: 'Final Fantasy VII', medium: 'game', year: 1997 },
  { name: 'Yuffie Kisaragi', series: 'Final Fantasy VII', medium: 'game', year: 1997 },
  { name: 'Sephiroth', series: 'Final Fantasy VII', medium: 'game', year: 1997 },
  { name: 'Johnny Silverhand', series: 'Cyberpunk 2077', medium: 'game', year: 2020, actor: 'Keanu Reeves', hint: 'Needs some extra prompting' },
  { name: 'Samus Aran', series: 'Metroid', medium: 'game', year: 1986, hint: 'Confirmed in the power suit' },
  { name: '2B', series: 'NieR: Automata', medium: 'game', year: 2017 },
  { name: 'Nathan Drake', series: 'Uncharted', medium: 'game', year: 2007 },
  { name: 'Chloe Frazer', series: 'Uncharted', medium: 'game', year: 2009 },
  { name: 'Nadine Ross', series: 'Uncharted', medium: 'game', year: 2016 },
  { name: 'Geralt of Rivia', series: 'The Witcher', medium: 'game', year: 2015 },
  { name: 'Commander Shepard', series: 'Mass Effect', medium: 'game', year: 2007, hint: 'Both default Shepards work' },
  { name: "Tali'Zorah", series: 'Mass Effect', medium: 'game', year: 2007 },
  { name: 'Garrus Vakarian', series: 'Mass Effect', medium: 'game', year: 2007 },
  { name: "Liara T'Soni", series: 'Mass Effect', medium: 'game', year: 2007 },
  { name: 'Shadowheart', series: "Baldur's Gate 3", medium: 'game', year: 2023 },
  { name: 'Astarion', series: "Baldur's Gate 3", medium: 'game', year: 2023 },
  { name: "Lae'zel", series: "Baldur's Gate 3", medium: 'game', year: 2023 },
  { name: 'Kazuma Kiryu', series: 'Yakuza', medium: 'game', year: 2005 },
  { name: 'Goro Majima', series: 'Yakuza', medium: 'game', year: 2005 },
  { name: 'Ichiban Kasuga', series: 'Yakuza', medium: 'game', year: 2020 },
  { name: 'Joel', series: 'The Last of Us', medium: 'game', year: 2013 },
  { name: 'Ellie', series: 'The Last of Us', medium: 'game', year: 2013 },
  { name: 'Abby', series: 'The Last of Us', medium: 'game', year: 2020 },
  { name: 'Cal Kestis', series: 'Star Wars Jedi: Survivor', medium: 'game', year: 2019 },
  { name: 'Cere Junda', series: 'Star Wars Jedi: Survivor', medium: 'game', year: 2019 },
  { name: 'Bayonetta', series: 'Bayonetta', medium: 'game', year: 2009 },
  { name: 'Kassandra', series: "Assassin's Creed", origin: "the video game Assassin's Creed Odyssey (2018)" },
  { name: 'Master Chief', series: 'Halo', medium: 'game', year: 2001 },
  { name: 'Aloy', series: 'Horizon', medium: 'game', year: 2017 },
  { name: 'Doomguy', series: 'Doom', medium: 'game', year: 1993 },
  { name: 'Senua', series: 'Hellblade', medium: 'game', year: 2017 },
  { name: 'Amicia', series: 'A Plague Tale', medium: 'game', year: 2019 },
  { name: 'Sam Porter Bridges', series: 'Death Stranding', medium: 'game', year: 2019, actor: 'Norman Reedus' },
  { name: 'Amelie', series: 'Death Stranding', medium: 'game', year: 2019, actor: 'Lindsay Wagner' },
  { name: 'Peter Parker', series: "Marvel's Spider-Man", medium: 'game', year: 2018, hint: 'Game suit confirmed' },
  { name: 'Miles Morales', series: "Marvel's Spider-Man", medium: 'game', year: 2020, hint: 'Game suit confirmed' },
  { name: 'Kara', series: 'Detroit: Become Human', medium: 'game', year: 2018 },
  { name: 'Kratos', series: 'God of War', medium: 'game', year: 2018 },
  { name: 'Atreus', series: 'God of War', medium: 'game', year: 2018 },
  { name: 'Dani Rojas', series: 'Far Cry 6', medium: 'game', year: 2021 },
  { name: 'Jin Sakai', series: 'Ghost of Tsushima', medium: 'game', year: 2020 },
  { name: 'Yuna', series: 'Ghost of Tsushima', medium: 'game', year: 2020 },
  { name: 'Aether', series: 'Genshin Impact', medium: 'game', year: 2020 },
  { name: 'Paimon', series: 'Genshin Impact', medium: 'game', year: 2020 },
  { name: 'Dante', series: 'Devil May Cry', medium: 'game', year: 2001 },
  { name: 'Nero', series: 'Devil May Cry', medium: 'game', year: 2008 },

  // ---- Anime ----
  { name: 'Tanjiro Kamado', series: 'Demon Slayer', medium: 'anime', year: 2019 },
  { name: 'Nezuko Kamado', series: 'Demon Slayer', medium: 'anime', year: 2019 },
  { name: 'Shinobu Kocho', series: 'Demon Slayer', medium: 'anime', year: 2019 },
  { name: 'Naruto Uzumaki', series: 'Naruto', medium: 'anime', year: 2002 },
  { name: 'Sakura Haruno', series: 'Naruto', medium: 'anime', year: 2002 },
  { name: 'Sasuke Uchiha', series: 'Naruto', medium: 'anime', year: 2002, filled: true },
  { name: 'Kakashi Hatake', series: 'Naruto', medium: 'anime', year: 2002, filled: true },
  { name: 'Frieren', series: 'Frieren', origin: "the anime series Frieren: Beyond Journey's End (2023)", hint: 'May drift off-model without extra prompting' },
  { name: 'Goku', series: 'Dragon Ball', origin: 'the anime series Dragon Ball Z (1989)' },
  { name: 'Android 18', series: 'Dragon Ball', origin: 'the anime series Dragon Ball Z (1989)' },
  { name: 'Vegeta', series: 'Dragon Ball', origin: 'the anime series Dragon Ball Z (1989)', filled: true },
  { name: 'Eren Yeager', series: 'Attack on Titan', medium: 'anime', year: 2013 },
  { name: 'Sailor Moon', series: 'Sailor Moon', medium: 'anime', year: 1992, filled: true },
  { name: 'Monkey D. Luffy', series: 'One Piece', medium: 'anime', year: 1999, filled: true },
  { name: 'Roronoa Zoro', series: 'One Piece', medium: 'anime', year: 1999, filled: true },
  { name: 'Nami', series: 'One Piece', medium: 'anime', year: 1999, filled: true },
  { name: 'Pikachu', series: 'Pokémon', medium: 'anime', year: 1997, filled: true },
  { name: 'Ash Ketchum', series: 'Pokémon', medium: 'anime', year: 1997, filled: true },
  { name: 'Charizard', series: 'Pokémon', medium: 'anime', year: 1997, filled: true },
  { name: 'Aang', series: 'Avatar: The Last Airbender', medium: 'animation', year: 2005, filled: true },
  { name: 'Katara', series: 'Avatar: The Last Airbender', medium: 'animation', year: 2005, filled: true },
  { name: 'Zuko', series: 'Avatar: The Last Airbender', medium: 'animation', year: 2005, filled: true },
  { name: 'Toph Beifong', series: 'Avatar: The Last Airbender', medium: 'animation', year: 2005, filled: true },

  // ---- Live-action TV ----
  { name: 'Captain Picard', series: 'Star Trek: The Next Generation', prompt: 'Captain Jean-Luc Picard', medium: 'tv', year: 1987, actor: 'Patrick Stewart' },
  { name: 'Commander Riker', series: 'Star Trek: The Next Generation', prompt: 'Commander William Riker', medium: 'tv', year: 1987, actor: 'Jonathan Frakes' },
  { name: 'Deanna Troi', series: 'Star Trek: The Next Generation', prompt: 'Counselor Deanna Troi', medium: 'tv', year: 1987, actor: 'Marina Sirtis' },
  { name: 'Data', series: 'Star Trek: The Next Generation', medium: 'tv', year: 1987, actor: 'Brent Spiner' },
  { name: 'Jerry Seinfeld', series: 'Seinfeld', medium: 'tv', year: 1989 },
  { name: 'George Costanza', series: 'Seinfeld', medium: 'tv', year: 1989, actor: 'Jason Alexander' },
  { name: 'Elaine Benes', series: 'Seinfeld', medium: 'tv', year: 1989, actor: 'Julia Louis-Dreyfus' },
  { name: 'Cosmo Kramer', series: 'Seinfeld', medium: 'tv', year: 1989, actor: 'Michael Richards' },
  { name: 'Walter White', series: 'Breaking Bad', medium: 'tv', year: 2008, actor: 'Bryan Cranston' },
  { name: 'Jesse Pinkman', series: 'Breaking Bad', medium: 'tv', year: 2008, actor: 'Aaron Paul' },
  { name: 'Saul Goodman', series: 'Breaking Bad', medium: 'tv', year: 2008, actor: 'Bob Odenkirk' },
  { name: 'Buffy Summers', series: 'Buffy the Vampire Slayer', medium: 'tv', year: 1997, actor: 'Sarah Michelle Gellar' },
  { name: 'Willow Rosenberg', series: 'Buffy the Vampire Slayer', medium: 'tv', year: 1997, actor: 'Alyson Hannigan' },
  { name: 'Angel', series: 'Buffy the Vampire Slayer', medium: 'tv', year: 1997, actor: 'David Boreanaz' },
  { name: 'Malcolm Reynolds', series: 'Firefly', medium: 'tv', year: 2002, actor: 'Nathan Fillion' },
  { name: 'Fox Mulder', series: 'The X-Files', medium: 'tv', year: 1993, actor: 'David Duchovny', filled: true },
  { name: 'Dana Scully', series: 'The X-Files', medium: 'tv', year: 1993, actor: 'Gillian Anderson', filled: true },
  { name: 'The Tenth Doctor', series: 'Doctor Who', prompt: 'the Tenth Doctor', medium: 'tv', year: 2005, actor: 'David Tennant', filled: true },
  { name: 'Dalek', series: 'Doctor Who', prompt: 'a Dalek', medium: 'tv', year: 1963, filled: true },
  { name: 'Jon Snow', series: 'Game of Thrones', medium: 'tv', year: 2011, actor: 'Kit Harington', filled: true, hint: 'GoT reported hit-or-miss' },
  { name: 'Daenerys Targaryen', series: 'Game of Thrones', medium: 'tv', year: 2011, actor: 'Emilia Clarke', filled: true, hint: 'GoT reported hit-or-miss' },
  { name: 'Tyrion Lannister', series: 'Game of Thrones', medium: 'tv', year: 2011, actor: 'Peter Dinklage', filled: true, hint: 'GoT reported hit-or-miss' },
  { name: 'Arya Stark', series: 'Game of Thrones', medium: 'tv', year: 2011, actor: 'Maisie Williams', filled: true, hint: 'GoT reported hit-or-miss' },
  { name: 'Sheldon Cooper', series: 'The Big Bang Theory', medium: 'tv', year: 2007, actor: 'Jim Parsons', filled: true },
  { name: 'Leonard Hofstadter', series: 'The Big Bang Theory', medium: 'tv', year: 2007, actor: 'Johnny Galecki', filled: true },
  { name: 'Penny', series: 'The Big Bang Theory', medium: 'tv', year: 2007, actor: 'Kaley Cuoco', filled: true },
  { name: 'Malcolm', series: 'Malcolm in the Middle', medium: 'tv', year: 2000, actor: 'Frankie Muniz', filled: true },
  { name: 'Hal', series: 'Malcolm in the Middle', medium: 'tv', year: 2000, actor: 'Bryan Cranston', filled: true },
  { name: 'Michael Scott', series: 'The Office', medium: 'tv', year: 2005, actor: 'Steve Carell', filled: true },
  { name: 'Dwight Schrute', series: 'The Office', medium: 'tv', year: 2005, actor: 'Rainn Wilson', filled: true },
  { name: 'Jim Halpert', series: 'The Office', medium: 'tv', year: 2005, actor: 'John Krasinski', filled: true },
  { name: 'Pam Beesly', series: 'The Office', medium: 'tv', year: 2005, actor: 'Jenna Fischer', filled: true },
  { name: 'Rachel Green', series: 'Friends', medium: 'tv', year: 1994, actor: 'Jennifer Aniston', filled: true },
  { name: 'Ross Geller', series: 'Friends', medium: 'tv', year: 1994, actor: 'David Schwimmer', filled: true },
  { name: 'Monica Geller', series: 'Friends', medium: 'tv', year: 1994, actor: 'Courteney Cox', filled: true },
  { name: 'Chandler Bing', series: 'Friends', medium: 'tv', year: 1994, actor: 'Matthew Perry', filled: true },
  { name: 'Joey Tribbiani', series: 'Friends', medium: 'tv', year: 1994, actor: 'Matt LeBlanc', filled: true },
  { name: 'Phoebe Buffay', series: 'Friends', medium: 'tv', year: 1994, actor: 'Lisa Kudrow', filled: true },
  { name: 'Homelander', series: 'The Boys', medium: 'tv', year: 2019, actor: 'Antony Starr', filled: true },
  { name: 'Billy Butcher', series: 'The Boys', medium: 'tv', year: 2019, actor: 'Karl Urban', filled: true },

  // ---- Animated TV ----
  { name: 'Homer Simpson', series: 'The Simpsons', medium: 'animation', year: 1989 },
  { name: 'Marge Simpson', series: 'The Simpsons', medium: 'animation', year: 1989, filled: true },
  { name: 'Bart Simpson', series: 'The Simpsons', medium: 'animation', year: 1989, filled: true },
  { name: 'Lisa Simpson', series: 'The Simpsons', medium: 'animation', year: 1989, filled: true },
  { name: 'Rick Sanchez', series: 'Rick and Morty', medium: 'animation', year: 2013, filled: true },
  { name: 'Morty Smith', series: 'Rick and Morty', medium: 'animation', year: 2013, filled: true },
  { name: 'SpongeBob SquarePants', series: 'SpongeBob SquarePants', medium: 'animation', year: 1999, filled: true },
  { name: 'Patrick Star', series: 'SpongeBob SquarePants', medium: 'animation', year: 1999, filled: true },
  { name: 'Squidward Tentacles', series: 'SpongeBob SquarePants', medium: 'animation', year: 1999, filled: true },
  { name: 'Peter Griffin', series: 'Family Guy', medium: 'animation', year: 1999, filled: true },
  { name: 'Stewie Griffin', series: 'Family Guy', medium: 'animation', year: 1999, filled: true },
  { name: 'Brian Griffin', series: 'Family Guy', medium: 'animation', year: 1999, filled: true },
  { name: 'Eric Cartman', series: 'South Park', medium: 'animation', year: 1997, filled: true },
  { name: 'Stan Marsh', series: 'South Park', medium: 'animation', year: 1997, filled: true },
  { name: 'Kyle Broflovski', series: 'South Park', medium: 'animation', year: 1997, filled: true },
  { name: 'Kenny McCormick', series: 'South Park', medium: 'animation', year: 1997, filled: true },
  { name: 'Beavis', series: 'Beavis and Butt-Head', medium: 'animation', year: 1993, filled: true },
  { name: 'Butt-Head', series: 'Beavis and Butt-Head', medium: 'animation', year: 1993, filled: true },
  { name: 'Woody', series: 'Toy Story', medium: 'animated-film', year: 1995, filled: true },
  { name: 'Buzz Lightyear', series: 'Toy Story', medium: 'animated-film', year: 1995, filled: true },
  { name: 'Leonardo', series: 'Teenage Mutant Ninja Turtles', medium: 'animation', year: 1987, filled: true },
  { name: 'Raphael', series: 'Teenage Mutant Ninja Turtles', medium: 'animation', year: 1987, filled: true },
  { name: 'Donatello', series: 'Teenage Mutant Ninja Turtles', medium: 'animation', year: 1987, filled: true },
  { name: 'Michelangelo', series: 'Teenage Mutant Ninja Turtles', medium: 'animation', year: 1987, filled: true },
  { name: 'Mickey Mouse', series: 'Disney', origin: 'the classic Disney animated cartoons (1928)', filled: true },
  { name: 'Elsa', series: 'Disney', origin: 'the animated film Frozen (2013)', filled: true },

  // ---- Film ----
  { name: 'Shrek', series: 'Shrek', medium: 'animated-film', year: 2001 },
  { name: 'Patrick Bateman', series: 'American Psycho', medium: 'film', year: 2000, actor: 'Christian Bale' },
  { name: 'Jack Sparrow', series: 'Pirates of the Caribbean', medium: 'films', year: 2003, actor: 'Johnny Depp' },
  { name: 'Harry Potter', series: 'Harry Potter', medium: 'films', year: 2001, actor: 'Daniel Radcliffe' },
  { name: 'Hermione Granger', series: 'Harry Potter', medium: 'films', year: 2001, actor: 'Emma Watson' },
  { name: 'Dumbledore', series: 'Harry Potter', medium: 'films', year: 2001, actor: 'Michael Gambon' },
  { name: 'The Terminator', series: 'The Terminator', prompt: 'the T-800 Terminator', medium: 'film', year: 1984, actor: 'Arnold Schwarzenegger', filled: true },
  { name: 'Sarah Connor', series: 'The Terminator', medium: 'film', year: 1984, actor: 'Linda Hamilton', filled: true },
  { name: 'Darth Vader', series: 'Star Wars', medium: 'films', year: 1977, filled: true },
  { name: 'Luke Skywalker', series: 'Star Wars', medium: 'films', year: 1977, actor: 'Mark Hamill', filled: true },
  { name: 'Princess Leia', series: 'Star Wars', medium: 'films', year: 1977, actor: 'Carrie Fisher', filled: true },
  { name: 'Han Solo', series: 'Star Wars', medium: 'films', year: 1977, actor: 'Harrison Ford', filled: true },
  { name: 'Yoda', series: 'Star Wars', medium: 'films', year: 1977, filled: true },
  { name: 'Chewbacca', series: 'Star Wars', medium: 'films', year: 1977, filled: true },
  { name: 'Stormtrooper', series: 'Star Wars', prompt: 'a stormtrooper', medium: 'films', year: 1977, filled: true },
  { name: 'Deadpool', series: 'Marvel', origin: 'the superhero film Deadpool (2016)', actor: 'Ryan Reynolds' },
  { name: 'Wolverine', series: 'Marvel', origin: 'the X-Men films (2000)', actor: 'Hugh Jackman' },
  { name: 'Iron Man', series: 'Marvel', origin: 'the Marvel Avengers films (2008)', actor: 'Robert Downey Jr.', filled: true },
  { name: 'Captain America', series: 'Marvel', origin: 'the Marvel Avengers films (2011)', actor: 'Chris Evans', filled: true },
  { name: 'Thor', series: 'Marvel', origin: 'the Marvel Avengers films (2011)', actor: 'Chris Hemsworth', filled: true },
  { name: 'Hulk', series: 'Marvel', prompt: 'the Hulk', origin: 'the Marvel Avengers films (2012)', filled: true },
  { name: 'Black Widow', series: 'Marvel', origin: 'the Marvel Avengers films (2010)', actor: 'Scarlett Johansson', filled: true },
  { name: 'Batman', series: 'DC', origin: 'the DC comics (1939)', filled: true },
  { name: 'Superman', series: 'DC', origin: 'the DC comics (1938)', filled: true },
  { name: 'Wonder Woman', series: 'DC', origin: 'the DC comics (1941)', filled: true },
  { name: 'Joker', series: 'DC', prompt: 'the Joker', origin: 'the DC comics (1940)', filled: true },
  { name: 'Neo', series: 'The Matrix', medium: 'film', year: 1999, actor: 'Keanu Reeves', filled: true },
  { name: 'Trinity', series: 'The Matrix', medium: 'film', year: 1999, actor: 'Carrie-Anne Moss', filled: true },
  { name: 'Morpheus', series: 'The Matrix', medium: 'film', year: 1999, actor: 'Laurence Fishburne', filled: true },
  { name: 'Agent Smith', series: 'The Matrix', medium: 'film', year: 1999, actor: 'Hugo Weaving', filled: true },
  { name: 'Ellen Ripley', series: 'Alien', medium: 'film', year: 1979, actor: 'Sigourney Weaver', filled: true },
  { name: 'Xenomorph', series: 'Alien', prompt: 'the xenomorph', medium: 'film', year: 1979, filled: true },
  { name: 'RoboCop', series: 'RoboCop', medium: 'film', year: 1987, actor: 'Peter Weller' },
  { name: 'Hellboy', series: 'Hellboy', medium: 'film', year: 2004, actor: 'Ron Perlman' },
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

// Name + series substring match; empty query returns the whole catalog.
export function searchH3Characters(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return H3_CHARACTERS;
  return H3_CHARACTERS.filter((entry) => (
    entry.name.toLowerCase().includes(q) || entry.series.toLowerCase().includes(q)
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
// Three cases, in order:
//  1. the full phrase is already present → unchanged (re-picking never stacks);
//  2. the prompt already names the character (exact-case word match, so "Data"
//     enriches but "data center" does not) → the bare name is enriched in place;
//  3. otherwise the full phrase is appended with a separator.
export function applyCharacterToPrompt(prompt, entry) {
  const text = characterPromptText(entry);
  const original = String(prompt || '');
  if (!text) return original;
  const base = original.trim();
  if (!base) return text;
  if (base.toLowerCase().includes(text.toLowerCase())) return original;
  const bareName = new RegExp(`\\b${escapeRegExp(entry.name)}\\b`);
  if (bareName.test(base)) return base.replace(bareName, text);
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
