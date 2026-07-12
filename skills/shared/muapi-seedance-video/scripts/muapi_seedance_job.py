#!/usr/bin/env python3
"""Small MUAPI Seedance helper for uploads, generation, polling, and downloads.

Run through shared env:
  hive-env-run -- python3 scripts/muapi_seedance_job.py upload ref.jpg --state state.json
  hive-env-run -- python3 scripts/muapi_seedance_job.py submit --endpoint seedance-2.0-omni-reference --payload payload.json --download out.mp4
"""

from __future__ import annotations

import argparse
import mimetypes
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any


BASE_URL = "https://api.muapi.ai/api/v1"


def api_key() -> str:
    key = os.environ.get("MUAPI_API_KEY")
    if not key:
        raise SystemExit("MUAPI_API_KEY is missing. Run through hive-env-run or set it in env.")
    return key


def headers(json_content: bool = True) -> dict[str, str]:
    result = {"x-api-key": api_key()}
    if json_content:
        result["Content-Type"] = "application/json"
    return result


def load_state(path: Path | None) -> dict[str, Any]:
    if not path or not path.exists():
        return {"uploads": {}, "requests": {}}
    return json.loads(path.read_text())


def save_state(path: Path | None, state: dict[str, Any]) -> None:
    if not path:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n")


def print_json(value: Any) -> None:
    print(json.dumps(value, indent=2, sort_keys=True))


def read_error_body(error: urllib.error.HTTPError) -> str:
    try:
        return error.read().decode("utf-8", errors="replace")[:2000]
    except Exception:
        return ""


def request_json(method: str, url: str, payload: dict[str, Any] | None = None, timeout: int = 180) -> dict[str, Any]:
    data = None
    request_headers = headers(json_content=True)
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=data, headers=request_headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise SystemExit(f"HTTP {exc.code} {url}: {read_error_body(exc)}") from exc


def multipart_file_body(path: Path) -> tuple[bytes, str]:
    boundary = f"----muapi-seedance-{uuid.uuid4().hex}"
    content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    head = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{path.name}"\r\n'
        f"Content-Type: {content_type}\r\n\r\n"
    ).encode("utf-8")
    tail = f"\r\n--{boundary}--\r\n".encode("utf-8")
    return head + path.read_bytes() + tail, boundary


def extract_url(response: dict[str, Any]) -> str | None:
    for key in ("url", "file_url", "media_url"):
        if isinstance(response.get(key), str):
            return response[key]
    outputs = response.get("outputs")
    if isinstance(outputs, list) and outputs and isinstance(outputs[0], str):
        return outputs[0]
    video = response.get("video")
    if isinstance(video, dict) and isinstance(video.get("url"), str):
        return video["url"]
    return None


