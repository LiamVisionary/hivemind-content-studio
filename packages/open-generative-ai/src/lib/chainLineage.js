// Chain lineage walker — separate from clipJoiner.js so the studio chunk
// does not carry mediabunny; the joiner itself is dynamically imported
// the moment a join actually runs.

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
    current = current.chainFromUrl
      ? (history || []).find((e) => e.url === current.chainFromUrl)
      : null;
  }
  return chain;
}
