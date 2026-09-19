"""The hosted restoration lane's client, and the promises it makes about money.

This is the one lane in the studio where pressing a button moves money by
itself. A local render costs electricity and a rented box is billed for whether
anybody restores on it or not; here, each chunk is a purchase. So the things
worth testing are not the happy path — they are the promises around it:

  * nothing is uploaded without an account to charge, and the refusal says so;
  * the figure the panel SHOWED goes back as the ceiling, so a price that moved
    is refused rather than quietly charged;
  * a failure says that nothing was charged, because that is true and it is the
    first thing anybody wants to know;
  * a stop is a stop, not a failure with the chunks thrown away;
  * a chunk lands on disk whole or not at all, because the file it becomes is a
    checkpoint somebody paid for.

Nothing here touches the network: every request goes through an injected opener.
"""

import io
import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import cloud_restore


class FakeResponse(io.BytesIO):
    """Just enough of an http.client.HTTPResponse for urlopen's callers."""

    status = 200

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()
        return False


class FakeService:
    """A recording stand-in for the hosted gateway.

    Records every (method, path) so a test can assert the ORDER things happened
    in — which is most of what matters here: uploading before reserving, and
    deleting only after the bytes are safely on disk.
    """

    def __init__(self, *, steps=None, output=b"x" * 4096, submit_status=None):
        self.calls = []
        self.bodies = []
        self.steps = list(steps or [{"status": "complete", "frames": 30, "chargedUsd": 0.17}])
        self.output = output
        self.submit_status = submit_status

    def __call__(self, request, timeout=None):
        path = request.full_url.split(".dev", 1)[-1] or request.full_url
        path = path.split("workers.dev", 1)[-1] if "workers.dev" in request.full_url else path
        self.calls.append((request.get_method(), path))
        data = request.data
        if isinstance(data, (bytes, bytearray)):
            self.bodies.append(json.loads(data.decode("utf-8")))
        if path == "/v1/uploads":
            return FakeResponse(json.dumps({"ok": True, "uploadId": "up_1", "bytes": 4096}).encode())
        if path == "/v1/chunks":
            if self.submit_status:
                raise self.submit_status
            return FakeResponse(json.dumps({"ok": True, "chunk": {"id": "rst_1", "status": "queued"}}).encode())
        if path.endswith("/step"):
            record = self.steps.pop(0) if len(self.steps) > 1 else self.steps[0]
            return FakeResponse(json.dumps({"ok": True, "chunk": record}).encode())
        if path.endswith("/output"):
            if request.get_method() == "DELETE":
                return FakeResponse(json.dumps({"ok": True, "deleted": True}).encode())
            return FakeResponse(self.output)
        if path.endswith("/cancel"):
            return FakeResponse(json.dumps({"ok": True, "stopping": True}).encode())
        if path == "/health":
            return FakeResponse(json.dumps({"ok": True, "enabled": True, "configured": True}).encode())
        raise AssertionError(f"unexpected call to {path}")


def http_error(code, detail=""):
    import urllib.error

    return urllib.error.HTTPError(
        "https://example.invalid", code, "no", {},
        io.BytesIO(json.dumps({"ok": False, "error": detail}).encode()),
    )


