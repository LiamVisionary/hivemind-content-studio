"""Environment-backed construction for the durable approval ledger."""

from __future__ import annotations

import os

from .approval_ledger import ApprovalLedger
from .config import load_config


def load_approval_ledger(*, required: bool = True) -> ApprovalLedger | None:
    signing_secret = os.environ.get("CONTENT_STUDIO_APPROVAL_SIGNING_SECRET", "")
    operator_token = os.environ.get("CONTENT_STUDIO_OPERATOR_TOKEN", "")
    if len(signing_secret) < 32 or len(operator_token) < 12:
        if required:
            raise RuntimeError(
                "Approval operations require CONTENT_STUDIO_APPROVAL_SIGNING_SECRET (32+ chars) "
                "and CONTENT_STUDIO_OPERATOR_TOKEN (12+ chars)."
            )
        return None
    return ApprovalLedger(
        load_config().data_dir / "content-studio-approvals.sqlite3",
        signing_secret=signing_secret,
        operator_token=operator_token,
    )


def operator_token() -> str:
    token = os.environ.get("CONTENT_STUDIO_OPERATOR_TOKEN", "")
    if len(token) < 12:
        raise RuntimeError("CONTENT_STUDIO_OPERATOR_TOKEN (12+ chars) is required")
    return token
