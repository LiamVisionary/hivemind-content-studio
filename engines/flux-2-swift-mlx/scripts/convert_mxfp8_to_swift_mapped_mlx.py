#!/usr/bin/env python3
from __future__ import annotations

import argparse, gc, time
from pathlib import Path
import comfy_kitchen as ck
import mlx.core as mx
import torch
from safetensors import safe_open


def block_idx(key: str, prefix: str) -> int:
    rest = key[len(prefix):]
    return int(rest.split('.', 1)[0])


def to_mx_f16(t: torch.Tensor) -> mx.array:
    if t.dtype == torch.bfloat16:
        return mx.array(t.float().numpy(), dtype=mx.float16)
    if t.dtype in (torch.float16, torch.float32, torch.float64):
        return mx.array(t.float().numpy(), dtype=mx.float16)
    if t.dtype == torch.uint8:
        return mx.array(t.numpy(), dtype=mx.uint8)
    if t.dtype == torch.int64:
        return mx.array(t.numpy(), dtype=mx.int64)
    if t.dtype == torch.int32:
        return mx.array(t.numpy(), dtype=mx.int32)
    raise TypeError(f'unsupported dtype {t.dtype}')


def quantize_mxfp8_from_comfy(t: torch.Tensor, scale: torch.Tensor):
    scale_e8 = scale.view(torch.float8_e8m0fnu)
    deq = ck.dequantize_mxfp8(t, scale_e8, torch.bfloat16)
    w = mx.array(deq.float().numpy(), dtype=mx.float16)
    q, sc, *biases = mx.quantize(w, group_size=32, bits=8, mode='mxfp8')
    if biases:
        raise RuntimeError('mxfp8 returned biases')
    mx.eval(q, sc)
    return q, sc


def emit(out, dest: str, value, scale=None):
    out[dest] = value
    if scale is not None:
        out[dest[:-len('.weight')] + '.scales'] = scale


