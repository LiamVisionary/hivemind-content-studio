"""MLX port of Krea-2 SingleStreamDiT (krea/Krea-2-Turbo transformer).

Faithful line-by-line port of krea-2-official/mmdit.py. Module attribute names
match the `turbo.safetensors` tensor names exactly, so weights load with no
remapping. Reference casts the whole model to bf16 at inference; RMSNorm upcasts
to f32 internally (weight = stored `scale` + 1.0).
"""

from __future__ import annotations

import math
import os
from dataclasses import dataclass

import mlx.core as mx
from mlx import nn
from mlx.core.fast import scaled_dot_product_attention

SQRT_2_OVER_PI = math.sqrt(2.0 / math.pi)


def gelu_tanh(x: mx.array) -> mx.array:
    # Matches torch.nn.GELU(approximate="tanh").
    return 0.5 * x * (1.0 + mx.tanh(SQRT_2_OVER_PI * (x + 0.044715 * x * x * x)))


def _linear_last(linear: nn.Module, x: mx.array) -> mx.array:
    if x.ndim <= 2:
        return linear(x)
    y = linear(x.reshape(-1, x.shape[-1]))
    return y.reshape(*x.shape[:-1], y.shape[-1])


class GELUTanh(nn.Module):
    def __call__(self, x: mx.array) -> mx.array:
        return gelu_tanh(x)


@dataclass
class Krea2Config:
    features: int = 6144
    tdim: int = 256
    txtdim: int = 2560
    heads: int = 48
    kvheads: int = 12
    multiplier: int = 4
    layers: int = 28
    patch: int = 2
    channels: int = 16
    theta: float = 1000.0
    txtheads: int = 20
    txtkvheads: int = 20
    txtlayers: int = 12  # number of selected encoder hidden-state layers fed in


class RMSNorm(nn.Module):
    """Krea2 RMSNorm: effective weight = (scale + 1), math in float32, eps=1e-5."""

    def __init__(self, features: int, eps: float = 1e-5):
        super().__init__()
        self.scale = mx.zeros((features,))
        self.eps = eps

    def __call__(self, x: mx.array) -> mx.array:
        dt = x.dtype
        t = x.astype(mx.float32)
        t = t * mx.rsqrt(mx.mean(t * t, axis=-1, keepdims=True) + self.eps)
        t = t * (1.0 + self.scale.astype(mx.float32))
        return t.astype(dt)


class QKNorm(nn.Module):
    def __init__(self, dim: int):
        super().__init__()
        self.qnorm = RMSNorm(dim)
        self.knorm = RMSNorm(dim)


