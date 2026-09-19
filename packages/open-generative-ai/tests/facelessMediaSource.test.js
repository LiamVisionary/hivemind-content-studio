// Faceless media source — the seam that lets a narrated short draw its visuals
// from our own connected models instead of a stock library. The contract that
// matters here is what reaches /api/runs: a generated source must carry a route
// (provider + model), and a stock source must not.
const test = require('node:test');
const assert = require('node:assert/strict');

test('media sources are grouped, and only the generated ones carry a route', async () => {
    const { MEDIA_SOURCE_OPTIONS, mediaSourceKind, isGeneratedMediaSource } =
        await import('../src/hub/hubData.js');

    const byValue = Object.fromEntries(MEDIA_SOURCE_OPTIONS.map((option) => [option.value, option]));

    // Upstream's Coverr source arrived with the v1.3.4 engine merge; losing it
    // here would leave a working backend source unreachable from the studio.
    for (const value of ['pexels', 'pixabay', 'coverr', 'local', 'studio-image', 'studio-video']) {
        assert.ok(byValue[value], `${value} is offered`);
        assert.ok(byValue[value].label.trim(), `${value} is labelled`);
        assert.ok(byValue[value].group.trim(), `${value} is grouped`);
    }

    assert.equal(mediaSourceKind('studio-image'), 'image');
    assert.equal(mediaSourceKind('studio-video'), 'video');
    for (const stock of ['pexels', 'pixabay', 'coverr', 'local', '', undefined]) {
        assert.equal(mediaSourceKind(stock), '', `${stock} has no generation kind`);
        assert.equal(isGeneratedMediaSource(stock), false, `${stock} is not generated`);
    }
    assert.equal(isGeneratedMediaSource('studio-video'), true);
});

test('the generated route reaches the run payload, and stock sources stay routeless', async () => {
    const { draftPayload, hubState, setSelectedLane, setWorkflow, setMediaRoute, routeValue } =
        await import('../src/hub/hubData.js');

    // The lane list is loaded from the API at runtime; the advanced form only
    // needs selectedLane set for draftPayload to describe a faceless run.
    hubState.catalog = {
        lanes: [{
            id: 'faceless',
            default_aspect_ratio: '9:16',
            default_runtime_seconds: 30,
            supports: { scenes: false, voice: true, source: false, media_source: true },
        }],
    };
    setSelectedLane('faceless');
    setWorkflow({ title: 'Generated short', mediaSource: 'studio-video' });
    setMediaRoute(routeValue('comfyui', 'ltx23-eros-fast'));

    const generated = draftPayload();
    assert.equal(generated.faceless.media_source, 'studio-video');
    assert.deepEqual(generated.faceless.media_route, { provider: 'comfyui', model: 'ltx23-eros-fast' });

    // Switching back to a stock library must drop the route rather than leave a
    // stale model on the payload, which would imply a choice Pexels never makes.
    setWorkflow({ mediaSource: 'pexels' });
    const stock = draftPayload();
    assert.equal(stock.faceless.media_source, 'pexels');
    assert.equal('media_route' in stock.faceless, false);
});