def maybe_quant(f, key: str):
    t = f.get_tensor(key)
    scale_key = key + '_scale'
    if scale_key in set(f.keys()) and str(t.dtype) == 'torch.float8_e4m3fn':
        return quantize_mxfp8_from_comfy(t, f.get_tensor(scale_key))
    return to_mx_f16(t), None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--input', required=True)
    ap.add_argument('--output', required=True)
    args = ap.parse_args()
    src = Path(args.input).expanduser().resolve()
    dst = Path(args.output).expanduser().resolve()
    dst.parent.mkdir(parents=True, exist_ok=True)
    out = {}
    converted = copied = unmapped = 0
    t0 = time.time()
    with safe_open(str(src), framework='pt', device='cpu') as f:
        keys = list(f.keys())
        for n, key in enumerate(keys, 1):
            if key.endswith('_scale') or key.endswith('_comfy_quant'):
                continue
            val, sc = maybe_quant(f, key)
            was_quant = sc is not None
            def e(dest, v=val, s=sc):
                nonlocal converted, copied
                emit(out, dest, v, s)
                if s is not None: converted += 1
                else: copied += 1
            if key.endswith('.img_attn.qkv.weight'):
                i=block_idx(key,'double_blocks.'); rows=val.shape[0]//3
                e(f'transformerBlocks.{i}.attn.toQ.weight', val[0:rows], sc[0:rows] if sc is not None else None)
                e(f'transformerBlocks.{i}.attn.toK.weight', val[rows:2*rows], sc[rows:2*rows] if sc is not None else None)
                e(f'transformerBlocks.{i}.attn.toV.weight', val[2*rows:], sc[2*rows:] if sc is not None else None)
            elif key.endswith('.txt_attn.qkv.weight'):
                i=block_idx(key,'double_blocks.'); rows=val.shape[0]//3
                e(f'transformerBlocks.{i}.attn.addQProj.weight', val[0:rows], sc[0:rows] if sc is not None else None)
                e(f'transformerBlocks.{i}.attn.addKProj.weight', val[rows:2*rows], sc[rows:2*rows] if sc is not None else None)
                e(f'transformerBlocks.{i}.attn.addVProj.weight', val[2*rows:], sc[2*rows:] if sc is not None else None)
            elif key.endswith('.img_attn.proj.weight'):
                e(f'transformerBlocks.{block_idx(key,"double_blocks.")}.attn.toOut.weight')
            elif key.endswith('.txt_attn.proj.weight'):
                e(f'transformerBlocks.{block_idx(key,"double_blocks.")}.attn.toAddOut.weight')
            elif key.endswith('.img_attn.norm.query_norm.scale'):
                e(f'transformerBlocks.{block_idx(key,"double_blocks.")}.attn.normQ.weight')
            elif key.endswith('.img_attn.norm.key_norm.scale'):
                e(f'transformerBlocks.{block_idx(key,"double_blocks.")}.attn.normK.weight')
            elif key.endswith('.txt_attn.norm.query_norm.scale'):
                e(f'transformerBlocks.{block_idx(key,"double_blocks.")}.attn.normAddedQ.weight')
            elif key.endswith('.txt_attn.norm.key_norm.scale'):
                e(f'transformerBlocks.{block_idx(key,"double_blocks.")}.attn.normAddedK.weight')
            elif key.endswith('.img_mlp.0.weight'):
                e(f'transformerBlocks.{block_idx(key,"double_blocks.")}.ff.activation.proj.weight')
            elif key.endswith('.img_mlp.2.weight'):
                e(f'transformerBlocks.{block_idx(key,"double_blocks.")}.ff.linearOut.weight')
            elif key.endswith('.txt_mlp.0.weight'):
                e(f'transformerBlocks.{block_idx(key,"double_blocks.")}.ffContext.activation.proj.weight')
            elif key.endswith('.txt_mlp.2.weight'):
                e(f'transformerBlocks.{block_idx(key,"double_blocks.")}.ffContext.linearOut.weight')
            elif key.startswith('single_blocks.') and key.endswith('.linear1.weight'):
                e(f'singleTransformerBlocks.{block_idx(key,"single_blocks.")}.attn.toQkvMlp.weight')
            elif key.startswith('single_blocks.') and key.endswith('.linear2.weight'):
                e(f'singleTransformerBlocks.{block_idx(key,"single_blocks.")}.attn.toOut.weight')
            elif key.startswith('single_blocks.') and key.endswith('.norm.query_norm.scale'):
                e(f'singleTransformerBlocks.{block_idx(key,"single_blocks.")}.attn.normQ.weight')
            elif key.startswith('single_blocks.') and key.endswith('.norm.key_norm.scale'):
                e(f'singleTransformerBlocks.{block_idx(key,"single_blocks.")}.attn.normK.weight')
            elif key == 'img_in.weight': e('xEmbedder.weight')
            elif key == 'txt_in.weight': e('contextEmbedder.weight')
            elif key == 'time_in.in_layer.weight': e('timeGuidanceEmbed.timestepEmbedder.linear1.weight')
            elif key == 'time_in.out_layer.weight': e('timeGuidanceEmbed.timestepEmbedder.linear2.weight')
            elif key == 'double_stream_modulation_img.lin.weight': e('doubleStreamModulationImg.linear.weight')
            elif key == 'double_stream_modulation_txt.lin.weight': e('doubleStreamModulationTxt.linear.weight')
            elif key == 'single_stream_modulation.lin.weight': e('singleStreamModulation.linear.weight')
            elif key == 'final_layer.adaLN_modulation.1.weight':
                dim = val.shape[0]//2
                swapped = mx.concatenate([val[dim:], val[:dim]], axis=0)
                emit(out, 'normOut.linear.weight', swapped); copied += 1
            elif key == 'final_layer.linear.weight': e('projOut.weight')
            else:
                unmapped += 1
                if unmapped <= 12: print('unmapped', key)
            if n % 25 == 0:
                print(f'processed {n}/{len(keys)} out={len(out)} converted_layers={converted} copied={copied} unmapped={unmapped}', flush=True)
                gc.collect()
    tmp = Path(str(dst) + '.tmp')
    if tmp.exists(): tmp.unlink()
    if Path(str(tmp)+'.safetensors').exists(): Path(str(tmp)+'.safetensors').unlink()
    meta={'format':'swift-mapped-mlx-native-mxfp8','source':str(src),'converted_layers':str(converted),'copied':str(copied)}
    print(f'saving {len(out)} tensors to {tmp}', flush=True)
    mx.save_safetensors(str(tmp), out, metadata=meta)
    written = tmp if tmp.exists() else Path(str(tmp)+'.safetensors')
    written.replace(dst)
    print(f'done {dst} size={dst.stat().st_size} elapsed={time.time()-t0:.1f}s converted_layers={converted} copied={copied} unmapped={unmapped}')
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
