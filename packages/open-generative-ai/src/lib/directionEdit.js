// Direction edits — point the eyes, or move the sun, on a picture that already
// exists.
//
// Both are Eric Venti's Flux.2 Klein 9B LoRAs, and both work the same way: the
// prompt is a fixed trigger sentence and the ACTUAL instruction is a second
// reference image the model is conditioned on. The eyes look at a red dot; the
// light arrives from wherever a reference sphere is lit. So the control we give
// a person is a picker, not a sentence — "change the eyes to look above the
// camera" is exactly the prompt-wrangling these LoRAs exist to replace.
//
// Everything here is the pick and the words. The pixels are rendered by the
// gateway (packages/media-gateway/gateway/direction_reference.py), which is
// also what the run itself uses, so there is one renderer and the dialog can
// show the reference rather than an impression of it.

/** The eyes canvas, mirroring the author's EyesDirectionControl node. The
 *  frame stands for the edited picture's own border: a dot inside it is a gaze
 *  that stays in frame, a dot outside it is a gaze leaving frame, which is the
 *  whole reason the canvas is bigger than the frame it draws. */
export const EYES_CANVAS = Object.freeze({ size: 1024, frame: 580, dot: 85, border: 6 });

export const SUN_RANGES = Object.freeze({
    rotation: { min: -180, max: 180 },
    elevation: { min: 5, max: 85 },
    intensity: { min: 0.2, max: 3, step: 0.1 },
});

/** The author's own strength guidance, which differs by how drawn the picture
 *  is: photographic work moves at low strength, anime and other stylised work
 *  resists and has to be pushed. */
export const STRENGTH_RANGE = Object.freeze({ min: 0.25, max: 1.6, step: 0.05 });

export const DIRECTION_LANES = Object.freeze({
    eyes: Object.freeze({
        kind: 'eyes',
        workflowId: 'flux2-klein-eyes-direction',
        icon: 'eye',
        trigger: 'change the eyes to match the reference dot direction',
        defaults: Object.freeze({ x: 0.5, y: 0.5, strength: 1 }),
    }),
    sun: Object.freeze({
        kind: 'sun',
        workflowId: 'flux2-klein-sun-direction',
        icon: 'sun',
        trigger: 'match the sun direction from the reference',
        defaults: Object.freeze({ rotation: 0, elevation: 45, intensity: 1.5, strength: 1, flattenLight: true }),
    }),
});

export function directionLane(kind) {
    return DIRECTION_LANES[String(kind || '')] || null;
}

export function clampNumber(value, min, max, fallback = min) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
}

/**
 * The prompt a direction edit sends: the LoRA's trigger sentence, then
 * whatever the person added.
 *
 * The trigger is not advice, it is the phrase the LoRA was trained on, so the
 * extra words are appended to it and never replace it. Kept byte-identical to
 * graphs.direction_prompt_text on the gateway, which composes the same string
 * for callers that never open this dialog.
 */
export function directionPromptText(kind, extra = '') {
    const lane = directionLane(kind);
    if (!lane) return String(extra || '').trim();
    const tail = String(extra || '').trim();
    return tail ? `${lane.trigger}, ${tail}` : lane.trigger;
}

/**
 * Draw the eyes reference at `size` pixels square.
 *
 * This is the reference image itself, not a diagram of it — three primitives
 * at the author's proportions, which is why the picker can double as its own
 * preview. `EYES_CANVAS` is checked against the gateway's constants by
 * tests/directionEdit.test.js, so the two cannot drift apart unnoticed.
 */
export function drawEyesReference(ctx, size, x, y) {
    const scale = size / EYES_CANVAS.size;
    const border = Math.max(1, EYES_CANVAS.border * scale);
    const margin = ((EYES_CANVAS.size - EYES_CANVAS.frame) / 2) * scale;
    const frame = EYES_CANVAS.frame * scale;
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = border;
    ctx.strokeRect(margin + border / 2, margin + border / 2, frame - border, frame - border);
    ctx.beginPath();
    ctx.arc(x * size, y * size, Math.max(2, EYES_CANVAS.dot * scale), 0, Math.PI * 2);
    ctx.fillStyle = '#ff0000';
    ctx.fill();
}