class RestoreChunkBase(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = self.root / "chunk.mp4"
        self.source.write_bytes(b"s" * 8192)
        self.destination = self.root / "out-0000.mp4"
        self.body = {"frames": 30, "width": 1920, "height": 1080, "model": "m"}

    def restore(self, service, **kwargs):
        return cloud_restore.restore_chunk(
            source=self.source,
            destination=self.destination,
            request_body=self.body,
            token=kwargs.pop("token", "hmos_credit_abc"),
            maximum_debit_usd=kwargs.pop("maximum_debit_usd", 0.20),
            opener=service,
            sleeper=lambda _seconds: None,
            **kwargs,
        )


class NothingIsSentWithoutSomethingToChargeIt(RestoreChunkBase):
    def test_no_account_means_no_upload_at_all(self):
        service = FakeService()
        with self.assertRaises(cloud_restore.CloudRestoreError) as caught:
            self.restore(service, token="")
        self.assertEqual(caught.exception.remedy, "connect")
        self.assertEqual(service.calls, [], "not one byte may leave without an account")

    def test_a_zero_ceiling_is_a_programming_error_not_a_free_render(self):
        with self.assertRaises(ValueError):
            self.restore(FakeService(), maximum_debit_usd=0)


class TheOrderOfOperationsIsThePromise(RestoreChunkBase):
    def test_upload_then_submit_then_poll_then_fetch_then_forget(self):
        service = FakeService()
        result = self.restore(service)
        self.assertEqual(
            service.calls,
            [
                ("POST", "/v1/uploads"),
                ("POST", "/v1/chunks"),
                ("POST", "/v1/chunks/rst_1/step"),
                ("GET", "/v1/chunks/rst_1/output"),
                ("DELETE", "/v1/chunks/rst_1/output"),
            ],
        )
        self.assertEqual(result["frames"], 30)
        self.assertEqual(result["charged_usd"], 0.17)

    def test_the_footage_is_forgotten_only_after_it_is_safely_on_disk(self):
        service = FakeService()
        self.restore(service)
        fetched = service.calls.index(("GET", "/v1/chunks/rst_1/output"))
        deleted = service.calls.index(("DELETE", "/v1/chunks/rst_1/output"))
        self.assertLess(fetched, deleted)
        self.assertTrue(self.destination.is_file())

    def test_the_approved_ceiling_and_an_idempotency_key_ride_along(self):
        service = FakeService()
        self.restore(service, maximum_debit_usd=0.25)
        submit = service.bodies[0]
        self.assertEqual(submit["maximum_debit_usd"], 0.25)
        self.assertEqual(submit["upload_id"], "up_1")
        # Required by the service, and the reason a retry is not a second
        # reservation against the same intent.
        self.assertTrue(submit["idempotency_key"])

    def test_a_polling_job_is_waited_out_rather_than_abandoned(self):
        service = FakeService(steps=[
            {"status": "queued"},
            {"status": "running"},
            {"status": "complete", "frames": 30, "chargedUsd": 0.17},
        ])
        self.restore(service)
        self.assertEqual([call for call in service.calls if call[1].endswith("/step")].__len__(), 3)


class WhatAFailureHasToSay(RestoreChunkBase):
    def test_a_failed_chunk_says_nothing_was_charged(self):
        service = FakeService(steps=[{"status": "failed", "error": "the GPU ran out of memory"}])
        with self.assertRaises(cloud_restore.CloudRestoreError) as caught:
            self.restore(service)
        self.assertIn("ran out of memory", str(caught.exception))
        self.assertIn("nothing was charged", str(caught.exception))
        self.assertFalse(self.destination.exists())

    def test_an_empty_balance_is_a_bill_not_a_crash(self):
        service = FakeService(submit_status=http_error(402, "Balance too low. Top up to continue."))
        with self.assertRaises(cloud_restore.CloudRestoreError) as caught:
            self.restore(service)
        self.assertEqual(caught.exception.remedy, "top-up")
        self.assertIn("Top up", str(caught.exception))

    def test_a_switched_off_service_points_at_the_other_two_machines(self):
        service = FakeService(submit_status=http_error(503, ""))
        with self.assertRaises(cloud_restore.CloudRestoreError) as caught:
            self.restore(service)
        self.assertEqual(caught.exception.remedy, "retry")
        self.assertIn("rented machine", str(caught.exception))


class AStopIsAStop(RestoreChunkBase):
    def test_it_cancels_upstream_and_says_stopped(self):
        service = FakeService(steps=[{"status": "running"}])
        with self.assertRaises(cloud_restore.CloudRestoreError) as caught:
            self.restore(service, should_cancel=lambda: True)
        # The runner turns exactly this word into its own cancel, which is what
        # keeps the finished chunks and offers resume instead of an error.
        self.assertEqual(str(caught.exception), "stopped")
        self.assertIn(("POST", "/v1/chunks/rst_1/cancel"), service.calls)


class AChunkLandsWholeOrNotAtAll(RestoreChunkBase):
    def test_a_truncated_download_is_refused_rather_than_checkpointed(self):
        # The file this becomes is a checkpoint somebody paid for. Half of one,
        # left in place, would be skipped by the resume as "already done".
        service = FakeService(output=b"tiny")
        with self.assertRaises(cloud_restore.CloudRestoreError):
            self.restore(service)
        self.assertFalse(self.destination.exists())
        self.assertFalse(list(self.destination.parent.glob("*.part")))

    def test_the_bytes_that_arrive_are_the_bytes_written(self):
        service = FakeService(output=b"z" * 9001)
        self.restore(service)
        self.assertEqual(self.destination.read_bytes(), b"z" * 9001)


class EveryRequestNamesItself(RestoreChunkBase):
    """A missing User-Agent is a 403 nobody would ever guess from the logs.

    MEASURED against the deployed worker on 2026-09-01: Cloudflare answers 403
    to urllib's default `Python-urllib/3.11`, in front of our own worker, before
    the request reaches a line of its code. The symptom is the hosted lane being
    permanently "could not be reached" while every unit test passes and curl
    works — which is exactly the shape of bug that survives to production.
    """

    def test_the_json_upload_and_download_calls_all_carry_one(self):
        service = FakeService()
        seen = []
        original = service.__call__

        def watching(request, timeout=None):
            seen.append((request.full_url, request.get_header("User-agent")))
            return original(request, timeout=timeout)

        self.restore(watching)
        self.assertTrue(seen)
        for url, agent in seen:
            self.assertTrue(agent, f"{url} was sent without a User-Agent")
            self.assertNotIn("urllib", agent.lower())
            self.assertIn("HivemindContentStudio", agent)


class AskingWhetherItIsOnNeverThrows(unittest.TestCase):
    def test_a_healthy_service_is_available(self):
        self.assertTrue(cloud_restore.status(opener=FakeService())["available"])

    def test_an_unreachable_service_is_one_unavailable_lane(self):
        def dead(request, timeout=None):
            raise OSError("no route to host")

        health = cloud_restore.status(opener=dead)
        self.assertFalse(health["available"])
        self.assertTrue(health["reason"], "an unavailable lane has to say why")

    def test_a_switched_off_service_says_which_of_the_two_it_is(self):
        def off(request, timeout=None):
            return FakeResponse(json.dumps({"ok": True, "enabled": False, "configured": True}).encode())

        self.assertIn("switched off", cloud_restore.status(opener=off)["reason"])


if __name__ == "__main__":
    unittest.main()
