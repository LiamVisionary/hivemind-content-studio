from __future__ import annotations

import json
from pathlib import Path

from hivemind_content_studio.media_studio import discover_media_studio
from hivemind_content_studio.planner import DEFAULT_PROVIDERS


def test_media_studio_is_discovered_from_hivemind_preferences(tmp_path: Path, monkeypatch) -> None:
    preferences = tmp_path / "app-preferences.json"
    preferences.write_text(
        json.dumps(
            {
                "preferences": [
                    {
                        "appId": "host:8788:studio",
                        "appName": "Media Studio",
                        "capabilities": ["video", "image-to-video"],
                        "mcpVideo": {
                            "url": "http://example.test:8789/mcp",
                            "uploadBase": "http://example.test:8788",
                            "authEnvKey": "MEDIA_STUDIO_TOKEN",
                            "tool": "media_generate_video",
                            "jobTool": "media_get_job",
                            "workflowId": "local-workflow",
                        },
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("HIVEMINDOS_APP_PREFERENCES", str(preferences))
    descriptor = discover_media_studio()
    assert descriptor is not None
    assert descriptor.app_name == "Media Studio"
    assert descriptor.auth_env_key == "MEDIA_STUDIO_TOKEN"
    assert descriptor.tool == "media_generate_video"
    assert descriptor.job_tool == "media_get_job"
    assert DEFAULT_PROVIDERS["motion"] == "media-studio-mcp"
