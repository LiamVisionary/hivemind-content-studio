"""MLX flow-matching sampler for Krea-2 (port of krea-2-official/sampling.py)."""

from __future__ import annotations

import math
import time

import mlx.core as mx
import numpy as np


def roundup(value: int, multiple: int) -> int:
    return ((value + multiple - 1) // multiple) * multiple


def patchify(x: mx.array, p: int) -> mx.array:
    # (b, c, H, W) -> (b, (H/p)*(W/p), c*p*p)   [c ph pw] ordering
    b, c, H, W = x.shape
    h, w = H // p, W // p
    x = x.reshape(b, c, h, p, w, p).transpose(0, 2, 4, 1, 3, 5)
    return x.reshape(b, h * w, c * p * p)


def unpatchify(x: mx.array, p: int, h: int, w: int, c: int) -> mx.array:
    # (b, h*w, c*p*p) -> (b, c, h*p, w*p)
    b = x.shape[0]
    x = x.reshape(b, h, w, c, p, p).transpose(0, 3, 1, 4, 2, 5)
    return x.reshape(b, c, h * p, w * p)


def build_positions(b: int, txtlen: int, h_: int, w_: int) -> mx.array:
    txtpos = np.zeros((txtlen, 3), np.float32)
    imgids = np.zeros((h_, w_, 3), np.float32)
    imgids[..., 1] = np.arange(h_)[:, None]
    imgids[..., 2] = np.arange(w_)[None, :]
    pos = np.concatenate([txtpos, imgids.reshape(-1, 3)], axis=0)
    return mx.array(pos)


def compact_valid_text_tokens(ctx: mx.array, mask: mx.array) -> tuple[mx.array, mx.array]:
    valid = np.array(mask.astype(mx.float32)) >= 0.5
    if valid.ndim != 2 or valid.shape[1] == 0:
        return ctx, mask
    first = valid[0]
    if first.all() or not np.all(valid == first[None, :]):
        return ctx, mask
    idx = np.flatnonzero(first).astype(np.int32)
    if idx.size == 0 or idx.size == valid.shape[1]:
        return ctx, mask
    ctx = ctx[:, mx.array(idx), :, :]
    return ctx, mx.ones((ctx.shape[0], int(idx.size)))


def timesteps(seq_len, steps, x1, x2, y1=0.5, y2=1.15, sigma=1.0, mu=None):
    ts = np.linspace(1, 0, steps + 1)
    if mu is None:
        slope = (y2 - y1) / (x2 - x1)
        mu = slope * seq_len + (y1 - slope * x1)
    with np.errstate(divide="ignore"):
        ts = math.exp(mu) / (math.exp(mu) + (1.0 / ts - 1.0) ** sigma)
    return ts.tolist()


def _flow_lambda(t: float) -> float:
    t = min(max(float(t), 1e-6), 1.0 - 1e-6)
    return t / (1.0 - t)


def _er_sde_noise_scaler(lam: float) -> float:
    lam = max(float(lam), 1e-12)
    return lam * (math.exp(lam ** 0.3) + 10.0)


def _er_sde_step(
    img: mx.array,
    denoised: mx.array,
    tc: float,
    tp: float,
    i: int,
    old_denoised: mx.array | None,
    old_denoised_d: mx.array | None,
    old_lambdas: list[float],
    *,
    max_stage: int,
    s_noise: float,
    dtype: mx.Dtype,
) -> tuple[mx.array, mx.array | None]:
    # Adapt Comfy's ER-SDE data-prediction update to Krea's rectified-flow
    # parameterization: x_t = (1 - t) * x0 + t * noise, lambda = t / (1 - t).
    # The first and final steps stay Euler/x0 to avoid singular lambda endpoints.
    if i == 0 or tc >= 1.0 - 1e-6:
        return img + (tp - tc) * ((img - denoised) / max(tc, 1e-6)), None
    if tp <= 1e-6:
        return denoised, None

    lam_s = _flow_lambda(tc)
    lam_t = _flow_lambda(tp)
    alpha_s = 1.0 - tc
    alpha_t = 1.0 - tp
    scale_s = _er_sde_noise_scaler(lam_s)
    scale_t = _er_sde_noise_scaler(lam_t)
    r = scale_t / scale_s

    x = (alpha_t / max(alpha_s, 1e-6)) * r * img + alpha_t * (1.0 - r) * denoised
    denoised_d = None
    stage_used = min(max_stage, i + 1)

    if old_denoised is not None and stage_used >= 2 and old_lambdas:
        dt = lam_t - lam_s
        lambda_step_size = -dt / 200.0
        lambda_pos = lam_t + np.arange(200, dtype=np.float32) * lambda_step_size
        scaled_pos = np.maximum(lambda_pos, 1e-12) * (np.exp(np.maximum(lambda_pos, 1e-12) ** 0.3) + 10.0)
        integ_s = float(np.sum(1.0 / scaled_pos) * lambda_step_size)

        denoised_d = (denoised - old_denoised) / (lam_s - old_lambdas[-1])
        x = x + alpha_t * (dt + integ_s * scale_t) * denoised_d

        if old_denoised_d is not None and stage_used >= 3 and len(old_lambdas) >= 2:
            integ_u = float(np.sum((lambda_pos - lam_s) / scaled_pos) * lambda_step_size)
            denoised_u = (denoised_d - old_denoised_d) / ((lam_s - old_lambdas[-2]) / 2.0)
            x = x + alpha_t * ((dt * dt) / 2.0 + integ_u * scale_t) * denoised_u

    if s_noise > 0:
        noise_var = lam_t * lam_t - lam_s * lam_s * r * r
        if noise_var > 0:
            x = x + alpha_t * mx.random.normal(img.shape).astype(dtype) * s_noise * math.sqrt(noise_var)

    return x, denoised_d


def sample(
    transformer,
    vae,
    encode,            # callable: list[str] -> (context mx, mask mx)
    prompts,
    *,
    width=1024,
    height=1024,
    steps=8,
    guidance=0.0,      # turbo: no CFG
    seed=0,
    minres=256,
    maxres=1280,
    y1=0.5,
    y2=1.15,
    mu=None,
    init_noise=None,   # (n,16,H/8,W/8) to match a PT run; else MLX RNG
    dtype=mx.bfloat16,
    step_callback=None,  # called as step_callback(step, total) after each denoising step
    eval_each_step=False,
    profile: dict | None = None,
    sampler: str = "flow_euler",
    er_sde_max_stage: int = 3,
    er_sde_s_noise: float = 0.0,
):
    if sampler not in {"flow_euler", "er_sde"}:
        raise ValueError(f"sampler must be 'flow_euler' or 'er_sde', got {sampler!r}.")

    cfg = guidance > 0
    patch = transformer.cfg.patch
    comp = vae.spatial_scale  # 8
    align = comp * patch
    width, height = roundup(width, align), roundup(height, align)
    n = len(prompts)
    profile_mark = time.perf_counter()

    def mark(name: str, *arrays):
        nonlocal profile_mark
        if profile is None:
            return
        if arrays:
            mx.eval(*arrays)
        now = time.perf_counter()
        profile[name] = now - profile_mark
        profile_mark = now

    lat_h, lat_w = height // comp, width // comp
    if init_noise is None:
        mx.random.seed(seed)
        noise = mx.random.normal((n, vae.latent_channels, lat_h, lat_w)).astype(dtype)
    else:
        noise = mx.array(init_noise).astype(dtype)
    mark("noise", noise)

    ctx, mask = encode(prompts)
    ctx = ctx.astype(dtype)
    ctx, mask = compact_valid_text_tokens(ctx, mask)
    mark("encode", ctx, mask)
    txtlen = ctx.shape[1]
    h_, w_ = lat_h // patch, lat_w // patch

    img = patchify(noise, patch)  # (n, h_*w_, 64)
    pos = build_positions(n, txtlen, h_, w_)
    full_mask = mx.concatenate([mask, mx.ones((n, h_ * w_))], axis=1)
    mark("patchify_positions", img, pos, full_mask)
    prepared = None
    timestep_vectors = None
    if hasattr(transformer, "prepare_context") and hasattr(transformer, "forward_prepared"):
        prepared = transformer.prepare_context(ctx, pos, full_mask, dtype)
        mark("prepare_context", *prepared)

    x1 = (minres // align) ** 2
    x2 = (maxres // align) ** 2
    ts = timesteps(img.shape[1], steps, x1, x2, y1=y1, y2=y2, mu=mu)
    if prepared is not None and hasattr(transformer, "prepare_timestep") and hasattr(transformer, "forward_prepared_vectors"):
        timestep_vectors = [transformer.prepare_timestep(mx.full((n,), tc, dtype=dtype), dtype) for tc in ts[:-1]]
        mark("prepare_timesteps", timestep_vectors)

    total = len(ts) - 1
    denoise_start = time.perf_counter()
    old_denoised = None
    old_denoised_d = None
    old_lambdas: list[float] = []
    for i, (tc, tp) in enumerate(zip(ts[:-1], ts[1:])):
        if prepared is None:
            t = mx.full((n,), tc, dtype=dtype)
            v = transformer(img, ctx, t, pos, full_mask)
        elif timestep_vectors is not None:
            t_emb, tvec = timestep_vectors[i]
            v = transformer.forward_prepared_vectors(img, prepared[0], t_emb, tvec, prepared[1], prepared[2], prepared[3])
        else:
            t = mx.full((n,), tc, dtype=dtype)
            v = transformer.forward_prepared(img, prepared[0], t, prepared[1], prepared[2], prepared[3])
        if cfg:
            raise NotImplementedError("CFG path not needed for turbo")
        if sampler == "er_sde":
            denoised = img - tc * v
            img, denoised_d = _er_sde_step(
                img,
                denoised,
                tc,
                tp,
                i,
                old_denoised,
                old_denoised_d,
                old_lambdas,
                max_stage=er_sde_max_stage,
                s_noise=er_sde_s_noise,
                dtype=dtype,
            )
            old_denoised = denoised
            if denoised_d is not None:
                old_denoised_d = denoised_d
            old_lambdas.append(_flow_lambda(tc))
        else:
            img = img + (tp - tc) * v
        if eval_each_step or step_callback is not None:
            mx.eval(img)
        if step_callback is not None:
            step_callback(i + 1, total)
    if profile is not None:
        mx.eval(img)
        profile["denoise"] = time.perf_counter() - denoise_start
        profile_mark = time.perf_counter()

    latent = unpatchify(img, patch, h_, w_, vae.latent_channels)  # (n,16,lat_h,lat_w)
    mark("unpatchify", latent)
    decoded = vae.decode(latent.astype(mx.float32))  # (n,3,1,H,W)
    decoded = mx.clip(decoded, -1, 1) * 0.5 + 0.5
    decoded = decoded[:, :, 0]  # (n,3,H,W)
    mark("decode", decoded)
    if profile is None:
        mx.eval(decoded)
    return decoded


def to_pil(decoded: mx.array):
    from PIL import Image

    arr = np.array(decoded.astype(mx.float32))  # (n,3,H,W)
    arr = (np.transpose(arr, (0, 2, 3, 1)) * 255.0).round().clip(0, 255).astype(np.uint8)
    return [Image.fromarray(arr[i]) for i in range(arr.shape[0])]
