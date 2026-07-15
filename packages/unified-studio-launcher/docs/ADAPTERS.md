# Adapter Guide

Adapters keep one studio UI from caring whether a job runs in ComfyUI, Swift/MLX,
CUDA, a remote GPU box, or another local engine.

Recommended interface:

```js
export async function capabilities() {}
export async function submit(request) {}
export async function status(jobId) {}
export async function cancel(jobId) {}
export async function outputs(jobId) {}
```

Minimum job shape:

```json
{
  "id": "job-id",
  "engine": "comfyui",
  "status": "queued",
  "createdAt": "2026-07-06T00:00:00.000Z",
  "updatedAt": "2026-07-06T00:00:00.000Z",
  "outputs": []
}
```

Recommended engines:

- `comfyui`: calls `/api/prompt`, `/queue`, `/history`, `/view`, and `/ws`.
- `native-mlx`: calls a local Swift/MLX daemon or CLI staging service.
- `remote-gpu`: calls a private gateway/tunnel endpoint.
- `windows-local`: wraps a Windows Python/CUDA process through the same job
  interface.
- `linux-local`: wraps a Linux Python/CUDA process or container through the same
  job interface.

Keep secrets in environment variables or OS keychain storage. Do not commit API
tokens, model weights, generated outputs, or private workflow JSON.

Adapters should not assume one operating system. Put process differences in the
config command map (`darwin`, `linux`, `win32`) and keep adapter request/response
shapes the same across platforms.
