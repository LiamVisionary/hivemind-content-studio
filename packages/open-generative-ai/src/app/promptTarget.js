// Prompt insertion bridge — the active studio registers its inserter; the explore
// dock (and hub postMessage handlers) insert through it. Falls back to the legacy
// DOM probe so behavior matches hivemindStudio.js insertIntoPrompt exactly when no
// React studio has registered.
let activeInserter = null;

export function registerPromptInserter(fn) {
  activeInserter = fn;
  return () => {
    if (activeInserter === fn) activeInserter = null;
  };
}

// Full-setup loader bridge (distinct from the append inserter above). Used by
// "Load in Studio" to restore an entire recovered setup (prompt, negative, seed,
// steps, cfg, dims, model, …) into a specific studio. If that studio isn't the
// active/registered one yet (studios stay mounted-hidden and register on
// activate), the request is queued and drained when it registers.
let activeSetupLoader = null; // { section, fn }
let pendingSetup = null; // { section, setup }

export function registerStudioSetupLoader(section, fn) {
  activeSetupLoader = { section, fn };
  if (pendingSetup && pendingSetup.section === section) {
    const { setup } = pendingSetup;
    pendingSetup = null;
    fn(setup);
  }
  return () => {
    if (activeSetupLoader && activeSetupLoader.fn === fn) activeSetupLoader = null;
  };
}

export function loadStudioSetup(section, setup) {
  if (activeSetupLoader && activeSetupLoader.section === section) {
    activeSetupLoader.fn(setup);
    pendingSetup = null;
  } else {
    pendingSetup = { section, setup };
  }
}

export function insertIntoActivePrompt(text) {
  if (!text) return false;
  if (activeInserter) {
    activeInserter(text);
    return true;
  }
  // Legacy fallback: same probing order as hivemindStudio.js:405-417.
  let target = document.activeElement;
  if (!target || target.tagName !== 'TEXTAREA') {
    target = document.querySelector('#content-area textarea:not([disabled])') || document.querySelector('textarea');
  }
  if (!target) return false;
  const needsNewline = target.value && !target.value.endsWith('\n');
  target.value = `${target.value}${needsNewline ? '\n' : ''}${text}`;
  target.dispatchEvent(new Event('input', { bubbles: true }));
  target.focus();
  try {
    target.selectionStart = target.selectionEnd = target.value.length;
  } catch { /* non-critical */ }
  return true;
}
