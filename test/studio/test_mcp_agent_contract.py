from __future__ import annotations

import asyncio

from hivemind_content_studio.mcp_server import build_mcp_server


def test_agent_first_mcp_exposes_durable_runs_intents_assets_and_evidence() -> None:
    server = build_mcp_server()

    tools = {tool.name for tool in asyncio.run(server.list_tools())}
    assert {
        "execute_content_run",
        "get_content_run",
        "list_content_runs",
        "resume_content_run",
        "retry_content_step",
        "cancel_content_run",
        "route_content_intent",
        "execute_content_intent",
        "ingest_content_asset_base64",
        "ingest_content_asset_url",
        "request_content_approval",
        "apply_content_run_approval",
        "record_semantic_evaluation",
        "ingest_content_metrics",
        "recommend_content_variant",
    } <= tools

    resources = {str(resource.uri) for resource in asyncio.run(server.list_resources())}
    templates = {str(template.uriTemplate) for template in asyncio.run(server.list_resource_templates())}
    assert {"studio://capabilities", "studio://providers"} <= resources
    assert {
        "studio://runs/{run_id}",
        "studio://runs/{run_id}/artifacts",
        "studio://runs/{run_id}/next-actions",
    } <= templates


def test_mcp_does_not_expose_operator_approval_decisions() -> None:
    server = build_mcp_server()
    tools = {tool.name for tool in asyncio.run(server.list_tools())}

    assert "approve_content_approval" not in tools
    assert "deny_content_approval" not in tools
    assert "plan_content" not in tools
    assert "run_agent_script_generation" not in tools
    assert "attach_agent_script" not in tools
