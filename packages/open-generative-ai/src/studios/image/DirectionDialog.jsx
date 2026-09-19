// Direction edit — point the eyes, or move the sun, by picking on the picture.
//
// One dialog for both of Eric Venti's Flux.2 Klein 9B direction LoRAs, because
// they are the same gesture: drag a marker, and the model is conditioned on a
// rendered reference that says where. The eyes look at a red dot; the light
// arrives from wherever a reference sphere is lit.
//
// The eyes picker IS the reference — white canvas, black frame, red dot, the
// author's own three primitives (src/lib/directionEdit.js draws them, and a
// test pins its constants to the gateway's). The sun picker cannot be: its
// reference is a lit 3D render, so the disc here is a control and the sphere
// beside it is the real reference, fetched from the same renderer the run
// uses. Neither view is a mock-up of what the model will see.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMediaSrc } from '../../hooks/hooks.js';
import {
    SUN_RANGES,
    STRENGTH_RANGE,
    clampNumber,
    describeSunDirection,
    directionLane,
    directionReferenceParams,
    discFromSun,
    drawEyesReference,
    sunFromDisc,
} from '../../lib/directionEdit.js';
import { localAI } from '../../lib/localInferenceClient.js';
import { t, tf } from '../../lib/i18n.js';
import { Modal } from '../../ui/Modal.jsx';
import { ActionButton, Field, Slider, TextInput, Toggle, cx } from '../../ui/kit.jsx';
import { Icon } from '../../ui/icons.jsx';

const PICKER_PX = 260;

/** Pointer position inside an element, normalised to 0..1. */
function pointerFraction(event, element) {
    const rect = element.getBoundingClientRect();
    return {
        x: (event.clientX - rect.left) / rect.width,
        y: (event.clientY - rect.top) / rect.height,
    };
}

/** Drag handling shared by both pickers: capture the pointer so a drag that
 *  leaves the control keeps steering, and report every move. */
function useDrag(onMove) {
    const dragging = useRef(null);
    const begin = (event) => {
        dragging.current = event.pointerId;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        onMove(event);
    };
    const move = (event) => {
        if (dragging.current !== event.pointerId) return;
        onMove(event);
    };
    const end = (event) => {
        if (dragging.current !== event.pointerId) return;
        dragging.current = null;
        event.currentTarget.releasePointerCapture?.(event.pointerId);
    };
    return {
        onPointerDown: begin, onPointerMove: move, onPointerUp: end, onPointerCancel: end,
        style: { touchAction: 'none' },
    };
}

function EyesPicker({ x, y, onPick, disabled }) {
    const canvasRef = useRef(null);
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ratio = window.devicePixelRatio || 1;
        canvas.width = PICKER_PX * ratio;
        canvas.height = PICKER_PX * ratio;
        drawEyesReference(canvas.getContext('2d'), PICKER_PX * ratio, x, y);
    }, [x, y]);
    const drag = useDrag(useCallback((event) => {
        if (disabled) return;
        const point = pointerFraction(event, event.currentTarget);
        onPick(clampNumber(point.x, 0, 1, 0.5), clampNumber(point.y, 0, 1, 0.5));
    }, [disabled, onPick]));
    return (
        <canvas
            ref={canvasRef}
            {...drag}
            className={cx('rounded-lg border border-line1 bg-white', disabled ? 'opacity-50' : 'cursor-crosshair')}
            style={{ ...drag.style, width: PICKER_PX, height: PICKER_PX }}
            role="slider"
            aria-label={t('direction.eyesPickerLabel')}
            aria-valuetext={tf('direction.eyesPosition', Math.round(x * 100), Math.round(y * 100))}
        />
    );
}

function SunPicker({ rotation, elevation, onPick, disabled }) {
    const marker = discFromSun(rotation, elevation);
    const drag = useDrag(useCallback((event) => {
        if (disabled) return;
        const point = pointerFraction(event, event.currentTarget);
        const picked = sunFromDisc(point.x * 2 - 1, point.y * 2 - 1);
        onPick(picked.rotation, picked.elevation);
    }, [disabled, onPick]));
    return (
        <div
            {...drag}
            className={cx('relative rounded-full border border-line1 bg-bg1', disabled ? 'opacity-50' : 'cursor-crosshair')}
            style={{ ...drag.style, width: PICKER_PX, height: PICKER_PX }}
            role="slider"
            aria-label={t('direction.sunPickerLabel')}
            aria-valuetext={describeSunDirection(rotation, elevation)}
        >
            {/* Rings read as elevation: the rim is the horizon, the middle is
                noon. The camera sits at the bottom, so a marker near it is a
                light behind the viewer and one at the top is a backlight. */}
            <div className="pointer-events-none absolute inset-[16.7%] rounded-full border border-dashed border-line1" />
            <div className="pointer-events-none absolute inset-[38.9%] rounded-full border border-dashed border-line1" />
            <div className="pointer-events-none absolute inset-x-0 bottom-1 grid place-items-center text-ink3">
                <Icon name="camera" size={13} />
            </div>
            <div
                className="pointer-events-none absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-bg0 bg-honey shadow-card"
                style={{ left: `${(marker.x + 1) * 50}%`, top: `${(marker.y + 1) * 50}%` }}
            />
        </div>
    );
}

