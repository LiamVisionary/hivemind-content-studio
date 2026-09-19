// Subject stand-ins: how a prompt written about "a woman" becomes a prompt
// about whoever is actually in the shot.
//
// The weave (promptWeave.js / castPrompt.js) binds a cast to SUBJECT SLOTS —
// `<Subject 1>`, `<Subject 2>` — and a prompt that already addresses subjects
// by slot recasts exactly. But the starters, the prompt helper and anything
// typed describe people in PROSE: "A Korean woman in her early twenties (S1)
// sits on a low concrete wall … she has black wavy hair in a messy ponytail".
// Nothing in that text says which words are the person and which are the
// scene, so attaching a reference used to define `<Subject 1>` and leave the
// stranger fully described beside it (2026-08-23: the clip came back as the
// stranger).
//
// This module is the anchor. A template marks the stand-in with two tokens,
// written WITH their own surrounding spaces and punctuation (the same rule the
// gender segments in personaId.js follow), and both may nest gender tokens and
// segments inside:
//
//   {subject:A Korean {woman} in {her} early twenties}   who the stand-in is
//   {look:; {she} has {f:…}{m:…}, black canvas sneakers}  what the stand-in looks like
//
// Rendering resolves the gender grammar and returns the plain text the user
// sees, PLUS a record of the stand-in phrases as they were rendered. Binding
// later swaps each phrase for whatever the bound member is called in the
// target grammar (`<Subject 1>` in H3 reference mode, the character's source
// form in text mode, "the woman from the reference image" for a model with no
// subject grammar) and drops the look, because the bound member's own
// definition carries its look.
//
// `{subject2:…}` / `{look2:…}` address a second stand-in; the bare form is 1.
// Pure: no React, no storage.
import { renderGenderTokens } from './personaId.js';

const OPENERS = /\{(subject|look)(\d*):/g;

/** Index of the `}` closing the token whose body starts at `from`, or -1. */
function closingBrace(text, from) {
  let depth = 1;
  for (let at = from; at < text.length; at += 1) {
    const char = text[at];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return at;
    }
  }
  return -1;
}

/** The stand-in tokens in a template, in order, with their spans. */
export function subjectTokensIn(template) {
  const text = String(template || '');
  const tokens = [];
  OPENERS.lastIndex = 0;
  let match = OPENERS.exec(text);
  while (match) {
    const end = closingBrace(text, match.index + match[0].length);
    if (end === -1) break;
    tokens.push({
      kind: match[1],
      index: Math.max(1, Number(match[2]) || 1),
      start: match.index,
      end: end + 1,
      body: text.slice(match.index + match[0].length, end),
    });
    OPENERS.lastIndex = end + 1;
    match = OPENERS.exec(text);
  }
  return tokens;
}

/** True when the text still carries stand-in tokens (i.e. is a template, not prose). */
export function hasSubjectTokens(template) {
  return subjectTokensIn(template).length > 0;
}

/**
 * Render a template for one gender: stand-in tokens become their rendered
 * bodies, then the gender grammar resolves over the whole text.
 *
 * Returns the text and the stand-ins: one entry per subject index, carrying
 * every rendered phrase and look in the order they appear, so a starter that
 * names its stand-in twice ("A Korean woman…", later "the same Korean woman…")
 * records both. A template with no tokens renders to itself with no stand-ins.
 */
export function renderSubjectTemplate(template, { gender = '' } = {}) {
  const source = String(template || '');
  const tokens = subjectTokensIn(source);
  if (!tokens.length) return { text: renderGenderTokens(source, gender), standIns: [] };

  const byIndex = new Map();
  const at = (index) => {
    if (!byIndex.has(index)) byIndex.set(index, { index, phrases: [], looks: [] });
    return byIndex.get(index);
  };
  let out = '';
  let cursor = 0;
  for (const token of tokens) {
    out += source.slice(cursor, token.start);
    const rendered = renderGenderTokens(token.body, gender);
    out += rendered;
    cursor = token.end;
    const entry = at(token.index);
    if (token.kind === 'subject') entry.phrases.push(rendered);
    else entry.looks.push(rendered);
  }
  out += source.slice(cursor);
  return {
    text: renderGenderTokens(out, gender),
    standIns: [...byIndex.values()].sort((a, b) => a.index - b.index),
  };
}

const escapeRegExp = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Remove one occurrence of `piece` from `text`, leaving the surrounding punctuation tidy. */
function removeOnce(text, piece) {
  const at = text.indexOf(piece);
  if (at === -1) return { text, found: false };
  let next = text.slice(0, at) + text.slice(at + piece.length);
  // A look written as ", {f:…}" between two commas, or as " — … —", leaves a
  // doubled separator behind when it goes; collapse the common ones.
  next = next.replace(/,\s*,/g, ',').replace(/;\s*([.;,])/g, '$1').replace(/\s+([.,;:])/g, '$1').replace(/ {2,}/g, ' ');
  return { text: next, found: true };
}

/**
 * Bind stand-ins to whoever holds each subject slot.
 *
 * `replacementFor(index)` returns the text that names the bound member in the
 * target grammar, or null/'' to leave that stand-in as written. Every phrase
 * of a bound stand-in is replaced (first occurrence each, in order) and every
 * look is removed. A phrase the text no longer contains — the user edited the
 * words — is reported in `unmatched` and nothing else about that stand-in is
 * touched, so an edit never gets half-bound.
 *
 * Returns the new text, the stand-ins that were bound (consumed), and the
 * stand-ins that remain (unbound, or unmatched) for the caller to keep.
 */
export function bindStandIns(text, standIns = [], replacementFor = () => null) {
  let out = String(text || '');
  const bound = [];
  const remaining = [];
  const unmatched = [];
  for (const standIn of Array.isArray(standIns) ? standIns : []) {
    const replacement = String(replacementFor(standIn.index) || '');
    const phrases = Array.isArray(standIn.phrases) ? standIn.phrases : [];
    if (!replacement || !phrases.length) { remaining.push(standIn); continue; }
    // Every phrase must still be there before any is touched.
    if (!phrases.every((phrase) => out.includes(phrase))) {
      remaining.push(standIn);
      unmatched.push(standIn.index);
      continue;
    }
    let next = out;
    for (const phrase of phrases) {
      next = next.replace(new RegExp(escapeRegExp(phrase)), () => replacement);
    }
    for (const look of Array.isArray(standIn.looks) ? standIn.looks : []) {
      next = removeOnce(next, look).text;
    }
    out = next;
    bound.push(standIn.index);
  }
  return { text: out, bound, remaining, unmatched };
}

/**
 * Stand-ins that still describe the text: those whose every phrase is present.
 * Used before persisting, so a record never outlives the words it points at.
 */
export function liveStandIns(text, standIns = []) {
  const source = String(text || '');
  return (Array.isArray(standIns) ? standIns : [])
    .filter((standIn) => (standIn.phrases || []).length && standIn.phrases.every((phrase) => source.includes(phrase)));
}
