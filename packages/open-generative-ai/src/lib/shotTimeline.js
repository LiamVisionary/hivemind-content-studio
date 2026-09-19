// Shot timestamps, refitted to the clip the user actually asked for.
//
// H3 prompts carry their own timeline: "[Shot 1]" opens at zero and every later
// shot is anchored "[Shot N] At MM:SS.mmm,". A shot stamped at or past the end
// of the clip is a beat that NEVER RENDERS — the model simply runs out of clip
// before reaching it, and the last thing the prompt describes is silently
// missing from the result.
//
// This kept happening because nothing enforced it. The system prompt states the
// length and asks the writer to keep the final shot inside it; small models
// overshoot anyway, and a STARTER cannot obey an instruction at all — the H3
// Korean-home-video starter is a fixed 15s script with shots at 00:00, 00:05 and
// 00:10, so choosing 10s (which is what the reference budget allows once a few
// pictures are attached) silently threw its third beat away. prompt_profiles
// has had a `timeline_overruns` detector the whole time; it was only ever called
// from tests.
//
// Refitting rather than dropping: the beats are what the user wants, and only
// their spacing was written for a longer clip. Three beats over 15s become
// three beats over 10s, each a little quicker — which is a pacing change the
// user can see and undo, where a dropped beat is content that vanished.

/** MM:SS.mmm — the anchor notation H3's guide uses for a point in the clip. */
export function timecode(seconds) {
  const ms = Math.max(0, Math.round((Number(seconds) || 0) * 1000));
  const pad = (value, width) => String(value).padStart(width, '0');
  return `${pad(Math.floor(ms / 60000), 2)}:${pad(Math.floor((ms % 60000) / 1000), 2)}.${pad(ms % 1000, 3)}`;
}

// "At 00:05.000" on a line that also carries a [Shot N] header. Scoped to shot
// lines on purpose: "the clock reads At 09:30" is prose, not a beat, and
// re-timing it would rewrite the scene. Mirrors _SHOT_LINE/_TIMESTAMP in
// prompt_profiles.py so both sides agree on what a shot anchor is.
const SHOT_LINE = /^.*\[Shot\s+\d+\].*$/gm;
const TIMESTAMP = /\bAt\s+(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?/g;

/** Every timestamped shot anchor: its offset in the prompt, text and seconds. */
export function shotStartTimes(prompt) {
  const found = [];
  const text = String(prompt || '');
  for (const line of text.matchAll(SHOT_LINE)) {
    for (const stamp of line[0].matchAll(TIMESTAMP)) {
      const [raw, minutes, secs, millis] = stamp;
      found.push({
        at: line.index + stamp.index,
        raw,
        seconds: Number(minutes) * 60 + Number(secs) + Number((millis || '0').padEnd(3, '0')) / 1000,
      });
    }
  }
  return found;
}

/** Shot starts that fall at or past the end of the clip. */
export function timelineOverruns(prompt, durationSeconds) {
  const duration = Number(durationSeconds);
  if (!(duration > 0)) return [];
  return shotStartTimes(prompt).filter((shot) => shot.seconds >= duration).map((shot) => shot.seconds);
}

/**
 * The span the prompt was WRITTEN for, inferred from its own beats.
 *
 * A script with shots at 0, 5 and 10 is a 15-second script: the last beat gets
 * a slice like the ones before it. Without that the last shot would be treated
 * as the end of the clip and refitting would leave it nothing to play.
 */
function writtenSpan(starts) {
  const seconds = starts.map((shot) => shot.seconds).sort((a, b) => a - b);
  const last = seconds[seconds.length - 1];
  if (seconds.length < 2) return last * 2 || 0;
  const gaps = seconds.slice(1).map((value, index) => value - seconds[index]).filter((gap) => gap > 0);
  const average = gaps.length ? gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length : 0;
  return last + (average || last);
}

/**
 * Rewrite a prompt's shot anchors to fit `durationSeconds`.
 *
 * Returns `{ prompt, changed, moved, from, to }` — `moved` lists
 * {before, after} for each anchor, so the studio can say what it did rather
 * than quietly editing the user's words.
 *
 * A prompt whose beats already fit is returned untouched: refitting a 5s script
 * onto a 15s clip would spread it out, and nobody asked for that. Only an
 * OVERRUN is repaired.
 */
export function fitShotTimeline(prompt, durationSeconds) {
  const text = String(prompt || '');
  const duration = Number(durationSeconds);
  const unchanged = { prompt: text, changed: false, moved: [], from: null, to: null };
  if (!(duration > 0) || !text) return unchanged;
  const starts = shotStartTimes(text);
  if (!starts.length) return unchanged;
  const last = Math.max(...starts.map((shot) => shot.seconds));
  if (last < duration) return unchanged;

  const span = writtenSpan(starts);
  if (!(span > 0)) return unchanged;
  const scale = duration / span;
  const moved = [];
  // Rebuilt back-to-front so each splice leaves earlier offsets valid.
  let out = text;
  for (const shot of [...starts].sort((a, b) => b.at - a.at)) {
    const after = Math.round(shot.seconds * scale * 1000) / 1000;
    moved.unshift({ before: shot.seconds, after });
    out = `${out.slice(0, shot.at)}At ${timecode(after)}${out.slice(shot.at + shot.raw.length)}`;
  }
  return { prompt: out, changed: true, moved, from: span, to: duration };
}
