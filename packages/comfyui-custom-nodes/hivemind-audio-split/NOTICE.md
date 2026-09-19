# hivemind-audio-split — notices

This pack is part of Hivemind Content Studio (AGPL-3.0-or-later). Everything
outside `tiger/` is this repository's own work.

## `tiger/` — TIGER (MIT)

`tiger/tiger.py`, `tiger/tiger_dnr.py`, `tiger/layers/activations.py` and
`tiger/layers/normalizations.py` are from **TIGER** — *Time-frequency
Interleaved Gain Extraction and Reconstruction for Efficient Speech Separation*,
Mohan Xu, Kai Li, Guo Chen, Xiaolin Hu (ICLR 2025) —
<https://github.com/JusperLee/TIGER>, **MIT**, © Kai Li. The licence text is
`tiger/LICENSE`, verbatim.

They were taken from the copy in
[billwuhao/ComfyUI_AudioTools](https://github.com/billwuhao/ComfyUI_AudioTools)
at `41463715b476aa1d44de617119a68d8841aa04bd` (**Apache-2.0**), which is where
the idea of running these two models as ComfyUI nodes comes from. Compared
file-for-file on 2026-09-18, that copy's four files are identical to upstream
TIGER's apart from trailing whitespace, so the code here is TIGER's MIT code;
none of AudioTools' own node code was copied.

Each vendored file opens with a header listing what was changed, which is only
this: construction-time debug prints removed; `.type(input.type())` replaced
with `.to(dtype=…)` and `F.adaptive_avg_pool1d` routed through `mps_pool.py`,
both so the models run on an Apple GPU; and the relative import of `layers`
adjusted to this layout. `tiger/base_model.py`, `tiger/__init__.py` and
`tiger/layers/__init__.py` are this repository's own, written to drop upstream's
`huggingface_hub`, `pytorch_lightning` and `torch_complex` imports.

## Weights — not included

`JusperLee/TIGER-DnR` and `JusperLee/TIGER-speech` on Hugging Face, both
**Apache-2.0**. They are downloaded to the owner's machine on first use by the
studio's gateway (`packages/media-gateway/audio_split.py` pins each to a
revision and a SHA-256) and are never redistributed from this repository.
