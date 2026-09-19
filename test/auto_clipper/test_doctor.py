from __future__ import annotations

from auto_clipper.doctor import collect_checks


def test_doctor_redacts_postiz_api_key(cfg):
    cfg = cfg.__class__(**{**cfg.__dict__, "postiz_api_key": "postiz-secret"})
    checks = collect_checks(cfg)
    assert checks["postiz"]["api_key"] == "set"
    assert "postiz-secret" not in str(checks)



def _fake_install(root, *, gated: bool):
    """A minimal podcli tree: the executable plus the file carrying the gate."""
    root.mkdir(parents=True, exist_ok=True)
    binary = root / "podcli"
    binary.write_text("#!/bin/bash\n", encoding="utf-8")
    binary.chmod(0o755)
    services = root / "backend" / "services"
    services.mkdir(parents=True, exist_ok=True)
    body = "def _run_ai_command(...):\n"
    if gated:
        body += '    if os.environ.get("PODCLI_ALLOW_AI_CLI", "") not in {"1"}:\n        return None\n'
    (services / "claude_suggest.py").write_text(body, encoding="utf-8")
    return binary


def test_doctor_confirms_the_transcript_egress_gate(cfg, tmp_path):
    import dataclasses

    from auto_clipper.doctor import collect_checks

    binary = _fake_install(tmp_path / "podcli-install", gated=True)
    checks = collect_checks(dataclasses.replace(cfg, podcli_bin=str(binary)))

    assert checks["podcli"]["ok"] is True
    assert checks["podcli"]["ai_cli_gate"] is True


def test_doctor_fails_an_ungated_podcli_install(cfg, tmp_path):
    """An install that skipped the patch is a silent transcript-egress path."""
    import dataclasses

    from auto_clipper.doctor import collect_checks

    binary = _fake_install(tmp_path / "podcli-install", gated=False)
    checks = collect_checks(dataclasses.replace(cfg, podcli_bin=str(binary)))

    assert checks["podcli"]["ok"] is False
    assert checks["podcli"]["ai_cli_gate"] is False
    assert "UNGATED" in checks["podcli"]["detail"]
    assert checks["overall_ok"] is False
