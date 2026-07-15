const test = require('node:test');
const assert = require('node:assert/strict');

const {
    buildLoopbackSidecarUrl,
    isLoopbackSidecarUrl,
    resolveRuntimeMode,
} = require('../electron/lib/ideogram4Provider');

test('resolveRuntimeMode defaults Ideogram 4 to one-off generation', () => {
    assert.equal(resolveRuntimeMode({}), 'one-off');
});

test('resolveRuntimeMode accepts persistent requests when MLX is requested', () => {
    assert.equal(resolveRuntimeMode({ runtime_mode: 'persistent' }), 'persistent');
    assert.equal(resolveRuntimeMode({ persistent: true }), 'persistent');
});

test('persistent sidecar URL is loopback HTTP only by default', () => {
    const url = buildLoopbackSidecarUrl('/v1/health');
    assert.equal(url, 'http://127.0.0.1:8807/v1/health');
    assert.equal(isLoopbackSidecarUrl(url), true);
    assert.equal(isLoopbackSidecarUrl('http://localhost:8807/v1/health'), true);
    assert.equal(isLoopbackSidecarUrl('http://0.0.0.0:8807/v1/health'), false);
    assert.equal(isLoopbackSidecarUrl('http://192.168.1.10:8807/v1/health'), false);
    assert.equal(isLoopbackSidecarUrl('https://example.com/v1/health'), false);
});
