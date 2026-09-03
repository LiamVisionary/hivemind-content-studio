#!/usr/bin/env node
// Run the gateway's Python tests on an interpreter that has the gateway's
// dependencies.
//
// `python3 -m unittest` resolved to whatever system Python happened to be on
// PATH, which on a normal developer machine has no `cryptography` — so the four
// dual-seal tests (the ones covering how sealed media is unwrapped) errored on
// import while the suite still reported "216 tests, 4 errors" and npm exited
// non-zero for a reason nobody read. The repository venv is the interpreter
// these tests were written against; prefer it, and say so plainly when neither
// candidate can import what the suite needs.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const gateway = resolve(here, '..');
const repoRoot = resolve(gateway, '..', '..');

const candidates = [
    process.env.MEDIA_GATEWAY_PYTHON,
    join(repoRoot, '.venv', 'bin', 'python'),
    'python3',
].filter(Boolean);

function canImportDependencies(python) {
    // pytest joins the list because this runner collects every test_*.py here,
    // and `unittest` names only the one file it is handed.
    const probe = spawnSync(python, ['-c', 'import cryptography, PIL, pytest'], { stdio: 'ignore' });
    return probe.status === 0;
}

const usable = candidates.find((python) => (python === 'python3' || existsSync(python)) && canImportDependencies(python));

if (!usable) {
    console.error(
        'No Python interpreter here can import the gateway test dependencies (cryptography, pillow, pytest).\n'
        + `Tried: ${candidates.join(', ')}\n`
        + `Fix: create the repository venv (uv sync) at ${join(repoRoot, '.venv')}, `
        + 'or point MEDIA_GATEWAY_PYTHON at an interpreter that has them.',
    );
    process.exit(1);
}

console.log(`media-gateway tests · interpreter: ${usable}`);
// Every test_*.py in this directory, not just test_app.py: the suite grew
// test_e2e_media, test_episode, test_smart_mask and nine more, and naming one
// file meant `npm test` reported green while twelve suites never ran. `vendor`
// is excluded by norecursedirs in the repository's pyproject.
const result = spawnSync(usable, ['-m', 'pytest', '-q', '.'], { cwd: gateway, stdio: 'inherit' });
process.exit(result.status ?? 1);
