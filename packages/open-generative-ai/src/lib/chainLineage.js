// Chain lineage walker — separate from clipJoiner.js so the studio chunk
// does not carry mediabunny; the joiner itself is dynamically imported
// the moment a join actually runs.

// A clip can be known by more than one URL: the one it had when it was
// generated, and `/api/canvas/history/<id>/media` when the same output is
// loaded back from the durable History view. Lineage is recorded against the
// URL that was armed at generation time, so a restored clip carries the other
// spelling in `aliasUrls` — without that, an episode reassembled after a
// reload looks like a set of unrelated clips.
function findClipByUrl(history, url) {
  if (!url) return null;
  return (history || []).find((entry) => entry?.url === url
    || (Array.isArray(entry?.aliasUrls) && entry.aliasUrls.includes(url))) || null;
}

// The clip list for a chained entry, oldest shot first, walked through the
// chainFromUrl links recorded at generation time. Entries without links (or
// chains whose earlier shots left the 30-entry history) return what remains.
export function collectChainClips(entry, history) {
  const chain = [];
  let current = entry;
  const seen = new Set();
  while (current && current.url && !seen.has(current.url)) {
    seen.add(current.url);
    chain.unshift(current);
    current = current.chainFromUrl ? findClipByUrl(history, current.chainFromUrl) : null;
  }
  return chain;
}

/**
 * The URL of an earlier shot this chain refers to but which is not loaded in
 * this session, or null when the chain is complete.
 *
 * The studio's strip is session-only, so after a reload an episode's earlier
 * shots exist ONLY in the durable History view. Reporting the missing link is
 * what lets the studio go find it there instead of silently offering to join
 * half an episode.
 */
export function missingChainParent(entry, history) {
  const chain = collectChainClips(entry, history);
  const head = chain[0];
  if (!head?.chainFromUrl) return null;
  return findClipByUrl(history, head.chainFromUrl) ? null : head.chainFromUrl;
}
