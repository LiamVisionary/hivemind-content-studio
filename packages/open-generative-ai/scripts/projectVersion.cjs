// The product's version, read from the one file that owns it.
//
// `[project] version` in pyproject.toml is the product's version
// (docs/RELEASE.md §4). The four package.json files used to carry four unrelated
// numbers — 0.2.0, 2.0.0, 1.0.0, 3.0.2 — none of which named the product, and
// none of which agreed with what `/api/version` returned. They are gone, so
// everything on the JavaScript side that needs a version reads it from here:
// vite's `__APP_VERSION__` define, electron-builder, and the .deb packager.
//
// A regex rather than a TOML parser: this runs in build tooling that should not
// need a dependency to read one line, and a pyproject that has lost that line
// must fail loudly rather than produce an app stamped `undefined`.
const fs = require('node:fs');
const path = require('node:path');

const PYPROJECT = path.join(__dirname, '..', '..', '..', 'pyproject.toml');

function projectVersion() {
  const match = /^version\s*=\s*"([^"]+)"/m.exec(fs.readFileSync(PYPROJECT, 'utf8'));
  if (!match) throw new Error(`${PYPROJECT} has no [project] version`);
  return match[1];
}

module.exports = { projectVersion, PYPROJECT };
