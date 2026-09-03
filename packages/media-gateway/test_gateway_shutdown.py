"""What the gateway owes the studio when it is stopped, and what /health owes everyone.

SIGTERM used to end the process mid-generation with nothing said: the native
MLX child was left holding the GPU, the in-memory job records went with the
process, and the studio's next poll asked about a job the gateway had never
heard of. /health, meanwhile, answered ok:true whether or not a single ComfyUI
lane was alive, which is how a dead engine reached the user as a 502 on their
first Generate instead of a sentence before it.
"""

import importlib.util
import json
import signal
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

BASE = Path(__file__).resolve().parent


def load_app():
    spec = importlib.util.spec_from_file_location('zimg_app_shutdown', BASE / 'app.py')
    app = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(app)
    return app


class AtomicStateWriteTests(unittest.TestCase):
    def test_state_files_are_replaced_whole_or_not_at_all(self):
        """The loaders read an unparseable file as "no jobs", so a truncated
        write is not a corrupt file — it is a silently emptied download queue."""
        app = load_app()
        with TemporaryDirectory() as td:
            target = Path(td) / 'download_jobs.json'
            target.write_text(json.dumps({'old': {'id': 'old'}}), encoding='utf-8')

            # A write that dies before os.replace leaves the previous file intact.
            with patch.object(app.os, 'replace', side_effect=OSError('interrupted')):
                with self.assertRaises(OSError):
                    app.write_json_atomic(target, {'new': {'id': 'new'}})
            self.assertEqual(json.loads(target.read_text(encoding='utf-8')), {'old': {'id': 'old'}})

            app.write_json_atomic(target, {'new': {'id': 'new'}}, indent=2)
            self.assertEqual(json.loads(target.read_text(encoding='utf-8')), {'new': {'id': 'new'}})
            # No temp files left behind for the next loader to trip over.
            self.assertEqual([p.name for p in Path(td).iterdir()], ['download_jobs.json'])

    def test_the_download_queue_round_trips_through_the_atomic_writer(self):
        app = load_app()
        with TemporaryDirectory() as td:
            target = Path(td) / 'download_jobs.json'
            with patch.object(app, 'DOWNLOAD_JOBS_FILE', target), \
                 patch.object(app, 'download_jobs', {'job-1': {'id': 'job-1', 'status': 'running'}}):
                app.save_download_jobs_unlocked()
                self.assertEqual(app.load_download_jobs(), {'job-1': {'id': 'job-1', 'status': 'running'}})


class ShutdownTests(unittest.TestCase):
    def test_running_jobs_are_marked_interrupted_and_written_where_a_poll_will_find_them(self):
        app = load_app()
        with TemporaryDirectory() as td:
            history = Path(td) / 'history.jsonl'
            jobs = {
                'local-1': {'id': 'local-1', 'status': 'running'},
                'queued-1': {'id': 'queued-1', 'status': 'queued'},
                'done-1': {'id': 'done-1', 'status': 'success'},
            }
            with patch.object(app, 'HISTORY_FILE', history), \
                 patch.object(app, 'jobs', jobs), \
                 patch.object(app, 'comfy_prompt_route', lambda _pid: None):
                interrupted = app.interrupt_in_flight_jobs()

            self.assertEqual(sorted(rec['id'] for rec in interrupted), ['local-1', 'queued-1'])
            self.assertEqual(jobs['done-1']['status'], 'success')
            self.assertEqual(jobs['local-1']['status'], 'interrupted')
            self.assertEqual(jobs['local-1']['error'], app.JOB_INTERRUPTED_MESSAGE)
            # history.jsonl is where find_job() looks after a restart, so this is
            # what turns the studio's next poll into a true answer with a retry.
            written = [json.loads(line) for line in history.read_text(encoding='utf-8').splitlines()]
            self.assertEqual(sorted(rec['status'] for rec in written), ['interrupted', 'interrupted'])

    def test_a_prompt_still_running_on_a_rented_lane_is_left_alone(self):
        """Its watcher is re-armed on the next boot and harvests the output then.
        A terminal history record would both lie and mask the live route."""
        app = load_app()
        with TemporaryDirectory() as td:
            history = Path(td) / 'history.jsonl'
            jobs = {'rented': {'id': 'rented', 'status': 'running', 'comfy_prompt_id': 'p-9'}}
            with patch.object(app, 'HISTORY_FILE', history), \
                 patch.object(app, 'jobs', jobs), \
                 patch.object(app, 'comfy_prompt_route',
                              lambda pid: {'remote': True, 'status': 'submitted'} if pid == 'p-9' else None):
                self.assertEqual(app.interrupt_in_flight_jobs(), [])

            self.assertEqual(jobs['rented']['status'], 'running')
            self.assertFalse(history.exists())

    def test_a_native_render_is_stopped_by_its_process_group(self):
        """The MLX runner spawns workers of its own; terminating only the parent
        leaves them on the GPU. The children are started in their own session
        precisely so the whole group can be signalled at once."""
        app = load_app()

        class FakeProc:
            def __init__(self, pid):
                self.pid = pid
                self.waited = False
            def poll(self):
                return None
            def wait(self, timeout=None):
                self.waited = True
                return 0

        proc = FakeProc(4242)
        killed = []
        with patch.object(app, 'native_job_procs', {'job-1': proc}), \
             patch.object(app.os, 'getpgid', lambda pid: pid), \
             patch.object(app.os, 'killpg', lambda pgid, sig: killed.append((pgid, sig))):
            stopped = app.terminate_native_job_processes(timeout=0.1)

        self.assertEqual(stopped, ['job-1'])
        self.assertEqual(killed, [(4242, signal.SIGTERM)])
        self.assertTrue(proc.waited)

    def test_installing_the_handlers_claims_sigterm_and_sigint(self):
        app = load_app()
        installed = {}
        with patch.object(app.signal, 'signal', lambda sig, handler: installed.__setitem__(sig, handler)):
            app.install_shutdown_handlers(server=None)
        self.assertEqual(sorted(installed, key=lambda s: s.value), sorted([signal.SIGINT, signal.SIGTERM], key=lambda s: s.value))


