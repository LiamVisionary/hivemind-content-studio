// Import a PURE-LOGIC studio module that happens to carry a .jsx extension.
//
// src/studios/video/videoLogic.jsx contains zero JSX — it is the spec-listed set
// of pure helpers the Video Studio renders from. Node refuses it on the file
// extension alone (ERR_UNKNOWN_FILE_EXTENSION), not on its contents, so a load
// hook that hands the bytes back as ESM is enough to test the shipping logic
// instead of the retired vanilla copy it was extracted from.
//
// Deliberately narrow: it resolves a .js sibling first, so if the module is ever
// renamed to the extension its contents already deserve, this keeps working and
// the hook stops being used. Anything containing real JSX still fails to parse
// here, which is the correct outcome — that belongs in a browser-side test.
const fs = require('node:fs');
const path = require('node:path');
const { registerHooks } = require('node:module');
const { fileURLToPath, pathToFileURL } = require('node:url');

let hookRegistered = false;

function ensureJsxLoadHook() {
    if (hookRegistered) return;
    hookRegistered = true;
    registerHooks({
        load(url, context, nextLoad) {
            if (!url.startsWith('file:') || !url.endsWith('.jsx')) return nextLoad(url, context);
            return {
                format: 'module',
                shortCircuit: true,
                source: fs.readFileSync(fileURLToPath(url), 'utf8'),
            };
        },
    });
}

// `specifier` is relative to the tests/ directory, e.g. '../src/studios/video/videoLogic.jsx'.
async function loadStudioLogic(specifier) {
    const jsxPath = path.resolve(__dirname, '..', specifier);
    const jsPath = jsxPath.replace(/\.jsx$/, '.js');
    if (jsxPath.endsWith('.jsx') && fs.existsSync(jsPath)) return import(pathToFileURL(jsPath).href);
    ensureJsxLoadHook();
    return import(pathToFileURL(jsxPath).href);
}

module.exports = { loadStudioLogic };
