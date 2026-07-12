---
name: ai-animation-factory
description: "Use when setting up or operating AI animation content factories that turn briefs into scripts, frame prompts, motion prompts, voice lines, music briefs, and publishing metadata across tools such as Claude/OpenAI, Midjourney, Runway, ElevenLabs, Suno, Make, and YouTube."
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [animation, video, content-factory, make, prompts, publishing]
    related_skills: [youtube-content, songwriting-and-ai-music, google-workspace]
---

# AI Animation Factory

## Overview

Use this skill to build or operate a repeatable AI animation pipeline, especially when the user wants a practical content factory rather than a one-off video. The usual shape is:

```text
brief -> script -> frames -> motion -> voice -> music -> publish
```

Common provider mapping can be paid-API or local/open-source:

```text
Paid/API:       Claude/OpenAI -> Midjourney/image API -> Runway/video API -> ElevenLabs -> Suno -> Make/YouTube
Local/open OSS: AdaptiveAgent -> Z-Image/ComfyUI      -> ComfyUI I2V      -> Universal TTS -> ACE-Step -> n8n/Windmill/YouTube
Role:           script       -> frames                -> motion           -> voice         -> music    -> publish
```

Default to the user's configured local/open-source stack when requested or available: HivemindOS AdaptiveAgent for scripts through the HivemindOS/Tailscale agent-runtime bridge (no `HIVE_ADAPTIVE_AGENT_URL` required by default), Image Gen Studio / Open Generative AI Hosted for images with Z-Image selected inside that multi-runtime studio (do not call raw `zimage_comfyui` for normal factory runs), ComfyUI/image-to-video lanes such as Wan I2V/LTX-Video/CogVideoX/HunyuanVideo for motion, Universal TTS on port 8799 via the HivemindOS/Tailscale app proxy for speech, ACE-Step 1.5 for music, and n8n/Windmill/Node-RED/Temporal for orchestration. The default approach is local-first and credential-safe: create durable config, prompt templates, brief formats, run folders, manifests, and automation docs before attempting provider calls. Only claim full automation after live provider smoke tests succeed.

Session-specific scaffold notes and the verified MVP pattern are in `references/local-first-mvp-scaffold.md`.

## When to Use

Use this when the user asks to:

- Set up an AI animation studio, content factory, or production pipeline.
- Produce animated story series, motion comics, children's story channels, or brand explainer animations.
- Connect script generation, image generation, image-to-video, voice, music, and publishing tools.
- Create Make/Zapier/n8n automations for recurring animated content production.
- Turn a creative brief into reusable production artifacts rather than only a final rendered file.

Do not use this for:

- A single static illustration request — use image-generation/design skills instead.
- Summarizing an existing YouTube video — use `youtube-content`.
- Pure music/song prompt generation — use `songwriting-and-ai-music`.
- Full OAuth/Gmail/Drive setup details — use `google-workspace` alongside this skill.

## Default Deliverables

For an MVP scaffold, create these folders:

```text
ai-animation-factory/
  README.md
  .env.example
  requirements.txt
  config/factory.yaml
  briefs/
  prompts/
  scripts/
  workflows/
  publishing/
  runs/
```

Minimum prompt templates:

- `prompts/episode_script.md` — original animated series episode script.
- `prompts/brand_explainer.md` — SaaS/local-business/product explainer script.
- `prompts/midjourney.md` — visual keyframe/frame generation prompts.
- `prompts/runway.md` — image-to-video/camera/motion prompts.
- `prompts/elevenlabs.md` — voice direction and line exports.
- `prompts/suno.md` — score/theme/music prompt pack.

Minimum workflow docs:

- `workflows/make-scenario.md` — trigger, routing, provider modules, error handling, publish handoff.
- `publishing/youtube-metadata-template.md` — title, description, chapters, tags, thumbnail notes.

Minimum run artifacts per job:

```text
runs/<slug>/
  brief.snapshot.json
  scene_manifest.csv
  midjourney_prompts.md
  runway_prompts.md
  elevenlabs_lines.md
  suno_prompts.md
  publish_metadata.md
```

## Recommended Brief Shape

Use YAML briefs so users can edit them directly:

```yaml
id: vaultly-brand-explainer
type: brand_explainer
brand: Vaultly
audience: seed-stage SaaS founders
goal: explain secure investor-update workflows in 60 seconds
runtime_seconds: 60
style:
  visual: premium vector noir with soft gradients
  pacing: crisp, cinematic, trustworthy
  tone: confident, concise
scenes:
  - title: Problem
    beat: Founders lose investor trust when updates are scattered.
    duration_seconds: 10
  - title: Solution
    beat: Vaultly turns metrics, notes, and asks into a polished update.
    duration_seconds: 15
voice:
  narrator: warm, premium, calm authority
music:
  mood: subtle pulse, modern SaaS, optimistic resolution
publish:
  platform: youtube
  channel_lane: brand_explainers
```

For series episodes, include recurring characters, canon constraints, episode number, season arc, and continuity notes.

## Credential-Safe Setup Workflow

1. **Audit without printing secrets.** Use presence checks such as `hive-env-check KEY`; never echo raw env values.
2. **Classify each integration as:**
   - `ready`: live smoke test succeeded.
   - `present-but-failing`: a key exists but provider auth/smoke failed.
   - `missing`: no credential available.
   - `manual`: no public API or provider needs a browser/manual export.