def upload_one(path: Path) -> dict[str, Any]:
    endpoint = f"{BASE_URL}/upload_file"
    body, boundary = multipart_file_body(path)
    request_headers = headers(json_content=False)
    request_headers["Content-Type"] = f"multipart/form-data; boundary={boundary}"
    request = urllib.request.Request(endpoint, data=body, headers=request_headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise SystemExit(f"Upload failed for {path}: HTTP {exc.code}: {read_error_body(exc)}") from exc
    url = extract_url(data)
    if not url:
        raise SystemExit(f"Upload response did not include a usable URL: {json.dumps(data)[:1000]}")
    return data


def submit(endpoint: str, payload: dict[str, Any]) -> dict[str, Any]:
    endpoint = endpoint.lstrip("/")
    return request_json("POST", f"{BASE_URL}/{endpoint}", payload=payload, timeout=180)


def get_result(request_id: str) -> dict[str, Any]:
    return request_json("GET", f"{BASE_URL}/predictions/{request_id}/result", timeout=90)


def wait_for_result(request_id: str, interval: int, timeout: int) -> dict[str, Any]:
    start = time.time()
    last_status = None
    while time.time() - start < timeout:
        result = get_result(request_id)
        status = result.get("status")
        if status != last_status:
            print(f"status={status}", file=sys.stderr)
            last_status = status
        if status in ("completed", "succeeded"):
            return result
        if status in ("failed", "error", "canceled", "cancelled"):
            raise SystemExit(json.dumps(result, indent=2, sort_keys=True))
        time.sleep(interval)
    raise SystemExit(f"Timed out waiting for {request_id} after {timeout}s")


def download_url(url: str, output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=300) as response, output_path.open("wb") as fh:
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                fh.write(chunk)
    except urllib.error.HTTPError as exc:
        raise SystemExit(f"Download failed: HTTP {exc.code}: {read_error_body(exc)}") from exc


def cmd_upload(args: argparse.Namespace) -> None:
    state = load_state(args.state)
    uploads = state.setdefault("uploads", {})
    results = []
    for raw in args.files:
        path = Path(raw).expanduser().resolve()
        data = upload_one(path)
        url = extract_url(data)
        uploads[str(path)] = {"url": url, "response": data}
        results.append({"path": str(path), "url": url, "response": data})
    save_state(args.state, state)
    print_json(results)


def cmd_submit(args: argparse.Namespace) -> None:
    payload = json.loads(args.payload.read_text())
    state = load_state(args.state)
    submitted = submit(args.endpoint, payload)
    request_id = submitted.get("request_id") or submitted.get("id")
    if not request_id:
        print_json(submitted)
        raise SystemExit("Submit response did not include request_id.")

    state.setdefault("requests", {})[request_id] = {
        "endpoint": args.endpoint,
        "payload_path": str(args.payload),
        "submitted": submitted,
    }
    save_state(args.state, state)

    if not args.wait and not args.download:
        print_json(submitted)
        return

    result = wait_for_result(request_id, args.interval, args.timeout)
    state["requests"][request_id]["result"] = result
    media_url = extract_url(result)
    if args.download:
        if not media_url:
            print_json(result)
            raise SystemExit("Completed result did not include an output URL to download.")
        download_url(media_url, args.download)
        state["requests"][request_id]["download"] = str(args.download)
    save_state(args.state, state)
    print_json({"request_id": request_id, "output_url": media_url, "download": str(args.download) if args.download else None, "result": result})


def cmd_result(args: argparse.Namespace) -> None:
    result = wait_for_result(args.request_id, args.interval, args.timeout) if args.wait else get_result(args.request_id)
    if args.download:
        media_url = extract_url(result)
        if not media_url:
            print_json(result)
            raise SystemExit("Result did not include an output URL to download.")
        download_url(media_url, args.download)
    print_json(result)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="MUAPI Seedance helper")
    parser.add_argument("--state", type=Path, default=None, help="Optional JSON state file.")
    sub = parser.add_subparsers(required=True)

    upload_parser = sub.add_parser("upload", help="Upload local media files.")
    upload_parser.add_argument("files", nargs="+")
    upload_parser.set_defaults(func=cmd_upload)

    submit_parser = sub.add_parser("submit", help="Submit a generation payload.")
    submit_parser.add_argument("--endpoint", required=True, help="Endpoint name without /api/v1, e.g. seedance-2.0-omni-reference")
    submit_parser.add_argument("--payload", required=True, type=Path)
    submit_parser.add_argument("--wait", action="store_true", default=True, help="Poll until completion. Enabled by default.")
    submit_parser.add_argument("--download", type=Path, default=None)
    submit_parser.add_argument("--interval", type=int, default=5)
    submit_parser.add_argument("--timeout", type=int, default=1200)
    submit_parser.set_defaults(func=cmd_submit)

    result_parser = sub.add_parser("result", help="Fetch or wait for a request result.")
    result_parser.add_argument("request_id")
    result_parser.add_argument("--wait", action="store_true")
    result_parser.add_argument("--download", type=Path, default=None)
    result_parser.add_argument("--interval", type=int, default=5)
    result_parser.add_argument("--timeout", type=int, default=1200)
    result_parser.set_defaults(func=cmd_result)
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
