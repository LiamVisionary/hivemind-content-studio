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
    const probe = spawnSync(python, ['-c', 'import cryptography, PIL'], { stdio: 'ignore' });
    return probe.status === 0;
}

const usable = candidates.find((python) => (python === 'python3' || existsSync(python)) && canImportDependencies(python));

if (!usable) {
    console.error(
        'No Python interpreter here can import the gateway test dependencies (cryptography, pillow).\n'
        + `Tried: ${candidates.join(', ')}\n`
        + `Fix: create the repository venv (uv sync) at ${join(repoRoot, '.venv')}, `
        + 'or point MEDIA_GATEWAY_PYTHON at an interpreter that has them.',
    );
    process.exit(1);
}

console.log(`media-gateway tests · interpreter: ${usable}`);
const result = spawnSync(usable, ['-m', 'unittest', 'test_app.py'], { cwd: gateway, stdio: 'inherit' });
process.exit(result.status ?? 1);
