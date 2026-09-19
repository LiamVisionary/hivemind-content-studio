from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def test_frontend_timeout_never_restarts_an_active_generation_stack() -> None:
    stack = (ROOT / "scripts" / "hivemind-studio-stack").read_text()
    healthy = stack.split("healthy() {", 1)[1].split("supervise() {", 1)[0]

    assert "frontend health soft-failed" in healthy
    assert "generation stack will not be restarted" in healthy
    assert '[ "$ZIMG_FRONTEND_HEALTH_SOFT_FAILS" -lt 6 ] || return 1' not in healthy
