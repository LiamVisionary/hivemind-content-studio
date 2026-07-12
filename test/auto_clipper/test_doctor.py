from __future__ import annotations

from auto_clipper.doctor import collect_checks


def test_doctor_redacts_postiz_api_key(cfg):
    cfg = cfg.__class__(**{**cfg.__dict__, "postiz_api_key": "postiz-secret"})
    checks = collect_checks(cfg)
    assert checks["postiz"]["api_key"] == "set"
    assert "postiz-secret" not in str(checks)

