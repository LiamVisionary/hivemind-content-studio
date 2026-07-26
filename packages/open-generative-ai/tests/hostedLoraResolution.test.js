const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const hostedServer = fs.readFileSync(path.join(__dirname, '../hosted-server.js'), 'utf8');
const videoStudio = fs.readFileSync(path.join(__dirname, '../src/studios/VideoStudio.jsx'), 'utf8');
const shim = fs.readFileSync(path.join(__dirname, '../public/hosted-local-ai.js'), 'utf8');

// Video workflows are defined in the Media Studio MCP registry, which this bridge
// cannot read. Mirroring their ids here is what silently broke LoRAs for every
// workflow added after the copy was written — so the ids must not come back.
test('the hosted bridge does not keep a hand-written list of video workflow ids', () => {
    assert.doesNotMatch(hostedServer, /BUILT_IN_VIDEO_WORKFLOWS/);
    assert.doesNotMatch(hostedServer, /ltx23-eros-(fast|exact|dmd)/);
});

test('LoRA resolution accepts base models from the caller and sanitises them', () => {
    assert.match(hostedServer, /baseModelsFromQuery/);
    assert.match(hostedServer, /query\.get\('baseModels'\)/);
    // Only word chars, spaces, dots, plus and dashes survive — no paths, no markup.
    assert.match(hostedServer, /\^\[\\w \.\+-\]\+\$/);
    assert.match(hostedServer, /\.slice\(0, 8\)/);
});

test('the video studio forwards the catalog base models it already has', () => {
    assert.match(videoStudio, /listLoras\(model\.workflowId, model\.compatibleBaseModels\)/);
    assert.match(shim, /baseModels=\$\{encodeURIComponent\(list\.join\(','\)\)\}/);
});
