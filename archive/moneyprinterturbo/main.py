"""MoneyPrinterTurbo's own HTTP API entry point, archived.

The studio never starts this; the control plane in `src/hivemind_content_studio`
is the product's API. It is kept runnable against the engine in `app/` — see
archive/moneyprinterturbo/README.md.
"""

import os
import sys

# Archived under archive/moneyprinterturbo/, while the engine it serves stays at
# the repository root. Python puts this file's own directory on sys.path, not the
# root, so the root has to be added before `app` can be imported.
ROOT_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.realpath(__file__))))
if ROOT_DIR not in sys.path:
    sys.path.insert(0, ROOT_DIR)

import uvicorn
from loguru import logger

from app.config import config

if __name__ == "__main__":
    logger.info(
        "start server, docs: http://127.0.0.1:" + str(config.listen_port) + "/docs"
    )
    uvicorn.run(
        app="app.asgi:app",
        host=config.listen_host,
        port=config.listen_port,
        reload=config.reload_debug,
        log_level="warning",
    )
