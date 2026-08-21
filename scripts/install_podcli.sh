#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="$ROOT/vendor"
TARGET="$VENDOR/podcli"
REPO="https://github.com/nmbrthirteen/podcli.git"
COMMIT="e204f983906fb2b56bf365396e509d5c2a8f2e69"

mkdir -p "$VENDOR"
if [ ! -d "$TARGET/.git" ]; then
  git clone "$REPO" "$TARGET"
fi

git -C "$TARGET" fetch --depth 1 origin "$COMMIT"
git -C "$TARGET" checkout --detach "$COMMIT"
git -C "$TARGET" apply "$ROOT/patches/podcli-ffmpeg8-ass-filter.patch"
git -C "$TARGET" apply "$ROOT/patches/podcli-remotion-caption-pages.patch"
# Podcli hands the whole transcript to `claude`/`codex` for clip selection
# whenever one is on PATH. This patch makes that opt-in (--ai-select) instead
# of the default, so a render cannot ship creator material off the machine by
# accident. Verify after install:
#   grep -n PODCLI_ALLOW_AI_CLI "$TARGET/backend/services/claude_suggest.py"
git -C "$TARGET" apply "$ROOT/patches/podcli-ai-select-default-off.patch"
chmod +x "$TARGET/podcli" "$TARGET/setup.sh"
mkdir -p "$TARGET/.podcli/presets"
cp "$ROOT/presets/auto-clipper-local.json" "$TARGET/.podcli/presets/auto-clipper-local.json"

cat <<MSG
Podcli pinned at $COMMIT.

Next manual setup step:
  cd "$TARGET"
  ./setup.sh --install

Then verify:
  PODCLI_BIN="$TARGET/podcli" auto-clipper doctor

Transcripts stay local unless you pass --ai-select. Confirm the gate is in place:
  grep -c PODCLI_ALLOW_AI_CLI "$TARGET/backend/services/claude_suggest.py"   # expect 1
MSG
