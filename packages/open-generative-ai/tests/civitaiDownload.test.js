const test = require('node:test');
const assert = require('node:assert/strict');

test('Civitai URL validation accepts supported HTTPS domains only', async () => {
    const { isCivitaiUrl } = await import('../src/lib/civitaiDownload.js');

    assert.equal(isCivitaiUrl('https://civitai.com/models/123?modelVersionId=456'), true);
    assert.equal(isCivitaiUrl('https://www.civitai.red/models/123'), true);
    assert.equal(isCivitaiUrl('http://civitai.com/models/123'), false);
    assert.equal(isCivitaiUrl('https://example.com/models/123'), false);
});

test('shared Civitai helper submits once and polls through success', async () => {
    const { downloadCivitaiLora } = await import('../src/lib/civitaiDownload.js');
    const updates = [];
    let pollCount = 0;
    const api = {
        startCivitaiDownload: async (url) => ({ id: 'job-1', status: 'queued', url }),
        getCivitaiDownloadJob: async () => {
            pollCount += 1;
            return pollCount === 1
                ? { id: 'job-1', status: 'running', percent: 50 }
                : { id: 'job-1', status: 'success', percent: 100, result: { filename: 'look.safetensors' } };
        },
    };

    const job = await downloadCivitaiLora(api, 'https://civitai.red/models/123', {
        pollInterval: 0,
        onUpdate: update => updates.push(update.status),
    });

    assert.equal(job.result.filename, 'look.safetensors');
    assert.deepEqual(updates, ['queued', 'running', 'success']);
});
