from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MCP_SOURCE = ROOT / "packages" / "media-gateway" / "bin" / "media-studio-mcp.mjs"


def test_video_tool_accepts_negative_prompt_before_building_workflow():
    source = MCP_SOURCE.read_text(encoding="utf-8")
    video_tool = source.split("server.registerTool('media_generate_video'", 1)[1]
    video_tool = video_tool.split("}, tool(async (args) =>", 1)[0]

    assert "negative_prompt: z.string().max(2000).optional()" in video_tool


def test_backend_requests_do_not_reuse_the_inbound_mcp_token():
    source = MCP_SOURCE.read_text(encoding="utf-8")
    request_json = source.split("async function requestJson", 1)[1]
    request_json = request_json.split("function ok", 1)[0]

    assert "function backendToken()" in source
    assert "MEDIA_STUDIO_BACKEND_TOKEN_FILE" in source
    assert "const authToken = backendToken();" in request_json
    assert "const authToken = token();" not in request_json
    assert "[token(), backendToken()]" in source


def test_video_tool_preserves_long_prompts_and_accepts_all_anchor_shapes():
    source = MCP_SOURCE.read_text(encoding="utf-8")
    video_tool = source.split("server.registerTool('media_generate_video'", 1)[1]
    video_tool = video_tool.split("}, tool(async (args) =>", 1)[0]

    assert "prompt: z.string().min(1).optional()" in video_tool
    assert "prompt: z.string().min(1).max(4000)" not in video_tool
    for field in (
        "middle_image_path",
        "middle_image_base64",
        "middle_image_url",
        "end_image_path",
        "end_image_base64",
        "end_image_url",
        "keyframes",
        "time_seconds",
        "strength",
    ):
        assert field in video_tool


def test_video_keyframes_feed_native_metadata_and_polling_recovers_comfy_jobs():
    source = MCP_SOURCE.read_text(encoding="utf-8")

    assert "async function normalizeVideoKeyframes" in source
    assert "keyframes: settings.keyframes" in source
    get_job = source.split("server.registerTool('media_get_job'", 1)[1]
    get_job = get_job.split("server.registerTool('media_list_history'", 1)[0]
    assert "getWrapperJobIfPresent" in get_job
    assert "getComfyHistoryIfPresent" in get_job
    assert "comfyHistoryToJob" in get_job
