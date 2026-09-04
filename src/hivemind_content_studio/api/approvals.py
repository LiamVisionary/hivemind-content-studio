"""The approval ledger an operator acts on.

Moved out of control_api.py unchanged (2026-09-04).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from .models import DecisionBody


def register(app, ctx) -> None:
    """Register the approval routes."""
    router = APIRouter()
    approvals = ctx.approvals
    configured_operator_token = ctx.configured_operator_token
    require_control = ctx.require_control

    @router.get("/api/approvals", dependencies=[Depends(require_control)])
    def list_approvals(run_id: str = "", status: str = "") -> dict:
        if approvals is None:
            raise HTTPException(status_code=503, detail="Approval ledger is not configured")
        return {"ok": True, "approvals": approvals.list(run_id=run_id or None, status=status or None)}

    @router.post("/api/approvals/{approval_id}/approve", dependencies=[Depends(require_control)])
    def approve(approval_id: str, body: DecisionBody) -> dict:
        if approvals is None or len(configured_operator_token) < 12:
            raise HTTPException(status_code=503, detail="Approval ledger is not configured")
        return {"ok": True, "approval": approvals.approve(approval_id, operator_token=configured_operator_token, decided_by=body.decided_by)}

    @router.post("/api/approvals/{approval_id}/deny", dependencies=[Depends(require_control)])
    def deny(approval_id: str, body: DecisionBody) -> dict:
        if approvals is None or len(configured_operator_token) < 12:
            raise HTTPException(status_code=503, detail="Approval ledger is not configured")
        return {"ok": True, "approval": approvals.deny(approval_id, operator_token=configured_operator_token, decided_by=body.decided_by)}

    app.include_router(router)
