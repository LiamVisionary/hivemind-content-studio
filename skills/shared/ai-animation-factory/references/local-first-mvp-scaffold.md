# Local-First MVP Scaffold Reference

## Session Pattern Captured

A user asked to set up an AI animation factory for this pipeline:

```text
Claude -> Midjourney -> Runway -> ElevenLabs -> Suno -> Make
script -> frames -> motion -> voice -> music -> publish
```

The successful approach was to create a local-first scaffold instead of blocking on missing paid-provider credentials.

## Durable Lessons

- Build the factory artifacts first: briefs, prompt templates, manifests, run folders, Make scenario docs, and publishing metadata.
- Audit credentials using presence checks only; never print or copy raw secret values.
- Treat a credential as unverified until a live smoke test succeeds.
- If a provider SDK auth error may print key fragments, patch the CLI to catch and sanitize provider exceptions.
- Report exact `ready` vs `blocked` status. Do not call the setup fully automated if credentials are missing or failing.
- Generated prompt packs are still useful for manual provider workflows while API automation is blocked.

## MVP File Shape That Worked

```text
README.md
.env.example
requirements.txt
briefs/<lane-example>.yaml
prompts/episode_script.md
prompts/brand_explainer.md
prompts/midjourney.md
prompts/runway.md
prompts/elevenlabs.md
prompts/suno.md
scripts/factory.py
workflows/make-scenario.md
publishing/youtube-metadata-template.md
runs/<job-id>/brief.snapshot.json
runs/<job-id>/scene_manifest.csv
runs/<job-id>/midjourney_prompts.md
runs/<job-id>/runway_prompts.md
runs/<job-id>/elevenlabs_lines.md
runs/<job-id>/suno_prompts.md
runs/<job-id>/publish_metadata.md
```

## Provider Status Language

Use these labels:

- `ready`: live smoke test passed.
- `present but invalid/auth failing`: credential exists but provider rejected it.
- `missing`: no credential configured.
- `manual`: provider path exists but needs manual operation or a third-party relay.
- `blocked`: downstream automation cannot continue until missing/invalid dependency is fixed.

## Safe Error Message Example

Instead of surfacing raw SDK output, print a sanitized line such as:

```text
Script draft failed via OpenAI provider (AuthenticationError). Check OPENAI_API_KEY / FACTORY_OPENAI_MODEL without printing the key.
```

## Recommended Final Status Shape

Give the user concrete artifacts and verification, not just a narrative:

```text
Set up: /root/ai-animation-factory

Verified:
- python3 -m py_compile scripts/factory.py: passed
- python3 scripts/factory.py init-samples: passed

Generated runs:
- runs/drift-protocol-episode-2
- runs/vaultly

Ready:
- local scaffold
- prompts/manifests
- Make scenario outline

Blocked:
- OPENAI_API_KEY present but auth smoke failed
- ANTHROPIC/MIDJOURNEY/RUNWAY/ELEVENLABS/SUNO/MAKE keys missing
```

## What Not To Persist

Do not persist a specific user's project path, credential absence, provider account state, or failed key as a durable memory/skill rule. Persist the workflow pattern: audit safely, scaffold locally, smoke test, sanitize errors, and report precise readiness.