3. **Create `.env.example` only.** Include variable names and comments, never real values.
4. **Generate local artifacts first.** Briefs, manifests, and prompt packs are valuable even before API credentials exist.
5. **Smoke test providers one by one.** Use tiny/cheap calls. Do not mark a provider ready based on key presence alone.
6. **Sanitize provider exceptions.** Authentication errors often include key fragments or request metadata. Catch exceptions and print only provider class/status plus the env var to check.
7. **Document blocked integrations honestly.** Distinguish an MVP scaffold from full automation.

## Implementation Pattern

A copyable starter CLI is available at `templates/factory.py`; use it as a baseline when scaffolding a new local-first factory, then adapt only the brief fields and provider integrations the user actually needs.

A simple local CLI should support at least:

```bash
python3 scripts/factory.py init-samples
python3 scripts/factory.py plan briefs/example.yaml
python3 scripts/factory.py draft-script briefs/example.yaml
```

Where:

- `init-samples` creates sample briefs and run folders.
- `plan <brief>` generates deterministic run artifacts without external APIs.
- `draft-script <brief>` optionally calls a configured LLM and saves the result into the run folder.

Good CLI behavior:

- Reads credentials from environment at call time.
- Writes all outputs into `runs/<brief-id>/`.
- Snapshots the input brief for reproducibility.
- Uses stable slugs for run folder names.
- Fails closed on provider errors without leaking secrets.

## Make / Automation Blueprint

Recommended scenario modules:

1. Trigger: scheduler, webhook, Airtable/Sheets row, or manual form.
2. Normalize brief: validate lane, runtime, brand/series fields.
3. Script generation: Claude/OpenAI or manual approval gate.
4. Scene manifest: split script into scenes, shots, and durations.
5. Image generation: create frame prompts and push to image provider.
6. Motion generation: send selected frames and motion prompts to Runway/video provider.
7. Voice: generate narrator/character lines.
8. Music: generate score/theme prompt and output track.
9. Assembly: ffmpeg/editor step or manual editor handoff.
10. Review gate: require human approval before publishing.
11. Publishing: YouTube/Drive/social upload and metadata.
12. Archive: save manifest, assets, outputs, provider job IDs, and publish URL.

## Provider Notes

- **Claude/OpenAI:** best for scripts, scene breakdowns, metadata, and continuity checks. OpenAI key presence is not enough; run a live prompt.
- **Midjourney:** often requires a relay/manual workflow unless a supported API wrapper is available. Store prompts and selected image IDs.
- **Runway:** video generation may be asynchronous; store job IDs and poll status.
- **ElevenLabs:** export per-line voice directions; keep character/narrator voice IDs separate.
- **Suno:** treat music prompts as creative briefs; avoid promising exact output determinism.
- **ACE-Step:** upstream CLI is wizard/config-oriented; for factory automation use a non-interactive adapter shape such as `ace-step --prompt "..." --output score.wav`. Verify `ace-step --health` separately from real generation. On low-RAM/no-GPU hosts, install dependencies locally but route real generation to an ACE-Step API backend exposed via `ACE_STEP_API_BASE_URL` / `FACTORY_ACE_STEP_BASE_URL` over HivemindOS/Tailscale rather than claiming local inference is ready.
- **Make:** document module-by-module even before API keys exist; it becomes the operational handoff.
- **Google/YouTube:** use `google-workspace` or platform-specific OAuth setup; don't fake publishing readiness.

## Common Pitfalls

1. **Overclaiming automation.** A folder scaffold plus prompt generation is an MVP scaffold, not a fully autonomous pipeline. Say exactly what is ready vs blocked.

2. **Treating key presence as success.** Always run a live provider smoke test before saying an integration works.

3. **Leaking credentials in auth errors.** Provider SDK exceptions can echo key fragments. Catch and sanitize errors before displaying logs.

4. **Skipping manual-mode value.** Missing paid APIs should not block usefulness: prompt packs, manifests, and publish metadata support manual provider workflows immediately.

5. **One-off templates instead of lanes.** Keep lane-specific brief templates for story series, brand explainers, motion comics, and children's stories. Don't hard-code one user's sample as the whole factory.

6. **No review gate.** Automated publishing should include a human approval stage unless the user explicitly wants hands-off publishing.

7. **No provenance.** Save brief snapshots, provider job IDs, selected asset IDs, and final publish URLs in the run folder.

## Verification Checklist

Before reporting completion:

- [ ] Folder structure exists and is readable.
- [ ] `.env.example` contains only variable names/placeholders.
- [ ] At least one sample brief generates a run folder.
- [ ] Each generated run has a scene manifest, image prompts, motion prompts, voice lines, music prompts, and publish metadata.
- [ ] Python/script syntax checks pass if code was written.
- [ ] Provider smoke tests were attempted only when credentials are available.
- [ ] Provider statuses are reported as `ready`, `present-but-failing`, `missing`, or `manual`.
- [ ] Any provider failure message is sanitized.
- [ ] User-facing summary includes exact path, generated sample run IDs, verified commands, and blocked credentials.

## Reporting Template

```text
Set up: /path/to/ai-animation-factory

Ready:
- Local scaffold
- Prompt templates
- Sample run generation
- Make scenario outline

Verified:
- <command>: passed
- <command>: passed

Generated runs:
- runs/<id-1>/
- runs/<id-2>/

Blocked:
- PROVIDER_KEY: missing
- PROVIDER_KEY: present but auth smoke failed

Next:
- Add/refresh credentials via the shared env
- Pick first provider to wire live
- Run manual workflow from generated prompts while credentials are pending
```
