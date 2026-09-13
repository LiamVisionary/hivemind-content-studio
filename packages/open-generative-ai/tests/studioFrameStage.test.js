// The stage must be bounded by the WINDOW, not by the picture in it.
//
// Reported 2026-09-11: a finished 1024x1024 local generation rendered enormous
// — as wide as the frame, running off the bottom of the window and under the
// composer. Measured in the browser at 1000x710: the padded stage container
// grew to 1135px inside its 672px parent, and the stage inside it came out
// 876x876 instead of 413x413.
//
// The mechanism is the classic grid blow-out. That container is a GRID ITEM, so
// its automatic minimum size is its CONTENT size, which overrides the `h-full`
// it is given. With its height no longer definite, the stage's own
// `max-h-full` resolved to `none` and `height: 100%` had nothing to resolve
// against, so the picture sized itself off the WIDTH instead. `min-h-0` is what
// makes the height definite again; setting it in the live page took the stage
// straight back to 413x413.
//
// It hid for as long as it did because the stage's <img> was broken (see
// mediaCacheBudget.test.js) — a broken image has no intrinsic size to grow the
// container with. Fixing the picture is what exposed the layout.
const test = require('node:test');
const assert = require('node:assert/strict');
const { renderComponent } = require('./helpers/render.js');

test('the stage container cannot be grown past the window by its own picture', async () => {
    const markup = await renderComponent('src/studios/frame/StudioFrame.jsx', 'StudioFrame', {
        stage: '<the picture>',
        composer: 'composer',
    });
    // The div that reserves room for the tabs and the composer and centres the
    // stage in what is left. Found by its padding contract, not by position.
    const container = /class="([^"]*place-items-center px-4[^"]*)"/.exec(markup);
    assert.ok(container, 'the padded stage container is no longer in the frame');
    assert.match(container[1], /\bh-full\b/, 'it still takes its height from the frame');
    assert.match(
        container[1],
        /\bmin-h-0\b/,
        'without min-h-0 this grid item grows to its content and the picture escapes the window',
    );
});

// ...and the same trap one level further in, which is the one that actually bit.
//
// Adding min-h-0 to the frame's container above was not enough: ImageStage wraps
// the stage in a grid item of its OWN, and that wrapper's automatic minimum size
// ends up being the picture's NATURAL size, propagated up from the <img>.
// Measured in the real app at 2000x1146 with a 1536x1536 output: the stage drew
// itself 1536x1536 and ran 446px off the bottom of the window, while the very
// same stage mid-render — no picture in it yet, so nothing intrinsic to grow on
// — sat correctly at 888x888. That is the jump: 888 while generating, 1536 the
// instant the result landed. With min-h-0 on the wrapper both are 888x888.
test("the stage cannot be grown to the picture's natural size either", async () => {
    const store = { get: () => ({ pct: 0.2, startedAt: Date.now(), estimateSec: 16, label: 'on this machine' }), subscribe: () => () => {} };
    const markup = await renderComponent('src/studios/image/ImageStage.jsx', 'ImageStage', {
        entry: null,
        historyCount: 1,
        generating: true,
        progressStore: store,
        progressHeading: 'Generating locally...',
        floatActions: false,
    });
    const wrapper = /<div class="relative grid ([^"]*)">/.exec(markup);
    assert.ok(wrapper, "ImageStage's stage wrapper is no longer where this test looks");
    assert.match(wrapper[1], /\bh-full\b/, 'it still takes its height from the frame');
    assert.match(
        wrapper[1],
        /\bmin-h-0\b/,
        "without min-h-0 the wrapper grows to the image's natural size and the stage jumps on completion",
    );
});