class HealthTests(unittest.TestCase):
    def _health(self, app, *, authed):
        handler = object.__new__(app.Handler)
        handler.path = '/health'
        captured = {}

        def send_json(payload, status=200):
            captured['payload'] = payload
            captured['status'] = status

        handler.send_json = send_json
        handler.authed = lambda _qs: authed
        app.Handler.do_GET(handler)
        return captured['payload']

    def test_health_names_the_lane_that_is_down_instead_of_claiming_everything_is_fine(self):
        app = load_app()
        lanes = {'default': 'http://127.0.0.1:8188', 'rental9': 'http://127.0.0.1:18337'}
        probes = {'default': None, 'rental9': 'ConnectionRefusedError: Connection refused'}
        with patch.object(app, 'COMFY_LANES', lanes), \
             patch.object(app, 'COMFY_REMOTE_LANES', {'rental9'}), \
             patch.object(app, 'refresh_comfy_lanes', lambda: None), \
             patch.object(app, '_lane_health_cache', {}), \
             patch.object(app, 'comfy_lane_probe_detail', lambda lane, timeout=2.0: probes[lane]):
            body = self._health(app, authed=True)

        # The process is up, so ok stays true — the supervisor's readiness gate
        # reads this endpoint and must not flap when a lane is merely off.
        self.assertTrue(body['ok'])
        self.assertEqual(body['version'], app.GATEWAY_VERSION)
        self.assertTrue(body['lanes']['default']['alive'])
        self.assertFalse(body['lanes']['rental9']['alive'])
        self.assertEqual(body['degraded'], ['rental9'])
        self.assertIn('Re-attach it in Machines', body['lanes']['rental9']['error'])
        self.assertEqual(body['lanes']['default']['url'], 'http://127.0.0.1:8188')

    def test_a_local_lane_that_is_off_says_how_to_start_it(self):
        app = load_app()
        with patch.object(app, 'COMFY_LANES', {'default': 'http://127.0.0.1:8188'}), \
             patch.object(app, 'COMFY_REMOTE_LANES', set()), \
             patch.object(app, 'refresh_comfy_lanes', lambda: None), \
             patch.object(app, '_lane_health_cache', {}), \
             patch.object(app, 'comfy_lane_probe_detail', lambda lane, timeout=2.0: 'ConnectionRefusedError: nope'):
            body = self._health(app, authed=False)

        self.assertEqual(body['degraded'], ['default'])
        self.assertIn('Start it from Machines', body['lanes']['default']['error'])
        # An unauthenticated caller learns a lane is degraded, not where a
        # rented machine lives.
        self.assertNotIn('url', body['lanes']['default'])

    def test_the_lane_probe_is_cached_so_a_burst_of_health_checks_costs_one_knock(self):
        app = load_app()
        calls = []
        with patch.object(app, 'COMFY_LANES', {'default': 'http://127.0.0.1:8188'}), \
             patch.object(app, 'COMFY_REMOTE_LANES', set()), \
             patch.object(app, '_lane_health_cache', {}), \
             patch.object(app, 'comfy_lane_probe_detail',
                          lambda lane, timeout=2.0: calls.append(lane) or None):
            for _ in range(5):
                app.comfy_lane_health('default')

        self.assertEqual(calls, ['default'])

    def test_the_local_lane_is_still_never_probed_on_the_prompt_path(self):
        """comfy_lane_liveness_error() guards submits and stays remote-only: a
        round trip before every local prompt is a cost with no answer, since the
        submit itself reports a missing local ComfyUI immediately."""
        app = load_app()
        with patch.object(app, 'COMFY_LANES', {'default': 'http://127.0.0.1:8188'}), \
             patch.object(app, 'COMFY_REMOTE_LANES', set()), \
             patch.object(app, 'urlopen', side_effect=AssertionError('must not probe the local lane')):
            self.assertIsNone(app.comfy_lane_liveness_error('default'))


if __name__ == '__main__':  # pragma: no cover
    unittest.main()