class SwiGLU(nn.Module):
    def __init__(self, features: int, multiplier: int, multiple: int = 128):
        super().__init__()
        mlpdim = int(2 * features / 3) * multiplier
        mlpdim = multiple * ((mlpdim + multiple - 1) // multiple)
        self.gate = nn.Linear(features, mlpdim, bias=False)
        self.up = nn.Linear(features, mlpdim, bias=False)
        self.down = nn.Linear(mlpdim, features, bias=False)

    def __call__(self, x: mx.array) -> mx.array:
        return _linear_last(self.down, nn.silu(_linear_last(self.gate, x)) * _linear_last(self.up, x))


class FusedSwiGLU(nn.Module):
    def __init__(self, source: SwiGLU):
        super().__init__()
        features = source.gate.weight.shape[1]
        mlpdim = source.gate.weight.shape[0]
        self.gate_up = nn.Linear(features, mlpdim * 2, bias=False)
        self.down = source.down
        self.gate_up.weight = mx.concatenate([source.gate.weight, source.up.weight], axis=0)

    def __call__(self, x: mx.array) -> mx.array:
        gate, up = mx.split(_linear_last(self.gate_up, x), 2, axis=-1)
        return _linear_last(self.down, nn.silu(gate) * up)


def _make_rope(pos: mx.array, axes: list[int], theta: float) -> tuple[mx.array, mx.array]:
    """pos: (L, 3) float positions -> (cos, sin) each (L, sum(axes)//2)."""
    cos_parts, sin_parts = [], []
    for i, d in enumerate(axes):
        scale = mx.arange(0, d, 2).astype(mx.float32) / d  # (d/2,)
        omega = 1.0 / (theta**scale)
        freqs = pos[:, i : i + 1] * omega[None, :]  # (L, d/2)
        cos_parts.append(mx.cos(freqs))
        sin_parts.append(mx.sin(freqs))
    return mx.concatenate(cos_parts, axis=-1), mx.concatenate(sin_parts, axis=-1)


def _apply_rope(x: mx.array, cos: mx.array, sin: mx.array) -> mx.array:
    """x: (B, H, L, D); cos/sin: (L, D/2). Interleaved (adjacent-pair) rotation."""
    b, h, l, d = x.shape
    rope_precision = os.environ.get("KREA2_MLX_ROPE_PRECISION", "fp32").lower()
    if rope_precision in {"native", "input", "bf16", "fp16"}:
        xf = x.reshape(b, h, l, d // 2, 2)
        c, s = cos.astype(x.dtype)[None, None], sin.astype(x.dtype)[None, None]
    else:
        xf = x.astype(mx.float32).reshape(b, h, l, d // 2, 2)
        c, s = cos[None, None], sin[None, None]
    x0, x1 = xf[..., 0], xf[..., 1]
    o0 = x0 * c - x1 * s
    o1 = x0 * s + x1 * c
    out = mx.stack([o0, o1], axis=-1).reshape(b, h, l, d)
    return out.astype(x.dtype)


class Attention(nn.Module):
    def __init__(self, dim: int, heads: int, kvheads: int | None = None):
        super().__init__()
        self.heads = heads
        self.kvheads = kvheads if kvheads is not None else heads
        self.headdim = dim // heads
        self.scale = self.headdim**-0.5
        self.wq = nn.Linear(dim, self.headdim * self.heads, bias=False)
        self.wk = nn.Linear(dim, self.headdim * self.kvheads, bias=False)
        self.wv = nn.Linear(dim, self.headdim * self.kvheads, bias=False)
        self.gate = nn.Linear(dim, dim, bias=False)
        self.qknorm = QKNorm(self.headdim)
        self.wo = nn.Linear(dim, dim, bias=False)

    def __call__(
        self,
        qkv: mx.array,
        cos: mx.array | None = None,
        sin: mx.array | None = None,
        mask: mx.array | None = None,
    ) -> mx.array:
        b, l, _ = qkv.shape
        q = _linear_last(self.wq, qkv).reshape(b, l, self.heads, self.headdim).transpose(0, 2, 1, 3)
        k = _linear_last(self.wk, qkv).reshape(b, l, self.kvheads, self.headdim).transpose(0, 2, 1, 3)
        v = _linear_last(self.wv, qkv).reshape(b, l, self.kvheads, self.headdim).transpose(0, 2, 1, 3)
        gate = _linear_last(self.gate, qkv)

        q = self.qknorm.qnorm(q)
        k = self.qknorm.knorm(k)

        if cos is not None:
            q = _apply_rope(q, cos, sin)
            k = _apply_rope(k, cos, sin)

        out = scaled_dot_product_attention(q, k, v, scale=self.scale, mask=mask)
        out = out.transpose(0, 2, 1, 3).reshape(b, l, self.heads * self.headdim)
        return _linear_last(self.wo, out * mx.sigmoid(gate))


class FusedAttention(nn.Module):
    def __init__(self, source: Attention):
        super().__init__()
        self.heads = source.heads
        self.kvheads = source.kvheads
        self.headdim = source.headdim
        self.scale = source.scale
        dim = source.gate.weight.shape[1]
        outdim = (
            source.wq.weight.shape[0]
            + source.wk.weight.shape[0]
            + source.wv.weight.shape[0]
            + source.gate.weight.shape[0]
        )
        self.qkvgate = nn.Linear(dim, outdim, bias=False)
        self.qkvgate.weight = mx.concatenate(
            [source.wq.weight, source.wk.weight, source.wv.weight, source.gate.weight],
            axis=0,
        )
        self.qknorm = source.qknorm
        self.wo = source.wo

    def __call__(
        self,
        qkv: mx.array,
        cos: mx.array | None = None,
        sin: mx.array | None = None,
        mask: mx.array | None = None,
    ) -> mx.array:
        b, l, _ = qkv.shape
        projected = _linear_last(self.qkvgate, qkv)
        qdim = self.headdim * self.heads
        kvdim = self.headdim * self.kvheads
        q = projected[..., :qdim]
        k = projected[..., qdim : qdim + kvdim]
        v = projected[..., qdim + kvdim : qdim + kvdim * 2]
        gate = projected[..., qdim + kvdim * 2 :]

        q = q.reshape(b, l, self.heads, self.headdim).transpose(0, 2, 1, 3)
        k = k.reshape(b, l, self.kvheads, self.headdim).transpose(0, 2, 1, 3)
        v = v.reshape(b, l, self.kvheads, self.headdim).transpose(0, 2, 1, 3)

        q = self.qknorm.qnorm(q)
        k = self.qknorm.knorm(k)

        if cos is not None:
            q = _apply_rope(q, cos, sin)
            k = _apply_rope(k, cos, sin)

        out = scaled_dot_product_attention(q, k, v, scale=self.scale, mask=mask)
        out = out.transpose(0, 2, 1, 3).reshape(b, l, self.heads * self.headdim)
        return _linear_last(self.wo, out * mx.sigmoid(gate))


class DoubleSharedModulation(nn.Module):
    def __init__(self, dim: int):
        super().__init__()
        self.lin = mx.zeros((6 * dim,))

    def __call__(self, vec: mx.array) -> tuple[mx.array, ...]:
        out = vec + self.lin
        return mx.split(out, 6, axis=-1)


class SimpleModulation(nn.Module):
    def __init__(self, dim: int):
        super().__init__()
        self.lin = mx.zeros((2, dim))

    def __call__(self, vec: mx.array) -> tuple[mx.array, mx.array]:
        out = vec + self.lin[None]  # (B,1,d)+(1,2,d) -> (B,2,d)
        scale, shift = mx.split(out, 2, axis=1)
        return scale, shift


class SingleStreamBlock(nn.Module):
    def __init__(self, features: int, heads: int, multiplier: int, kvheads: int):
        super().__init__()
        self.mod = DoubleSharedModulation(features)
        self.prenorm = RMSNorm(features)
        self.postnorm = RMSNorm(features)
        self.attn = Attention(features, heads, kvheads)
        self.mlp = SwiGLU(features, multiplier)

    def __call__(self, x, vec, cos, sin, mask):
        prescale, preshift, pregate, postscale, postshift, postgate = self.mod(vec)
        x = x + pregate * self.attn((1 + prescale) * self.prenorm(x) + preshift, cos, sin, mask)
        x = x + postgate * self.mlp((1 + postscale) * self.postnorm(x) + postshift)
        return x


class TextFusionBlock(nn.Module):
    def __init__(self, features: int, heads: int, multiplier: int, kvheads: int):
        super().__init__()
        self.prenorm = RMSNorm(features)
        self.postnorm = RMSNorm(features)
        self.attn = Attention(features, heads, kvheads)
        self.mlp = SwiGLU(features, multiplier)

    def __call__(self, x, mask=None):
        x = x + self.attn(self.prenorm(x), mask=mask)
        x = x + self.mlp(self.postnorm(x))
        return x


class TextFusionTransformer(nn.Module):
    def __init__(self, num_txt_layers, txt_dim, heads, multiplier, kvheads):
        super().__init__()
        self.layerwise_blocks = [TextFusionBlock(txt_dim, heads, multiplier, kvheads) for _ in range(2)]
        self.projector = nn.Linear(num_txt_layers, 1, bias=False)
        self.refiner_blocks = [TextFusionBlock(txt_dim, heads, multiplier, kvheads) for _ in range(2)]

    def __call__(self, x: mx.array, mask: mx.array | None = None) -> mx.array:
        # x: (B, L, n_layers, D)
        b, l, n, d = x.shape
        x = x.reshape(b * l, n, d)
        for block in self.layerwise_blocks:
            x = block(x, mask=None)
        # (b l) n d -> b l d n
        x = x.reshape(b, l, n, d).transpose(0, 1, 3, 2)
        x = self.projector(x)  # (b, l, d, 1)
        x = x[..., 0]  # (b, l, d)
        for block in self.refiner_blocks:
            x = block(x, mask=mask)
        return x


class LastLayer(nn.Module):
    def __init__(self, features: int, patch: int, channels: int):
        super().__init__()
        self.norm = RMSNorm(features)
        self.linear = nn.Linear(features, patch * patch * channels, bias=True)
        self.modulation = SimpleModulation(features)

    def __call__(self, x: mx.array, tvec: mx.array) -> mx.array:
        scale, shift = self.modulation(tvec)
        x = (1 + scale) * self.norm(x) + shift
        return self.linear(x)


def _timestep_embed(t: mx.array, dim: int, period: float = 1e4, tfactor: float = 1e3) -> mx.array:
    half = dim // 2
    freqs = mx.exp(-math.log(period) * mx.arange(half).astype(mx.float32) / half)
    args = (t.astype(mx.float32) * tfactor)[:, None, None] * freqs  # (B,1,half)
    return mx.concatenate([mx.cos(args), mx.sin(args)], axis=-1)  # (B,1,dim)


def _additive_mask(valid: mx.array, dtype: mx.Dtype) -> mx.array | None:
    """valid: (B, L) {0,1}. Returns additive (B,1,L,L) mask, or None if all valid."""
    if bool(mx.all(valid >= 0.5).item()):
        return None
    m = valid.astype(mx.float32)
    full = m[:, :, None] * m[:, None, :]  # (B,L,L)
    add = (1.0 - full) * -1e9
    return add[:, None].astype(dtype)


class SingleStreamDiT(nn.Module):
    def __init__(self, cfg: Krea2Config = Krea2Config()):
        super().__init__()
        self.cfg = cfg
        headdim = cfg.features // cfg.heads
        self.axes = [headdim - 12 * (headdim // 16), 6 * (headdim // 16), 6 * (headdim // 16)]
        assert sum(self.axes) == headdim

        self.first = nn.Linear(cfg.channels * cfg.patch**2, cfg.features, bias=True)
        self.blocks = [SingleStreamBlock(cfg.features, cfg.heads, cfg.multiplier, cfg.kvheads) for _ in range(cfg.layers)]
        self.tmlp = [nn.Linear(cfg.tdim, cfg.features), GELUTanh(), nn.Linear(cfg.features, cfg.features)]
        self.txtfusion = TextFusionTransformer(cfg.txtlayers, cfg.txtdim, cfg.txtheads, cfg.multiplier, cfg.txtkvheads)
        self.txtmlp = [RMSNorm(cfg.txtdim), nn.Linear(cfg.txtdim, cfg.features), GELUTanh(), nn.Linear(cfg.features, cfg.features)]
        self.last = LastLayer(cfg.features, cfg.patch, cfg.channels)
        self.tproj = [GELUTanh(), nn.Linear(cfg.features, cfg.features * 6)]

    def _run_seq(self, layers, x):
        for layer in layers:
            x = layer(x)
        return x

    def prepare_context(self, context: mx.array, pos: mx.array, mask: mx.array, dtype: mx.Dtype):
        txtlen = context.shape[1]
        txt_valid = mask[:, :txtlen]
        txtmask = _additive_mask(txt_valid, dtype)
        context = self.txtfusion(context, mask=txtmask)
        context = self._run_seq(self.txtmlp, context)
        cos, sin = _make_rope(pos.astype(mx.float32), self.axes, self.cfg.theta)
        full_mask = _additive_mask(mask, dtype)
        return context, cos, sin, full_mask

    def prepare_timestep(self, t: mx.array, dtype: mx.Dtype):
        t_emb = self._run_seq(self.tmlp, _timestep_embed(t, self.cfg.tdim).astype(dtype))  # (B,1,feat)
        tvec = self._run_seq(self.tproj, t_emb)  # (B,1,6*feat)
        return t_emb, tvec

    def forward_prepared(
        self,
        img: mx.array,
        prepared_context: mx.array,
        t: mx.array,
        cos: mx.array,
        sin: mx.array,
        full_mask: mx.array | None,
    ) -> mx.array:
        t_emb, tvec = self.prepare_timestep(t, img.dtype)
        return self.forward_prepared_vectors(img, prepared_context, t_emb, tvec, cos, sin, full_mask)

    def forward_prepared_vectors(
        self,
        img: mx.array,
        prepared_context: mx.array,
        t_emb: mx.array,
        tvec: mx.array,
        cos: mx.array,
        sin: mx.array,
        full_mask: mx.array | None,
    ) -> mx.array:
        img = self.first(img)
        txtlen = prepared_context.shape[1]
        combined = mx.concatenate([prepared_context, img], axis=1)

        for block in self.blocks:
            combined = block(combined, tvec, cos, sin, full_mask)

        final = self.last(combined[:, txtlen : txtlen + img.shape[1], :], t_emb)
        return final

    def __call__(
        self,
        img: mx.array,  # (B, Limg, channels*patch^2)
        context: mx.array,  # (B, seq, n_layers, txtdim)
        t: mx.array,  # (B,) current timestep in [0,1]
        pos: mx.array,  # (L, 3) positions for [txt; img]
        mask: mx.array,  # (B, L) validity {0,1}
    ) -> mx.array:
        prepared = self.prepare_context(context, pos, mask, img.dtype)
        return self.forward_prepared(img, *prepared[:1], t, *prepared[1:])


def fuse_block_projections(model: SingleStreamDiT) -> SingleStreamDiT:
    for block in model.blocks:
        if isinstance(block.attn, Attention):
            block.attn = FusedAttention(block.attn)
        if isinstance(block.mlp, SwiGLU):
            block.mlp = FusedSwiGLU(block.mlp)
    return model
