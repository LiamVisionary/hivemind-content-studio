#!/usr/bin/env python3
"""The media gateway's entry point.

The gateway itself is `gateway/`, one module per subject. This file is what
`scripts/hivemind-studio-stack` launches (`python3 app.py`) and what the tests
load; it puts this directory on sys.path so `gateway` and the vendored workflow
builders beside it import, then hands over to gateway.runtime.main.

Every module is exposed as an attribute here (`app.lanes`, `app.media`, ...)
so a caller - a test, or purge_history_prompts.py - reaches a name through the
module that owns it.
"""
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent
if str(BASE) not in sys.path:
    sys.path.insert(0, str(BASE))

from gateway import (  # noqa: E402  (sys.path above is what makes this import work)
    config,
    history,
    lanes,
    models,
    loras,
    media,
    jobs,
    util,
    workflow_index,
    promptroutes,
    graphs,
    runners,
    restore,
    native_mlx,
    http,
    net,
    routes,
    runtime,
)
from gateway.runtime import main  # noqa: E402

__all__ = [
    "main",
    "config",
    "history",
    "lanes",
    "models",
    "loras",
    "media",
    "jobs",
    "util",
    "workflow_index",
    "promptroutes",
    "graphs",
    "runners",
    "restore",
    "native_mlx",
    "http",
    "net",
    "routes",
    "runtime",
]

if __name__ == "__main__":
    main()
