"""Which names this studio answers to, and which header proves the proxy.

Moved out of control_api.py unchanged (2026-09-04) so the account boundary in
control_api.py and the WebAuthn relying party in ``context.py`` can both read
them without one importing the other.
"""

from __future__ import annotations

import urllib.parse

# The only names this studio answers to. A page on any other origin can point
# its own DNS name at 127.0.0.1 and reach this port; the browser then treats it
# as same-origin and the request looks local in every way but one — the Host
# header still carries the attacker's name. That is the whole check.
_LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "[::1]")
_LOOPBACK_NAMES = frozenset({"127.0.0.1", "localhost", "::1"})
_SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})

# Header the tailnet HTTPS proxy presents to prove it is the proxy. Without it
# x-forwarded-proto/host/for are just headers any caller can write, and three
# things were derived from them: the session cookie's `secure` flag, the
# WebAuthn relying-party id, and the login throttle's key. Generated per stack
# run and handed to both ends by scripts/hivemind-studio-stack.
PROXY_SECRET_ENV = "CONTENT_STUDIO_PROXY_SECRET"
PROXY_SECRET_HEADER = "x-studio-proxy-secret"


def _host_name(value: str) -> str:
    """The bare name in a Host header, an Origin, or a bare authority.

    No port, no brackets, lower-cased — so "[::1]:8765", "https://LOCALHOST:8789"
    and "127.0.0.1" all reduce to something comparable.
    """
    candidate = value.strip()
    if not candidate:
        return ""
    if "://" not in candidate:
        candidate = "//" + candidate
    try:
        return (urllib.parse.urlsplit(candidate).hostname or "").lower()
    except ValueError:
        return ""
