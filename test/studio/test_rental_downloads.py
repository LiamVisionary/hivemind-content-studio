"""The rental download library, run as real bash against a server that
misbehaves the way R2 and rented links do.

gpu_rentals._download_lib_lines() is the very bash every rented box runs in
its onstart. These tests source it unchanged — only the knobs differ (a small
split so a 3MB blob fans out into parts, few attempts, no pause) — and assert
on what lands on disk and on what the server saw.

Why this exists (2026-08-22): rental vast:48337699 died at 6/7 with a healthy
host and link because (1) the length probe was a HEAD, which R2 answers 403
on a GET-presigned URL, so every R2 weight rode ONE connection, and (2) that
connection's failure was one curl's --retry does not cover and could not
resume. Each test below pins one of the behaviours that replaced that.
"""
from __future__ import annotations

import hashlib
import http.server
import random
import re
import socketserver
import subprocess
import threading
import urllib.parse
from pathlib import Path

import pytest

from hivemind_content_studio import gpu_rentals

BLOB = random.Random(20260822).randbytes(3 * 1024 * 1024 + 12_345)
SHA = hashlib.sha256(BLOB).hexdigest()
CONNS = gpu_rentals.DOWNLOAD_CONNECTIONS
CHUNK = -(-len(BLOB) // CONNS)  # the library's ceil(len / n)
SPLIT = 256 * 1024  # well under CHUNK, so the blob is split like a real weight


def _part_range(i: int) -> tuple[int, int]:
    return i * CHUNK, min((i + 1) * CHUNK - 1, len(BLOB) - 1)


class _Faults:
    """Per-server knobs and the request log, shared across handler threads."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.log: list[tuple[str, str, str | None]] = []  # (method, path, Range)
        self.head_status = 403  # what R2 says to a HEAD on a GET presign
        self.cut_once: dict[int, int] = {}  # range start -> bytes served before closing, first time
        self.cut_window: tuple[int, int, int] | None = None  # (lo, hi, bytes): every request starting in [lo, hi)
        self.flaky_left = 0  # 503s still to serve to ranged requests that do not start at 0


class _Handler(http.server.BaseHTTPRequestHandler):
    # One connection per request, closed by the server afterwards: a response
    # shorter than its declared length is then "transfer closed with N bytes
    # remaining" — curl exit 18, which --retry never covered.
    protocol_version = "HTTP/1.0"

    def log_message(self, *_args) -> None:  # keep pytest output clean
        pass

    @property
    def faults(self) -> _Faults:
        return self.server.faults  # type: ignore[attr-defined]

    def _note(self) -> str:
        path = urllib.parse.urlparse(self.path).path
        with self.faults.lock:
            self.faults.log.append((self.command, path, self.headers.get("Range")))
        return path

    def _empty(self, status: int) -> None:
        self.send_response(status)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_HEAD(self) -> None:
        self._note()
        self.send_response(self.faults.head_status)
        self.send_header("Content-Length", str(len(BLOB)))
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()

    def do_GET(self) -> None:
        path = self._note()
        f = self.faults
        rng = self.headers.get("Range")
        if path == "/missing":
            self._empty(404)
            return
        start, end = 0, len(BLOB) - 1
        honour = bool(rng) and path != "/noranges" and (path != "/proberange" or rng == "bytes=0-0")
        if honour:
            match = re.fullmatch(r"bytes=(\d+)-(\d*)", rng or "")
            assert match, rng
            start = int(match[1])
            end = min(int(match[2]) if match[2] else len(BLOB) - 1, len(BLOB) - 1)
            if start >= len(BLOB):
                self._empty(416)
                return
        if path == "/flaky" and start > 0:
            with f.lock:
                flaky, f.flaky_left = f.flaky_left > 0, max(0, f.flaky_left - 1)
            if flaky:
                self._empty(503)
                return
        if honour:
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{len(BLOB)}")
        else:
            self.send_response(200)
        body = BLOB[start:end + 1]
        with f.lock:
            cut = f.cut_once.pop(start, None)
            if cut is None and f.cut_window and f.cut_window[0] <= start < f.cut_window[1]:
                cut = f.cut_window[2]
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()
        self.wfile.write(body if cut is None else body[:cut])


class _Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


@pytest.fixture
def server():
    srv = _Server(("127.0.0.1", 0), _Handler)
    srv.faults = _Faults()  # type: ignore[attr-defined]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        yield srv
    finally:
        srv.shutdown()
        srv.server_close()


def _url(srv, path: str = "/blob") -> str:
    return f"http://127.0.0.1:{srv.server_address[1]}{path}"


def _ranges(srv) -> list[str]:
    return [rng for _m, _p, rng in srv.faults.log if rng]


def _run(tail: str, cwd: Path, **knobs) -> subprocess.CompletedProcess:
    settings = dict(split=SPLIT, tries=3, pause=0, poll=0.2, floor=1024, stall=30)
    settings.update(knobs)
    lib = "\n".join(gpu_rentals._download_lib_lines(**settings))
    return subprocess.run(
        ["bash", "-c", lib + "\n" + tail], cwd=cwd, capture_output=True, text=True, timeout=120
    )


def _pget(srv, tmp_path: Path, path: str = "/blob", **knobs):
    dest = tmp_path / "model.safetensors"
    proc = _run(f'pget "{_url(srv, path)}" "{dest}"', tmp_path, **knobs)
    return proc, dest


def _err(dest: Path) -> Path:
    return Path(f"{dest}.err")


# --- pget ------------------------------------------------------------------

def test_pget_splits_the_object_without_ever_sending_a_head(server, tmp_path: Path) -> None:
    """R2 answers 403 to a HEAD on a GET-presigned URL (measured 2026-08-22).
    The length therefore comes from a one-byte ranged GET, or every R2 weight
    quietly rides one connection — which is how a 5GB VAE came to be the only
    thing standing between a rented 5090 and ready."""
    proc, dest = _pget(server, tmp_path)
    assert proc.returncode == 0, proc.stderr
    assert hashlib.sha256(dest.read_bytes()).hexdigest() == SHA
    assert {m for m, _p, _r in server.faults.log} == {"GET"}, "never HEAD a GET presign"
    ranges = _ranges(server)
    assert ranges[0] == "bytes=0-0", "the length comes from a one-byte ranged GET"
    for i in range(CONNS):
        s, e = _part_range(i)
        assert f"bytes={s}-{e}" in ranges, f"part {i} was not fetched as its own stream"
    assert not list(tmp_path.glob("*.part*")) and not _err(dest).exists()


def test_a_stream_cut_mid_transfer_resumes_from_its_own_offset(server, tmp_path: Path) -> None:
    """curl's own --retry re-sends a bare GET (no Range) and truncates the
    output to zero, and does not fire on an early close at all — measured
    2026-08-22. The library retries every failure and asks for exactly the
    bytes it does not have yet."""
    s, e = _part_range(3)
    server.faults.cut_once[s] = 10_000
    proc, dest = _pget(server, tmp_path)
    assert proc.returncode == 0, proc.stderr
    assert hashlib.sha256(dest.read_bytes()).hexdigest() == SHA
    ranges = _ranges(server)
    assert f"bytes={s}-{e}" in ranges
    assert f"bytes={s + 10_000}-{e}" in ranges, "the retry resumes; it does not restart"


def test_transient_server_errors_are_retried(server, tmp_path: Path) -> None:
    server.faults.flaky_left = 2
    proc, dest = _pget(server, tmp_path, path="/flaky")
    assert proc.returncode == 0, proc.stderr
    assert hashlib.sha256(dest.read_bytes()).hexdigest() == SHA
    # Two streams were told 503 once each and simply asked again.
    assert len(_ranges(server)) == 1 + CONNS + 2


def test_a_missing_object_fails_fast_and_says_so(server, tmp_path: Path) -> None:
    proc, dest = _pget(server, tmp_path, path="/missing")
    assert proc.returncode == 1
    assert not dest.exists()
    assert _err(dest).read_text().strip() == "http 404"
    # The probe and one attempt. A wrong URL is not a bad moment; no retry storm.
    assert len(server.faults.log) == 2


def test_a_server_that_gives_no_length_still_lands_the_file(server, tmp_path: Path) -> None:
    # No Content-Range anywhere: nothing to split or resume into, one plain stream.
    proc, dest = _pget(server, tmp_path, path="/noranges")
    assert proc.returncode == 0, proc.stderr
    assert hashlib.sha256(dest.read_bytes()).hexdigest() == SHA


def test_a_server_that_stops_honouring_ranges_falls_back_to_one_stream(server, tmp_path: Path) -> None:
    """The probe said 206, the parts came back 200 (an edge that ignores
    Range): the parts are discarded and the object is fetched whole, rather
    than eight copies of the file being glued together as one."""
    proc, dest = _pget(server, tmp_path, path="/proberange")
    assert proc.returncode == 0, proc.stderr
    assert hashlib.sha256(dest.read_bytes()).hexdigest() == SHA
    assert f"bytes=0-{len(BLOB) - 1}" in _ranges(server), "fell back to a single whole-file stream"
    assert not list(tmp_path.glob("*.part*"))


def test_a_stream_that_keeps_dying_reports_the_part_and_the_last_error(server, tmp_path: Path) -> None:
    s, e = _part_range(5)
    server.faults.cut_window = (s, e + 1, 1_000)  # every attempt of part 5 gets 1KB then the door
    proc, dest = _pget(server, tmp_path)
    assert proc.returncode == 1
    assert not dest.exists()
    # curl 18 = transfer closed with bytes remaining; http 206 = the range was honoured.
    assert _err(dest).read_text().strip() == "part 5: curl 18 http 206 after 3 tries"
    assert not list(tmp_path.glob("*.part*")), "nothing half-done is left to be counted"


# --- dlwait ----------------------------------------------------------------

def _dlwait(tmp_path: Path, jobs: str, deadline_offset: int = 600) -> subprocess.CompletedProcess:
    return _run(
        'beacon() { echo "$1|$2|$3" >> beacon.log; }\n'
        f"{jobs}\n"
        f"dlwait $(( $(date +%s) + {deadline_offset} )) a.bin b.bin\n",
        tmp_path,
    )


def _beacon_lines(tmp_path: Path) -> list[str]:
    return (tmp_path / "beacon.log").read_text().splitlines()


def test_dlwait_returns_once_every_file_has_landed(tmp_path: Path) -> None:
    proc = _dlwait(tmp_path, "( sleep 0.3; echo x > a.bin ) & ( echo y > b.bin ) &")
    assert proc.returncode == 0, proc.stderr
    lines = _beacon_lines(tmp_path)
    assert lines[-1] == "downloading|2|"
    assert all(line.startswith("downloading|") for line in lines)


def test_dlwait_names_the_file_and_the_cause_when_a_fetch_gives_up(tmp_path: Path) -> None:
    # Running jobs are sampled BEFORE the files are counted, so the one that
    # landed is counted and only the one that gave up is reported — the old
    # loop read them the other way round and could call a finished fetch a
    # failure if it finished between the two reads.
    proc = _dlwait(
        tmp_path,
        '( echo x > a.bin ) & ( echo "part 5: curl 18 http 206 after 3 tries" > b.bin.err ) &',
    )
    assert proc.returncode == 1
    assert _beacon_lines(tmp_path)[-1] == (
        "error|1|download failed at 1/2: b.bin (part 5: curl 18 http 206 after 3 tries)"
        " — destroy this machine and rent another"
    )


def test_dlwait_stalls_out_at_the_deadline_while_a_fetch_is_still_running(tmp_path: Path) -> None:
    proc = _dlwait(tmp_path, "( sleep 2; echo x > a.bin ) >/dev/null 2>&1 &", deadline_offset=-1)
    assert proc.returncode == 1
    minutes = gpu_rentals.DOWNLOAD_DEADLINE_SECONDS // 60
    assert _beacon_lines(tmp_path)[-1] == (
        f"error|0|download stalled {minutes}min at 0/2: a.bin — destroy this machine and rent another"
    )
