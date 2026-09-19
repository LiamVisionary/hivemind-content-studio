// The order's row is the answer to pressing Rent. On 2026-09-15 the click held
// a spinner on the button for the whole placement, then stopped over a machine
// list with no trace of the box that was already billing. Rendered, because the
// claim is about what a person sees; the logic behind it is rentalOrders.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderComponent, textOf } = require('./helpers/render.js');

const VIEW = 'src/hub/views/GpuMachinesView.jsx';

const order = (stage, extra = {}) => ({
    order_id: 'click-1', tier: 'minimaxeros', tier_label: 'Video · MiniMax H3 Eros (NSFW)', gpu_class: 'rtx5090',
    gpu_label: 'RTX 5090', count: 1, quoted_usd_per_hour: 0.8625, stage, started_at: 1000, finished_at: null,
    rental_ids: [], usd_per_hour: null, ...extra,
});

const barAt = (markup) => Number((markup.match(/role="progressbar"[^>]*aria-valuenow="(\d+)"/) || [])[1]);

test('the row pressing Rent draws is a progress bar from its first frame', async () => {
    const markup = await renderComponent(VIEW, 'OrderRow', { order: order('sending') });
    assert.ok(barAt(markup) > 0, 'a bar with something on it — not an empty track, not a spinner alone');
    const text = textOf(markup);
    assert.match(text, /Sending your order/);
    assert.match(text, /MiniMax H3 Eros \(NSFW\)/);
    assert.match(text, /RTX 5090/);
    assert.match(text, /\$0\.86\/hr/);
});

test('each stage moves the bar on, and the order hands over to the machine at the same place', async () => {
    const at = async (stage) => barAt(await renderComponent(VIEW, 'OrderRow', { order: order(stage) }));
    const stages = [await at('sending'), await at('searching'), await at('preparing'), await at('renting')];
    stages.slice(1).forEach((value, index) => assert.ok(value > stages[index], `stage ${index + 1} is ahead of stage ${index}`));
    const placed = await renderComponent(VIEW, 'OrderRow', { order: order('placed', { rental_ids: ['runpod:x'] }) });
    const booting = await renderComponent(VIEW, 'ProvisionProgress', { machine: { phase: 'booting', managed: true } });
    assert.ok(barAt(placed) > stages[3]);
    assert.equal(barAt(placed), barAt(booting), 'no jump backwards or forwards when the machine row takes over');
    assert.match(textOf(placed), /Starting the machine/);
    assert.match(textOf(booting), /Starting the machine/);
});

// Deliberately textual: a server render runs no click handler, and what this
// pins is the ORDER of two statements inside one — the draft row is committed
// before the POST is awaited — plus the payload shape that asks for an order.
// The row those statements produce is rendered above.
test('rent() draws the row before it waits on the request, and asks for an order', () => {
    const view = fs.readFileSync(path.join(__dirname, '..', VIEW), 'utf8');
    const start = view.indexOf('const rent = async (');
    assert.notEqual(start, -1, 'rent() was renamed — re-point this guard');
    const body = view.slice(start, view.indexOf('\n  };', start));
    assert.match(body, /background:\s*true/);
    const drawn = body.indexOf('setDrafts(');
    assert.ok(drawn > -1 && drawn < body.indexOf("await api('/api/gpu-rentals'"), 'the row is drawn before the POST is awaited');
    assert.doesNotMatch(body, /await refresh\(/, 'nothing between the click and the row may wait on a re-price');
    const panelStart = view.indexOf('function RentPanel(');
    const panel = view.slice(panelStart, view.indexOf('\n}\n', panelStart));
    assert.doesNotMatch(panel, /loading=\{busy\}/, 'the Rent button is not a spinner any more');
});
