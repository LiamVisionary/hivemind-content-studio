from __future__ import annotations

from pathlib import Path

import pytest

from hivemind_content_studio.approval_ledger import ApprovalLedger


def test_paid_action_approval_is_exact_scoped_and_single_use(tmp_path: Path) -> None:
    ledger = ApprovalLedger(tmp_path / "approvals.sqlite3", signing_secret="s" * 64, operator_token="operator-secret")
    request = ledger.request(run_id="run-1", kind="paid-generation", provider="muapi", amount_usd=2.5, target="scene-1", reason="Generate scene")
    receipt = ledger.approve(request["id"], operator_token="operator-secret", decided_by="owner")

    with pytest.raises(ValueError, match="scope"):
        ledger.consume(receipt["token"], run_id="run-1", kind="paid-generation", provider="higgsfield-cloud", amount_usd=2.5, target="scene-1")

    consumed = ledger.consume(receipt["token"], run_id="run-1", kind="paid-generation", provider="muapi", amount_usd=2.5, target="scene-1")
    assert consumed["status"] == "consumed"
    with pytest.raises(ValueError, match="already consumed"):
        ledger.consume(receipt["token"], run_id="run-1", kind="paid-generation", provider="muapi", amount_usd=2.5, target="scene-1")


def test_agents_cannot_self_approve_without_operator_token(tmp_path: Path) -> None:
    ledger = ApprovalLedger(tmp_path / "approvals.sqlite3", signing_secret="s" * 64, operator_token="operator-secret")
    request = ledger.request(run_id="run-2", kind="publish", provider="postiz", amount_usd=0, target="instagram", reason="Publish")

    with pytest.raises(PermissionError, match="operator"):
        ledger.approve(request["id"], operator_token="wrong", decided_by="agent")
    assert ledger.get(request["id"])["status"] == "pending"
