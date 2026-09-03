"""Hivemind Content Studio public package."""

from importlib.metadata import PackageNotFoundError, version as _package_version

try:
    # One version, read from the installed distribution, so pyproject is the
    # only place it is written down. Three numbers used to disagree here.
    __version__ = _package_version("hivemind-content-studio")
except PackageNotFoundError:  # running from a source tree that was never installed
    __version__ = "0+unknown"