export function DirectionDialog({ kind, entry, busy, onClose, onSubmit }) {
    const lane = directionLane(kind);
    const src = useMediaSrc(entry?.url);
    const [state, setState] = useState(() => ({ ...(lane?.defaults || {}) }));
    const [extra, setExtra] = useState('');
    const patch = (changes) => setState((previous) => ({ ...previous, ...changes }));

    // The sphere the model will actually read. Empty when the host bridge has
    // no renderer to ask, in which case the disc stands alone rather than a
    // broken thumbnail standing in for it.
    const referenceUrl = useMemo(() => {
        if (kind !== 'sun') return '';
        const params = directionReferenceParams(kind, state);
        return params ? localAI.directionReferenceUrl(params) : '';
    }, [kind, state]);

    if (!lane) return null;
    const isSun = kind === 'sun';

    return (
        <Modal
            open
            onClose={busy ? undefined : onClose}
            title={t(isSun ? 'direction.sunTitle' : 'direction.eyesTitle')}
            size="lg"
            dismissable={!busy}
            footer={(
                <>
                    <ActionButton variant="neutral" label={t('common.cancel')} onClick={onClose} disabled={busy} />
                    <ActionButton
                        variant="primary"
                        icon={lane.icon}
                        loading={busy}
                        label={busy ? t('direction.running') : t('direction.run')}
                        onClick={() => onSubmit({ ...state, extra })}
                        disabled={busy}
                    />
                </>
            )}
        >
            <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_auto]">
                <div className="min-w-0">
                    {src ? (
                        <img src={src} alt="" className="max-h-[42dvh] w-auto max-w-full rounded-lg border border-line1" />
                    ) : (
                        <div className="h-40 rounded-lg border border-line1 bg-bg1" />
                    )}
                    <p className="mt-2 text-xs text-ink3">
                        {t(isSun ? 'direction.sunHint' : 'direction.eyesHint')}
                    </p>
                </div>

                <div className="flex flex-col items-center gap-3">
                    {isSun ? (
                        <SunPicker
                            rotation={state.rotation}
                            elevation={state.elevation}
                            disabled={busy}
                            onPick={(rotation, elevation) => patch({ rotation, elevation })}
                        />
                    ) : (
                        <EyesPicker x={state.x} y={state.y} disabled={busy} onPick={(x, y) => patch({ x, y })} />
                    )}
                    <div className="flex items-center gap-3">
                        <span className="font-mono text-xs text-ink2">
                            {isSun
                                ? describeSunDirection(state.rotation, state.elevation)
                                : tf('direction.eyesPosition', Math.round(state.x * 100), Math.round(state.y * 100))}
                        </span>
                        <button
                            type="button"
                            className="rounded-md border border-line1 px-2 py-1 text-xs text-ink2 transition-colors hover:border-line2 hover:text-ink1"
                            onClick={() => patch({ ...lane.defaults })}
                            disabled={busy}
                        >
                            {t('settings.reset')}
                        </button>
                    </div>
                    {isSun && referenceUrl ? (
                        <figure className="m-0 text-center">
                            <img
                                src={referenceUrl}
                                alt=""
                                width={104}
                                height={104}
                                className="rounded-md border border-line1"
                            />
                            <figcaption className="mt-1 text-[11px] text-ink3">{t('direction.referenceCaption')}</figcaption>
                        </figure>
                    ) : null}
                </div>
            </div>

            <div className="mt-5 grid gap-4 sm:grid-cols-2">
                <Field
                    label={t('direction.strength')}
                    hint={t('direction.strengthHint')}
                >
                    <Slider
                        min={STRENGTH_RANGE.min}
                        max={STRENGTH_RANGE.max}
                        step={STRENGTH_RANGE.step}
                        value={state.strength}
                        onChange={(strength) => patch({ strength })}
                        format={(value) => value.toFixed(2)}
                        disabled={busy}
                    />
                </Field>
                {isSun ? (
                    <Field label={t('direction.intensity')} hint={t('direction.intensityHint')}>
                        <Slider
                            min={SUN_RANGES.intensity.min}
                            max={SUN_RANGES.intensity.max}
                            step={SUN_RANGES.intensity.step}
                            value={state.intensity}
                            onChange={(intensity) => patch({ intensity })}
                            format={(value) => value.toFixed(1)}
                            disabled={busy}
                        />
                    </Field>
                ) : null}
                <Field
                    label={t('direction.extra')}
                    hint={t(isSun ? 'direction.extraSunHint' : 'direction.extraEyesHint')}
                    className="sm:col-span-2"
                >
                    <TextInput
                        value={extra}
                        onChange={(e) => setExtra(e.target.value)}
                        placeholder={t(isSun ? 'direction.extraSunPlaceholder' : 'direction.extraEyesPlaceholder')}
                        disabled={busy}
                    />
                </Field>
                {isSun ? (
                    <label className="flex cursor-pointer items-start gap-3 sm:col-span-2">
                        <Toggle
                            checked={state.flattenLight !== false}
                            onChange={(flattenLight) => patch({ flattenLight })}
                            label={t('direction.flatten')}
                            disabled={busy}
                        />
                        <span className="min-w-0">
                            <span className="block text-xs font-medium text-ink2">{t('direction.flatten')}</span>
                            <span className="mt-0.5 block text-xs text-ink3">{t('direction.flattenHint')}</span>
                        </span>
                    </label>
                ) : null}
            </div>
        </Modal>
    );
}