// --- the sun disc ----------------------------------------------------------
//
// The sun picker is a sky seen from above with the camera standing at the
// bottom edge: the middle is the sun overhead, the rim is the sun at the
// horizon, and turning around the disc walks it around the scene. That shape
// is what covers the author's full range — a picker shaped like the lit ball
// could only ever express a light in FRONT of the subject, and half of what
// this LoRA is for is backlight.

/** Disc coordinates (-1..1, y down) for a sun angle. */
export function discFromSun(rotation, elevation) {
    const radius = (90 - clampNumber(elevation, SUN_RANGES.elevation.min, SUN_RANGES.elevation.max, 45)) / 90;
    const angle = (clampNumber(rotation, SUN_RANGES.rotation.min, SUN_RANGES.rotation.max, 0) * Math.PI) / 180;
    return { x: radius * Math.sin(angle), y: radius * Math.cos(angle) };
}

/** The sun angle a point on the disc means. Points outside the disc are read
 *  as the nearest point on its rim rather than ignored, so a drag that leaves
 *  the circle keeps steering the azimuth instead of sticking. */
export function sunFromDisc(x, y) {
    const distance = Math.hypot(x, y);
    const radius = Math.min(1, distance);
    const rotation = distance < 1e-6 ? 0 : (Math.atan2(x, y) * 180) / Math.PI;
    return {
        rotation: Math.round(clampNumber(rotation, SUN_RANGES.rotation.min, SUN_RANGES.rotation.max, 0)),
        elevation: Math.round(clampNumber(90 - radius * 90, SUN_RANGES.elevation.min, SUN_RANGES.elevation.max, 45)),
    };
}

/** Which way the light is coming from, in words, for the picker's readout. */
export function describeSunDirection(rotation, elevation) {
    const turn = ((Number(rotation) % 360) + 360) % 360;
    const compass = turn < 22.5 || turn >= 337.5 ? 'behind the camera'
        : turn < 67.5 ? 'front right'
        : turn < 112.5 ? 'right'
        : turn < 157.5 ? 'back right'
        : turn < 202.5 ? 'behind the subject'
        : turn < 247.5 ? 'back left'
        : turn < 292.5 ? 'left'
        : 'front left';
    const height = Number(elevation) >= 60 ? 'high' : Number(elevation) >= 30 ? 'midday' : 'low';
    return `${compass}, ${height}`;
}

/** The `direction` object a generation request carries. Named for the gateway's
 *  keys, not the dialog's state, so the wire shape is readable at the call. */
export function directionPayload(kind, state) {
    const lane = directionLane(kind);
    if (!lane) return null;
    const strength = clampNumber(state.strength, STRENGTH_RANGE.min, STRENGTH_RANGE.max, 1);
    if (kind === 'sun') {
        return {
            rotation: clampNumber(state.rotation, SUN_RANGES.rotation.min, SUN_RANGES.rotation.max, 0),
            elevation: clampNumber(state.elevation, SUN_RANGES.elevation.min, SUN_RANGES.elevation.max, 45),
            intensity: clampNumber(state.intensity, SUN_RANGES.intensity.min, SUN_RANGES.intensity.max, 1.5),
            flatten_light: state.flattenLight !== false,
            strength,
        };
    }
    return {
        x: clampNumber(state.x, 0, 1, 0.5),
        y: clampNumber(state.y, 0, 1, 0.5),
        strength,
    };
}

/** Query parameters for the gateway's reference renderer. */
export function directionReferenceParams(kind, state) {
    const payload = directionPayload(kind, state);
    if (!payload) return null;
    return kind === 'sun'
        ? { kind, rotation: String(payload.rotation), elevation: String(payload.elevation), intensity: String(payload.intensity) }
        : { kind, x: String(payload.x), y: String(payload.y) };
}
