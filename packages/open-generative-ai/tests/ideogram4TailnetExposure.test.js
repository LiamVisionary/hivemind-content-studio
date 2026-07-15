const test = require('node:test');
const assert = require('node:assert/strict');

process.env.IDEOGRAM4_MLX_EXPOSURE = 'tailnet';
process.env.IDEOGRAM4_MLX_TAILNET_HOST = '100.64.0.42';
process.env.IDEOGRAM4_MLX_TOKEN = 'test-token';

delete require.cache[require.resolve('../electron/lib/ideogram4Provider')];
const {
    buildSidecarHeaders,
    buildSidecarUrl,
    isAllowedSidecarUrl,
    status,
} = require('../electron/lib/ideogram4Provider');

test('tailnet exposure uses a Tailscale host instead of loopback', () => {
    assert.equal(buildSidecarUrl('/v1/health'), 'http://100.64.0.42:8807/v1/health');
    assert.equal(isAllowedSidecarUrl('http://100.64.0.42:8807/v1/health'), true);
    assert.equal(isAllowedSidecarUrl('http://127.0.0.1:8807/v1/health'), false);
    assert.equal(isAllowedSidecarUrl('http://192.168.1.10:8807/v1/health'), false);
});

test('tailnet exposure sends bearer auth to the sidecar', () => {
    assert.deepEqual(buildSidecarHeaders(), { Authorization: 'Bearer test-token' });
    assert.equal(status().mlx.exposure, 'tailnet');
    assert.equal(status().mlx.requiresAuth, true);
});
