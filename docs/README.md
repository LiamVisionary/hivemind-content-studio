# Documentation

Start with the row that describes you.

## Using the app

| | |
|---|---|
| [GUIDE.md](GUIDE.md) | The user guide. First run, the vault and why a passphrase cannot be recovered, your first picture and your first video end to end, every studio, where files go |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | Every failure the app can show, keyed to its own words, each with the fix |

Neither names a port, a process or a repository path.

## Running it

| | |
|---|---|
| [OPERATIONS.md](OPERATIONS.md) | The operator brief: quick start, configuration, ports and health endpoints, the CLI, the publishing gate, agent access, failure handling, recovery and rollback |
| [SETTINGS.md](SETTINGS.md) | Generated from the settings schema — every key, its default, whether it needs a restart, and the variable that overrides it |
| [RELEASE.md](RELEASE.md) | What the desktop download contains, and the decisions behind it |
| [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md) | What has to be green before a build is dispatched |

## How it works

| | |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | One control plane, three engines: the durable state machine, the boundaries, provider routing, the side-effect gates |
| [E2E_ENCRYPTION_DESIGN.md](E2E_ENCRYPTION_DESIGN.md) | What is sealed with which key, and why no passphrase can be reset |
| [RESTORE_STUDIO.md](RESTORE_STUDIO.md) | The SeedVR2 restoration rail: chunks, checkpoints, the three machines and the finishing pass |
| [MONETIZATION.md](MONETIZATION.md) | The revenue loop the runs feed |

## Roadmaps

Open work, with unfinished phases. Check the status block at the top of each
before acting on it.

| | |
|---|---|
| [MIX_STUDIO_ASSIMILATION_PLAN.md](MIX_STUDIO_ASSIMILATION_PLAN.md) | Phases 1–2 closed; the LTX Director timeline and the privacy-aware library/ops rebuild remain |
| [H3_IMAGE_AND_CLIP_PREP_PLAN.md](H3_IMAGE_AND_CLIP_PREP_PLAN.md) | Clip Prep landed; the GIF/scene-cut remainder and the `minimax-h3-image` lane remain |
| [AUTOCLIP_ASSIMILATION_PLAN.md](AUTOCLIP_ASSIMILATION_PLAN.md) | The re-rank and hook layer landed; selection independence and collections are not started |

## Strategy

| | |
|---|---|
| [strategy/PRIMARY_FACELESS_SHORTS_PLAN.md](strategy/PRIMARY_FACELESS_SHORTS_PLAN.md) | The faceless-shorts production plan |
| [strategy/FACELESS_SHORTS_MONETIZATION.md](strategy/FACELESS_SHORTS_MONETIZATION.md) | How that plan is meant to pay |

## History

| | |
|---|---|
| [history/](history/README.md) | Finished records — the migration map and the implementation plans that produced this app. Nothing there guides current work |

## Elsewhere in the repository

- [`../README.md`](../README.md) — what this is, and how to install it
- [`../test/README.md`](../test/README.md) — the five test suites and their prerequisites
- [`../.github/SECURITY.md`](../.github/SECURITY.md) — what listens where, and private vulnerability reporting
- [`../THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) — donors, licences and the distribution posture
- [`../packages/open-generative-ai/DESIGN.md`](../packages/open-generative-ai/DESIGN.md) — the frontend design system
- [`../packages/open-generative-ai/AGENTS.md`](../packages/open-generative-ai/AGENTS.md) — the privacy boundary the frontend must not cross
