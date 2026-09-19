#!/usr/bin/env bash
# Install antirez/h3.c — the native Apple-silicon MiniMax H3 engine — as a
# separate program under vendor/, pinned, and build it.
#
# Nothing is vendored into this tree: h3.c is MIT, ~24k lines of C and Metal,
# and it moves fast upstream. Like Podcli it is cloned to the gitignored
# vendor/ at a pinned sha and invoked as its own process, never linked.
#
# What it needs: Xcode's clang (Metal 4 headers), ffmpeg + ffprobe on PATH,
# and an Apple-silicon Mac. The weights are a separate step — see
# scripts/assemble_h3c_model.py, which builds the model directory h3 expects
# out of a Hugging Face MiniMax-H3 snapshot without copying 70 GB.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="$ROOT/vendor"
TARGET="$VENDOR/h3.c"
REPO="https://github.com/antirez/h3.c.git"
# Pinned 2026-09-14. Raise it deliberately: the studio's preset table and the
# flags in packages/media-gateway/gateway/h3_native.py are written against this
# commit's CLI, and upstream adds and renames flags freely.
COMMIT="8974cc055ea9c02fcd14cc27dfda3e1027c05153"

if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
  echo "h3.c is an Apple-silicon Metal engine; this machine is $(uname -s)/$(uname -m)." >&2
  exit 1
fi

for tool in ffmpeg ffprobe; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "h3.c shells out to $tool for media I/O and it is not on PATH (brew install ffmpeg)." >&2
    exit 1
  }
done

mkdir -p "$VENDOR"
if [ ! -d "$TARGET/.git" ]; then
  git clone "$REPO" "$TARGET"
fi
git -C "$TARGET" fetch --depth 1 origin "$COMMIT"
git -C "$TARGET" checkout --detach "$COMMIT"
# LoRA support: adapters are fused into the DiT's BF16 weights as they load
# (h3_lora.c, --lora/--lora-strength). Upstream has no LoRA runtime
# (antirez/h3.c#37), and its one proposal folds a LoRA into a cloned checkpoint
# offline (#14), which cannot take a per-render strength. Applied only when it
# is not already, so re-running this script is safe. Verify after install:
#   "$TARGET/h3" --help 2>&1 | grep -- --lora-strength
PATCH="$ROOT/patches/h3c-lora.patch"
if ! git -C "$TARGET" apply --reverse --check "$PATCH" 2>/dev/null; then
  git -C "$TARGET" apply "$PATCH"
fi

make -C "$TARGET" -j"$(sysctl -n hw.ncpu)"

cat <<MSG

h3.c pinned at $COMMIT with patches/h3c-lora.patch, and built: $TARGET/h3

Next, point it at weights. If a Hugging Face MiniMax-H3 snapshot is already on
this machine (the MLX port keeps one), link it into h3's layout rather than
downloading another 70 GB:

  python3 "$ROOT/scripts/assemble_h3c_model.py" --from <snapshot> --check

Then verify the engine sees the machine and the checkpoint:

  "$TARGET/h3" --info -d ~/comfy/mlx-models/minimax-h3/h3c-model

The studio finds both on its own; H3C_BIN and H3C_MODEL_DIR override the
default locations (set them in stack-local.env, not in the stack script).
MSG
