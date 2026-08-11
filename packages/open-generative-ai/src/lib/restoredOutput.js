// Adopting an EXISTING output into a studio session ("Load in Studio" from the
// durable History view).
//
// The studios' own result strips are session-only on purpose: a persisted strip
// would put prompts and output URLs in plaintext localStorage, which the studio
// build deliberately scrubs (see hivemindStudio.js). History — owner-gated and
// sealed at rest — is therefore the durable record, and this is the bridge back:
// the clip returns to the canvas and the strip so the actions that live on a
// result (Continue scene, Smooth, Compare, Download) work on it again.
//
// Lives in src/lib rather than in the studio component so the node:test suite
// can import it — that suite cannot load JSX, which is exactly why rules kept
// inside the components were the ones no test caught.

/**
 * The history entry a restored output should add to the session strip, or null
 * when there is nothing to add (no clip handed over, or it is already there).
 *
 * `session` is the studio's current state: { history, modelId, aspectRatio,
 * duration }. The model is the one just restored ALONGSIDE the clip — Continue
 * scene resolves the chain-capable workflow from it, so a stale id would leave
 * the button hidden on a clip that can in fact be continued.
 */
export function restoredHistoryEntry(output, context, session = {}) {
    const url = String(output?.url || '').trim();
    if (!url) return null;
    const history = Array.isArray(session.history) ? session.history : [];
    if (history.some((entry) => entry?.url === url)) return null;
    return {
        id: output.id || `restored-${Date.now()}`,
        url,
        // Lineage, recovered from the setup this clip was generated with: the
        // shot it continued is exactly the clip that was armed as its motion
        // context. Without this a chained clip loaded back from History looks
        // unchained, so its episode cannot be rebuilt or even shown.
        ...(context?.motionContextUrl ? {
            chainFromUrl: context.motionContextUrl,
            chainShot: Number(context.motionContextIndex) > 0 ? Number(context.motionContextIndex) + 1 : 2,
        } : {}),
        // Other spellings of THIS output, so a later shot whose lineage points
        // at the URL it had when it was generated still resolves to this entry.
        ...(Array.isArray(output.aliasUrls) && output.aliasUrls.length
            ? { aliasUrls: output.aliasUrls.filter(Boolean) }
            : {}),
        // Redaction still applies downstream (private models never keep a
        // prompt in the strip); passing it keeps cloud entries labelled as they
        // were when generated.
        prompt: context?.prompt || '',
        model: session.modelId || null,
        aspect_ratio: session.aspectRatio || null,
        duration: session.duration || null,
        timestamp: output.timestamp || new Date().toISOString(),
        // Marks the tile as adopted rather than generated this session, so
        // nothing downstream mistakes it for a fresh render.
        restored: true,
    };
}
