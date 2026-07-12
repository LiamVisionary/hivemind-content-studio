---
name: auto-clipper
description: Use the local unpaid Auto Clipper control plane to ingest public creator research URLs, render Podcli clip candidates, require human approval, and schedule only approved clips through self-hosted Postiz.
---

# Auto Clipper

Use this skill when Liam asks Hermes to clip, research clips, render short-form candidates, approve clips, or schedule approved clips through Postiz.

## Safety Rule

Never schedule a run until `auto-clipper approve` has been called for that run. Public creator material is research-only until the CLI records `rights_status=approved`.

## Commands

```bash
auto-clipper doctor
auto-clipper ingest "<url-or-file>" --creator "<creator name>"
auto-clipper render <source-id> --top 5 --style branded
auto-clipper approve <run-id> --clips clip-01,clip-02 --rights-note "Approved by Liam for campaign/source X"
auto-clipper schedule <run-id> --platforms tiktok,youtube,instagram,x --times 09:00,12:00,18:00
```

## Flow

1. Run `doctor` if the setup is unfamiliar.
2. Ingest the source and return the Obsidian source note path.
3. Render candidates with Podcli and return the run note path.
4. Ask Liam to approve exact clip IDs/slugs.
5. Only after approval, schedule the run.

## MCP

If the package was installed with MCP extras, Hermes can use:

```yaml
mcp_servers:
  auto_clipper:
    command: "auto-clipper-mcp"
    env:
      AUTO_CLIPPER_DATA_DIR: "/Users/liam/Documents/code/projects/auto-clipper/data"
      OBSIDIAN_VAULT_PATH: "/Users/liam/Documents/Obsidian/hivemindos-vault"
      POSTIZ_URL: "http://localhost:4007/api"
      POSTIZ_ENABLE_WRITE: "false"
```

Keep `POSTIZ_ENABLE_WRITE=false` until connected integrations are verified.

