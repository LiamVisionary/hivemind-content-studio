/**
 * Single source of truth for the "return to a past generation's exact setup" feature,
 * shared by the Image and Video studios.
 *
 * It owns the in-memory `output URL → captured context` store and the "currently viewed"
 * context. Each studio supplies its own capture()/restore() logic because the two modalities
 * expose different parameters, but both wire that data through this identical bookkeeping:
 *   - remember(url, context)  when a generation completes,
 *   - view(url)               when a history thumbnail is clicked,
 *   - getViewed()             when "Back to setup" / "Regenerate" restores the setup.
 *
 * Contexts are intentionally kept in memory only (never persisted). A context holds the raw
 * prompt, which is redacted before history is written to localStorage for private models, so
 * persisting it would leak that prompt. This also matches the session-scoped behaviour both
 * studios shipped with.
 */
export function createGenerationContextStore() {
    const byUrl = new Map(); // output URL → captured context
    let viewed = null;       // context backing the result currently shown in the canvas

    const recall = (url) => (url && byUrl.has(url) ? byUrl.get(url) : null);

    return {
        /** Associate a captured context with the output URL it produced. */
        remember(url, context) {
            if (url && context) byUrl.set(url, context);
            return context || null;
        },
        /** Look up the context captured for a given output URL, or null. */
        recall,
        /**
         * Mark a context as the one on screen. Accepts a context object directly, or an
         * output URL to look one up. Returns the resolved context (or null).
         */
        view(contextOrUrl) {
            viewed = typeof contextOrUrl === 'string' ? recall(contextOrUrl) : (contextOrUrl || null);
            return viewed;
        },
        /** The context backing the result currently shown, or null. */
        getViewed: () => viewed,
        /** Forget the viewed context (e.g. when returning to a blank prompt bar). */
        clearViewed() { viewed = null; },
    };
}
