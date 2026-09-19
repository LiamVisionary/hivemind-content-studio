// Deliberately textual: the bridge chain a download travels, end to end. Every
// link is a call site.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The bridge used to send expectedType: 'LORA', so pasting a checkpoint URL failed
// with "Expected a Civitai LoRA URL" even though the gateway files checkpoints in
// models/checkpoints perfectly well. It must forward the URL unqualified.
test('the hosted bridge does not restrict Civitai downloads to LoRAs', () => {
    const hostedServer = fs.readFileSync(path.join(__dirname, '../hosted-server.js'), 'utf8');
    assert.doesNotMatch(hostedServer, /expectedType:\s*['"]/); // the property, not the comment explaining its absence
});

test('the download job can be cancelled through the whole bridge chain', () => {
    const hostedServer = fs.readFileSync(path.join(__dirname, '../hosted-server.js'), 'utf8');
    const shim = fs.readFileSync(path.join(__dirname, '../public/hosted-local-ai.js'), 'utf8');
    const iframeBridge = fs.readFileSync(path.join(__dirname, '../src/lib/browserLocalAI.js'), 'utf8');
    const client = fs.readFileSync(path.join(__dirname, '../src/lib/localInferenceClient.js'), 'utf8');

    // DELETE on the job route in, POST to the gateway's cancel route out.
    assert.match(hostedServer, /civitai-download\/'\) && req\.method === 'DELETE'/);
    assert.match(hostedServer, /api\/civitai\/cancel-download\//);
    assert.match(shim, /cancelCivitaiDownload: \(jobId\)/);
    assert.match(iframeBridge, /cancelCivitaiDownload: \(jobId\) => call\('cancelCivitaiDownload', jobId\)/);
    assert.match(client, /async cancelCivitaiDownload\(jobId\)/);
});

test('a cancelled job is reported as cancelled, not as a download failure', async () => {
    const { downloadCivitaiLora } = await import('../src/lib/civitaiDownload.js');
    const api = {
        startCivitaiDownload: async () => ({ id: 'job-9', status: 'running' }),
        getCivitaiDownloadJob: async () => ({ id: 'job-9', status: 'cancelled', error: 'Download cancelled' }),
    };

    await assert.rejects(
        downloadCivitaiLora(api, 'https://civitai.com/models/123', { pollInterval: 0 }),
        err => err.cancelled === true && err.message === 'Download cancelled',
    );
});

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

test('the update check and update-and-replace reach the gateway through the bridge', () => {
    const hostedServer = fs.readFileSync(path.join(__dirname, '../hosted-server.js'), 'utf8');
    const shim = fs.readFileSync(path.join(__dirname, '../public/hosted-local-ai.js'), 'utf8');
    const client = fs.readFileSync(path.join(__dirname, '../src/lib/localInferenceClient.js'), 'utf8');

    // Update availability: sanitised base models in, gateway route out.
    assert.match(hostedServer, /'\/local-ai\/lora-updates'/);
    assert.match(hostedServer, /api\/civitai\/lora-updates/);
    assert.match(shim, /listLoraUpdates: \(baseModels\)/);
    assert.match(client, /async listLoraUpdates\(baseModels\)/);

    // replaceId is forwarded but never as a path: no traversal, no absolute path.
    assert.match(hostedServer, /replaceId\.includes\('\.\.'\) \|\| replaceId\.startsWith\('\/'\)/);
    assert.match(hostedServer, /replaceId \? \{ url, replaceId \} : \{ url \}/);
});
