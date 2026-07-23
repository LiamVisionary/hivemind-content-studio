const test = require('node:test');
const assert = require('node:assert/strict');

async function loadUploadHistory() {
    return import('../src/lib/uploadHistory.js');
}

test('upload history removes browser-only references that cannot survive reload', async () => {
    const { getUploadHistory } = await loadUploadHistory();
    const originalStorage = global.localStorage;
    const values = new Map();
    global.localStorage = {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, String(value)),
    };
    values.set('muapi_uploads', JSON.stringify([
        { id: 'blob', uploadedUrl: 'blob:https://studio.test/dead' },
        { id: 'data', uploadedUrl: 'data:image/png;base64,AAAA' },
        { id: 'private', uploadedUrl: '/api/media-studio/references/reference-a.png' },
        { id: 'remote', uploadedUrl: 'https://cdn.example/image.png' },
    ]));

    try {
        assert.deepEqual(getUploadHistory().map((entry) => entry.id), ['private', 'remote']);
        assert.deepEqual(
            JSON.parse(values.get('muapi_uploads')).map((entry) => entry.id),
            ['private', 'remote'],
        );
    } finally {
        global.localStorage = originalStorage;
    }
});
