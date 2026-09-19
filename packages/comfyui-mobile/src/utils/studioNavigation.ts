// Ask the studio shell to change pages, instead of opening a second tab.
//
// The Canvas editor runs inside the studio as an iframe, and its "Models &
// LoRAs" buttons used to `window.open` an external LoRA manager UI. That made a
// third door to "install a model" — a whole other app, with its own theme and
// its own idea of what is installed — beside the studio's Models page. The
// shell already listens for owner messages from this frame, so the buttons now
// ask it to open its own Models page.
//
// Standalone (not embedded, or a parent that is not the studio) still gets the
// external UI: this file is about the embedded case, not about removing the
// only door a standalone build has.

const NAVIGATE_MESSAGE = 'hivemind-navigate';

function parentOrigin(): string {
  try {
    return document.referrer ? new URL(document.referrer).origin : '*';
  } catch {
    return '*';
  }
}

export function isEmbeddedInStudio(): boolean {
  return typeof window !== 'undefined' && window.parent !== window;
}

/**
 * Ask the studio shell for one of its pages. Returns false when there is no
 * shell to ask, so the caller can fall back to whatever it did before.
 */
export function requestStudioPage(page: string): boolean {
  if (!isEmbeddedInStudio()) return false;
  try {
    window.parent.postMessage({ type: NAVIGATE_MESSAGE, page }, parentOrigin());
    return true;
  } catch {
    return false;
  }
}
