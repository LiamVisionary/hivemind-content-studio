"""The studio's credential reads go through the broker when one is running.

This is the join between the two halves and it is easy to get silently wrong:
naming `stores=` on the request — which the studio did, to keep the suite off a
developer's real store — also skips the broker AND workspace scoping. Nothing
fails when that happens. The keys still arrive. The record just quietly has a
hole in it shaped like the studio.

The key names here are deliberately ones no provider uses. `apply_shared_hive_env()`
writes straight into `os.environ` and monkeypatch cannot undo what it did in an
earlier test, so a real provider name can already be ambient by the time this
file runs — and the process environment legitimately outranks the store. Written
against `OPENAI_API_KEY` these tests passed alone and failed in the suite.
"""

from __future__ import annotations

import time

import passbook
import passbook_access
import passbook_broker
import passbook_stamp
import pytest

from hivemind_content_studio import shared_env
from hivemind_content_studio.shared_env import enable_access_stamps

GRANTED_KEY = "PB_BROKER_TEST_GRANTED"
WITHHELD_KEY = "PB_BROKER_TEST_WITHHELD"
GRANTED_VALUE = "not-a-real-credential"


@pytest.fixture
def brokered_machine(tmp_path, monkeypatch):
    """A machine of our own, with a broker, and the suite's redirect lifted."""
    monkeypatch.setenv("HIVE_HOME", str(tmp_path / "hive"))
    # The autouse fixture points this at a path that does not exist so the suite
    # never touches a real store. Here HIVE_HOME already guarantees that, and
    # leaving the redirect on would skip the very code path under test.
    monkeypatch.delenv("HIVE_ENV_FILES", raising=False)
    monkeypatch.delenv("HIVE_WORKSPACE", raising=False)
    monkeypatch.delenv("APP_SANDBOX_CONTAINER_ID", raising=False)
    # Nothing may have put these in the process environment, because the process
    # environment wins over the store by design and would mask what we assert.
    for name in (GRANTED_KEY, WITHHELD_KEY):
        monkeypatch.delenv(name, raising=False)
    passbook.ensure(app="test")
    passbook.set_values({GRANTED_KEY: GRANTED_VALUE, WITHHELD_KEY: "also-not-real"})

    started = passbook_broker.start()
    if not started.get("ok"):
        pytest.skip(f"the broker would not start here: {started.get('detail')}")
    try:
        yield tmp_path / "hive"
    finally:
        passbook_broker.stop()


def test_a_studio_credential_read_is_recorded_by_the_broker(brokered_machine):
    passbook.set_recorder(None)

    value = shared_env.request_credential(GRANTED_KEY, reason="image render")

    assert value == GRANTED_VALUE
    rows = [row for row in passbook_stamp.read_stamps(limit=50)
            if row.get("app") == shared_env.APP_ID]
    assert rows, "the studio's read never reached the broker"
    assert rows[-1]["keys"] == [GRANTED_KEY]
    assert GRANTED_VALUE not in passbook_stamp.proof_path().read_text(encoding="utf-8")


def test_a_policy_can_hold_the_studio_to_the_keys_it_uses(brokered_machine):
    passbook_access.write_policy({
        "default": {"mode": "never"},
        "apps": {shared_env.APP_ID: {"keys": {GRANTED_KEY: {"mode": "always"}}}},
    })

    assert shared_env.request_credential(GRANTED_KEY) == GRANTED_VALUE
    assert shared_env.request_credential(WITHHELD_KEY) == "", "not a key the policy names"


def test_the_studio_waits_for_an_approval_and_then_gets_the_key(brokered_machine):
    """`ask` is the mode the studio's approval panel exists for."""
    import threading

    passbook_access.write_policy({
        "default": {"mode": "never"},
        "apps": {shared_env.APP_ID: {"keys": {GRANTED_KEY: {"mode": "ask"}}}},
    })

    box: dict = {}
    thread = threading.Thread(
        target=lambda: box.update(value=shared_env.request_credential(GRANTED_KEY, reason="render")),
        daemon=True)
    thread.start()

    deadline = time.monotonic() + 5
    waiting: list = []
    while time.monotonic() < deadline and not waiting:
        waiting = (passbook_broker._ask({"op": "pending"}) or {}).get("pending", [])
        time.sleep(0.02)
    assert waiting, "the studio's read never reached the approval queue"

    result = shared_env.resolve_request(waiting[0]["id"], approve=True, approved_by="passkey:test")
    thread.join(timeout=10)

    assert result["ok"]
    assert box.get("value") == GRANTED_VALUE


