#!/usr/bin/env python3
"""General MUAPI helper for uploads, async jobs, downloads, and schema lookup.

Run through shared env, for example:
  hive-env-run -- python3 scripts/muapi_general.py upload refs/source.png --state state.json
  hive-env-run -- python3 scripts/muapi_general.py submit --endpoint flux-dev-image --payload payload.json --wait --download out.png
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any


DEFAULT_BASE_URL = "https://api.muapi.ai/api/v1"
MEDIA_URL_KEYS = {
    "url",
    "file_url",
    "media_url",
    "output_url",
    "image_url",
    "video_url",
    "audio_url",
}
TERMINAL_SUCCESS = {"completed", "succeeded", "success"}
TERMINAL_FAILURE = {"failed", "error", "canceled", "cancelled", "nsfw"}


def api_key() -> str:
    key = os.environ.get("MUAPI_API_KEY") or os.environ.get("MUAPI_KEY")
    if not key:
        raise SystemExit("MUAPI_API_KEY or MUAPI_KEY is missing. Run through hive-env-run or set it in env.")
    return key


def base_url() -> str:
    return os.environ.get("MUAPI_BASE_URL", DEFAULT_BASE_URL).rstrip("/")


def headers(json_content: bool = True) -> dict[str, str]:
    result = {"x-api-key": api_key()}
    if json_content:
        result["Content-Type"] = "application/json"
        result["Accept"] = "application/json"
    return result


def endpoint_url(endpoint: str) -> str:
    if endpoint.startswith("http://") or endpoint.startswith("https://"):
        return endpoint
    cleaned = endpoint.strip().lstrip("/")
    if cleaned.startswith("api/v1/"):
        cleaned = cleaned[len("api/v1/") :]
    return f"{base_url()}/{cleaned}"


def read_error_body(error: urllib.error.HTTPError) -> str:
    try:
        return error.read().decode("utf-8", errors="replace")[:3000]
    except Exception:
        return ""


def request_json(method: str, url: str, payload: dict[str, Any] | None = None, timeout: int = 180) -> dict[str, Any]:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = urllib.request.Request(url, data=data, headers=headers(json_content=True), method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        raise SystemExit(f"HTTP {exc.code} {url}: {read_error_body(exc)}") from exc
    if not body:
        return {}
    return json.loads(body)


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


def looks_like_media_url(value: str) -> bool:
    return value.startswith("http://") or value.startswith("https://")


def collect_media_urls(value: Any) -> list[str]:
    urls: list[str] = []
    if isinstance(value, str) and looks_like_media_url(value):
        return [value]
    if isinstance(value, list):
        for item in value:
            urls.extend(collect_media_urls(item))
    elif isinstance(value, dict):
        for key, item in value.items():
            if key in MEDIA_URL_KEYS and isinstance(item, str) and looks_like_media_url(item):
                urls.append(item)
            else:
                urls.extend(collect_media_urls(item))
    seen: set[str] = set()
    deduped: list[str] = []
    for url in urls:
        if url not in seen:
            seen.add(url)
            deduped.append(url)
    return deduped


def first_media_url(value: Any) -> str | None:
    urls = collect_media_urls(value)
    return urls[0] if urls else None


def multipart_file_body(path: Path) -> tuple[bytes, str]:
    boundary = f"----muapi-general-{uuid.uuid4().hex}"
    content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    head = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{path.name}"\r\n'
        f"Content-Type: {content_type}\r\n\r\n"
    ).encode("utf-8")
    tail = f"\r\n--{boundary}--\r\n".encode("utf-8")
    return head + path.read_bytes() + tail, boundary


def upload_one(path: Path) -> dict[str, Any]:
    body, boundary = multipart_file_body(path)
    request_headers = headers(json_content=False)
    request_headers["Content-Type"] = f"multipart/form-data; boundary={boundary}"
    request = urllib.request.Request(endpoint_url("upload_file"), data=body, headers=request_headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise SystemExit(f"Upload failed for {path}: HTTP {exc.code}: {read_error_body(exc)}") from exc
    if not first_media_url(data):
        raise SystemExit(f"Upload response did not include a usable URL: {json.dumps(data)[:1000]}")
    return data


def get_result(request_id: str) -> dict[str, Any]:
    return request_json("GET", endpoint_url(f"predictions/{request_id}/result"), timeout=90)


def wait_for_result(request_id: str, interval: int, timeout: int) -> dict[str, Any]:
    start = time.time()
    last_status = None
    while time.time() - start < timeout:
        result = get_result(request_id)
        status = str(result.get("status", "")).lower()
        if status != last_status:
            print(f"status={status or 'unknown'}", file=sys.stderr)
            last_status = status
        if status in TERMINAL_SUCCESS:
            return result
        if status in TERMINAL_FAILURE:
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


def request_id_from(response: dict[str, Any]) -> str | None:
    for key in ("request_id", "id", "prediction_id"):
        value = response.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def cmd_upload(args: argparse.Namespace) -> None:
    state = load_state(args.state)
    uploads = state.setdefault("uploads", {})
    results = []
    for raw in args.files:
        path = Path(raw).expanduser().resolve()
        data = upload_one(path)
        media_url = first_media_url(data)
        uploads[str(path)] = {"url": media_url, "response": data}
        results.append({"path": str(path), "url": media_url, "response": data})
    save_state(args.state, state)
    print_json(results)


def cmd_submit(args: argparse.Namespace) -> None:
    payload = json.loads(args.payload.read_text())
    state = load_state(args.state)
    submitted = request_json(args.method, endpoint_url(args.endpoint), payload=payload, timeout=args.request_timeout)
    request_id = request_id_from(submitted)
    if not request_id:
        print_json(submitted)
        raise SystemExit("Submit response did not include a request_id.")

    state.setdefault("requests", {})[request_id] = {
        "endpoint": args.endpoint,
        "method": args.method,
        "payload_path": str(args.payload),
        "submitted": submitted,
    }
    save_state(args.state, state)

    should_wait = args.wait or args.download is not None
    if not should_wait:
        print_json(submitted)
        return

    result = wait_for_result(request_id, args.interval, args.timeout)
    state["requests"][request_id]["result"] = result
    media_urls = collect_media_urls(result)
    if args.download:
        if not media_urls:
            print_json(result)
            raise SystemExit("Completed result did not include an output URL to download.")
        download_url(media_urls[0], args.download)
        state["requests"][request_id]["download"] = str(args.download)
    save_state(args.state, state)
    print_json(
        {
            "request_id": request_id,
            "output_urls": media_urls,
            "download": str(args.download) if args.download else None,
            "result": result,
        }
    )


def cmd_result(args: argparse.Namespace) -> None:
    result = wait_for_result(args.request_id, args.interval, args.timeout) if args.wait else get_result(args.request_id)
    media_urls = collect_media_urls(result)
    if args.download:
        if not media_urls:
            print_json(result)
            raise SystemExit("Result did not include an output URL to download.")
        download_url(media_urls[0], args.download)
    print_json({"output_urls": media_urls, "result": result} if args.urls else result)


def cmd_download(args: argparse.Namespace) -> None:
    download_url(args.url, args.output)
    print_json({"url": args.url, "download": str(args.output)})


def load_schema(path: Path) -> list[dict[str, Any]]:
    data = json.loads(path.read_text())
    if not isinstance(data, list):
        raise SystemExit("Schema file must be a JSON list.")
    return [item for item in data if isinstance(item, dict)]


def schema_endpoint(item: dict[str, Any]) -> str | None:
    schema = item.get("input_schema")
    if not isinstance(schema, dict):
        return None
    schemas = schema.get("schemas")
    if not isinstance(schemas, dict):
        return None
    input_data = schemas.get("input_data")
    if not isinstance(input_data, dict):
        return None
    endpoint = input_data.get("endpoint_url")
    return endpoint if isinstance(endpoint, str) else None


def cmd_models(args: argparse.Namespace) -> None:
    items = load_schema(args.schema)
    query = (args.query or "").lower()
    category = (args.category or "").lower()
    matches = []
    for item in items:
        haystack = " ".join(
            str(item.get(key, "")) for key in ("name", "category", "variant", "family", "description")
        ).lower()
        if query and query not in haystack:
            continue
        if category and category != str(item.get("category", "")).lower():
            continue
        matches.append(
            {
                "name": item.get("name"),
                "category": item.get("category"),
                "endpoint_url": schema_endpoint(item),
                "description": item.get("description"),
            }
        )
    print_json(matches[: args.limit])


def cmd_schema(args: argparse.Namespace) -> None:
    items = load_schema(args.schema)
    for item in items:
        if item.get("name") == args.name or schema_endpoint(item) == args.name:
            print_json(item)
            return
    raise SystemExit(f"No schema entry found for {args.name}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="General MUAPI helper")
    parser.add_argument("--state", type=Path, default=None, help="Optional JSON state file.")
    sub = parser.add_subparsers(required=True)

    upload_parser = sub.add_parser("upload", help="Upload local media files.")
    upload_parser.add_argument("files", nargs="+")
    upload_parser.set_defaults(func=cmd_upload)

    submit_parser = sub.add_parser("submit", help="Submit a generation payload.")
    submit_parser.add_argument("--endpoint", required=True, help="Endpoint name without /api/v1, or full URL.")
    submit_parser.add_argument("--payload", required=True, type=Path)
    submit_parser.add_argument("--method", default="POST", choices=["POST", "PUT", "PATCH"])
    submit_parser.add_argument("--wait", action="store_true", help="Poll until completion.")
    submit_parser.add_argument("--download", type=Path, default=None, help="Download first output URL to this path.")
    submit_parser.add_argument("--interval", type=int, default=5)
    submit_parser.add_argument("--timeout", type=int, default=1200)
    submit_parser.add_argument("--request-timeout", type=int, default=180)
    submit_parser.set_defaults(func=cmd_submit)

    result_parser = sub.add_parser("result", help="Fetch or wait for a request result.")
    result_parser.add_argument("request_id")
    result_parser.add_argument("--wait", action="store_true")
    result_parser.add_argument("--download", type=Path, default=None)
    result_parser.add_argument("--urls", action="store_true", help="Wrap result with extracted output_urls.")
    result_parser.add_argument("--interval", type=int, default=5)
    result_parser.add_argument("--timeout", type=int, default=1200)
    result_parser.set_defaults(func=cmd_result)

    download_parser = sub.add_parser("download", help="Download a URL to a local file.")
    download_parser.add_argument("url")
    download_parser.add_argument("--output", required=True, type=Path)
    download_parser.set_defaults(func=cmd_download)

    models_parser = sub.add_parser("models", help="Search a local MUAPI schema_data.json file.")
    models_parser.add_argument("--schema", required=True, type=Path)
    models_parser.add_argument("--query", default="")
    models_parser.add_argument("--category", default="")
    models_parser.add_argument("--limit", type=int, default=50)
    models_parser.set_defaults(func=cmd_models)

    schema_parser = sub.add_parser("schema", help="Print one local MUAPI schema entry by model name or endpoint.")
    schema_parser.add_argument("--schema", required=True, type=Path)
    schema_parser.add_argument("--name", required=True)
    schema_parser.set_defaults(func=cmd_schema)
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
