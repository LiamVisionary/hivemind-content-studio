import os
import sys

from app.config import config
from app.utils.logging_utils import configure_terminal_logger


def _terminal_sink():
    """Where this process's engine logs go.

    stdout is right for the WebUI and wrong for anything whose stdout is a
    contract. `content-studio run resume` on a faceless run emitted the engine's
    loguru output — ANSI escapes and all — interleaved with the JSON an agent
    was meant to parse, so the command "succeeded" and its output would not
    load. Callers that own stdout set MPT_LOG_SINK=stderr before importing.
    """
    return sys.stderr if os.environ.get("MPT_LOG_SINK", "stdout").strip().lower() == "stderr" else sys.stdout


def __init_logger():
    # _log_file = utils.storage_dir("logs/server.log")
    _lvl = config.log_level

    configure_terminal_logger(
        _terminal_sink(),
        level=_lvl,
        colorize=True,
    )

    # logger.add(
    #     _log_file,
    #     level=_lvl,
    #     format=format_log_record,
    #     rotation="00:00",
    #     retention="3 days",
    #     backtrace=True,
    #     diagnose=True,
    #     enqueue=True,
    # )


__init_logger()
