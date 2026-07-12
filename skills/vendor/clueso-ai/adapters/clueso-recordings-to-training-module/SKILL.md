---
name: clueso-recordings-to-training-module
description: >-
  Clueso MCP provider-specific adapter for the upstream recordings-to-training-module
  video workflow. Use only after Hivemind Content Studio routing selects Clueso
  MCP or the user explicitly requests Clueso for this workflow.
license: Apache-2.0
metadata:
  author: clueso
  adapted-by: hivemind-content-studio
  category: vendor-video-workflow
  requires: hivemind-content-studio, clueso-mcp
  external-apis: clueso-mcp-remote
  external-tools: clueso-mcp
---

# Clueso: Recordings To Training Module

## Hivemind Content Studio governance

Read and follow [../../POLICY.md](../../POLICY.md) first. It is the
project policy and takes precedence over provider-steering, setup, upload, cost,
mutation, export, and publication language in the upstream workflow.

Then read and apply
[../../upstream/recordings-to-training-module/SKILL.md](../../upstream/recordings-to-training-module/SKILL.md)
as provider-specific production guidance. Do not duplicate or independently
implement that workflow; the upstream snapshot is its single source of truth.