def test_an_unlock_stops_the_studio_being_asked(brokered_machine):
    passbook_access.write_policy({
        "default": {"mode": "never"},
        "apps": {shared_env.APP_ID: {"keys": {GRANTED_KEY: {"mode": "ask"}}}},
    })
    opened = shared_env.open_unlock(duration="1h", reason="batch render")

    assert opened["ok"]
    assert shared_env.request_credential(GRANTED_KEY) == GRANTED_VALUE, "an unlock suspends asking"

    shared_env.close_unlock("")
    assert passbook_access.sessions() == []


def test_the_studio_keeps_working_with_no_broker(brokered_machine):
    passbook_broker.stop()

    assert shared_env.request_credential(GRANTED_KEY) == GRANTED_VALUE


def test_the_suite_redirect_still_keeps_the_studio_off_a_real_store(tmp_path, monkeypatch):
    """The property the `stores=` argument was there for, kept."""
    monkeypatch.delenv(GRANTED_KEY, raising=False)
    monkeypatch.setenv("HIVE_ENV_FILES", str(tmp_path / "no-such.env"))

    assert shared_env.request_credential(GRANTED_KEY) == ""


def test_a_redirected_process_never_stamps_the_machines_real_ledger(tmp_path, monkeypatch):
    """A test run must not write to the machine's own access record.

    `enable_access_stamps()` installs a PROCESS-GLOBAL recorder, and
    `build_control_app()` calls it — so one `TestClient(build_control_app(...))`
    used to arm the real ledger for the rest of the pytest process. Every read
    after that was redirected by the suite to a store that does not exist, came
    back empty, and was stamped into the machine's real record as a DENIED read
    by this app: 45 rows per run, 37 of them for the same key. On the machine
    that is indistinguishable from an app hammering PassBook for a credential
    it has no grant for, which is what it was mistaken for.
    """
    monkeypatch.setenv("HIVE_ENV_FILES", str(tmp_path / "no-such.env"))
    passbook.set_recorder(None)

    assert enable_access_stamps() is False, "a redirected process armed the machine's ledger"

    shared_env.request_credential(GRANTED_KEY, reason="must leave no trace")

    assert passbook._RECORDER is None, "the redirected read had a recorder to write to"


def test_a_real_machine_process_still_stamps_its_reads(brokered_machine):
    """The guard above must not switch the ledger off on a real machine."""
    passbook.set_recorder(None)

    assert enable_access_stamps() is True
    assert passbook._RECORDER is not None


def test_no_two_routes_claim_the_same_path_and_method():
    """FastAPI keeps the first registration and silently ignores the second.

    `/api/passbook/access` was registered twice — once for the record, once for
    the rules — and nothing raised. One of the two panels simply received the
    other's data, which reads as a UI bug a long way from its cause. Naming
    mirrors the CLI now: `access` is the record, `policy` is the rules.
    """
    import inspect
    import re
    from collections import Counter
    from pathlib import Path

    from hivemind_content_studio import control_api

    # control_api.py keeps /healthz and /readyz; every other route lives in a
    # module under hivemind_content_studio/api/ and registers on an APIRouter.
    # Both spellings are read, so the guard still covers all 113 routes.
    sources = [inspect.getsource(control_api)]
    api_package = Path(control_api.__file__).parent / "api"
    sources += [path.read_text(encoding="utf-8") for path in sorted(api_package.glob("*.py"))]

    registered = [
        route
        for source in sources
        for route in re.findall(
            r'@(?:app|router)\.(get|post|put|delete|patch)\(\s*"([^"]+)"', source)
    ]
    duplicates = sorted(route for route, count in Counter(registered).items() if count > 1)

    assert not duplicates, f"these routes are registered more than once: {duplicates}"
    assert len(registered) > 100, "the route scan found almost nothing; the pattern has drifted"
