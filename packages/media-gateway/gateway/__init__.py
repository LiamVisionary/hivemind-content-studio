"""The media gateway, as one module per subject.

`app.py` next to this package is still the entry point the stack launches and
the tests load; it imports these modules and nothing else. Each module owns its
own module-level state, and a cross-module reference is written `owner.name` so
it stays a late-bound lookup - patching the owning module reaches every caller.

The vendored workflow builders (krea2_identity_workflow, strength_hunt,
klein_character_sheet, smart_mask, ltx_director_*, video_restore,
cloud_restore) sit beside app.py rather than in here, so the gateway directory
goes on sys.path before any of them is imported.
"""
import sys
from pathlib import Path

_GATEWAY_DIR = str(Path(__file__).resolve().parents[1])
if _GATEWAY_DIR not in sys.path:
    sys.path.insert(0, _GATEWAY_DIR)
