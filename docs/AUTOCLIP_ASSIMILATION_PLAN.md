# AutoClip → Hivemind Content Studio assimilation plan

Source: [zhouxiaoka/autoclip](https://github.com/zhouxiaoka/autoclip) (MIT, 6.5k★, 1.27k forks, last push
2026-06-03), inert clone audited at `~/.codex/hive-assimilate/candidates/zhouxiaoka-autoclip` @ `17100c0`.
Donor is a FastAPI + Celery + React product that turns YouTube/Bilibili long-form into scored highlight
clips and curated collections through a six-step Qwen pipeline.

**Scope of this plan: the semantic layer only.** We are not assimilating the product. We are assimilating
the one thing the donor has that we do not — an LLM pass that understands the transcript, scores the
candidates, and writes the hook. Everything downstream of selection (cutting, captions, rights, approval,
Postiz) stays ours and unchanged.

## License verdict

Donor is MIT. This repo is AGPL-3.0-or-later (forced by the Auto Clipper donor — see
`THIRD_PARTY_NOTICES.md`). MIT → AGPL is one-way compatible: we may copy, adapt, and translate donor
**code**, not merely its ideas. Obligation is to preserve the MIT copyright notice and provenance
(`THIRD_PARTY_NOTICES.md` + per-file headers). No trademark or endorsement is implied.

## The gap this closes

Confirmed by source read, not inference:

- `src/auto_clipper/podcli.py` delegates **all** selection to a pinned Podcli binary. We own no scoring
  logic. `clips.score` is populated only if Podcli happens to emit it on stdout; otherwise
  `import_podcli_outputs` globs `*.mp4` and files them as `clip-01…N` with rationale
  "Imported from Podcli output directory" ([podcli.py:180](../src/auto_clipper/podcli.py)).
- `src/auto_clipper/scheduling.py:39` builds every Postiz caption as
  `transcript_excerpt or rationale or "Approved clip"`. We publish to four platforms with a raw transcript
  fragment as the hook. This is the weakest link in the chain.

## Gap matrix (donor capability → our status → action)

### Already covered, or deliberately declined (no action)

| Donor capability | Our status |
| --- | --- |
| yt-dlp ingest + metadata | Covered — `ingest.py` also records provenance and rights status |
| Cutting / encoding / captions | Covered better — Podcli + Remotion (5 caption styles, hardware encode) vs their ffmpeg cut |
| FastAPI + Celery + Redis + React + Tauri desktop shell | **Declined** — we are a CLI + MCP control plane inside a larger studio; adopting their shell would fork the product |
| `backend/core/llm_manager.py` + `llm_providers.py` (DashScope/OpenAI/Gemini/SiliconFlow) | **Declined** — we already have two LLM paths: `local_llm.py::LocalLlmRuntime.chat` (llama-server, unpaid) and `app/services/llm.py::_generate_response` (provider-generic). A third client would violate the established project way |
| Bilibili upload + multi-account health checks | **Declined** — not our platforms; Postiz covers TikTok/YouTube/IG/X/LinkedIn |
| `utils/subtitle_processor.py::_split_text_to_words` | **No gain** — their word timing is the same uniform split we already do at `transcripts.py:172`. Negative finding: our transcript layer is not behind theirs |
| WebSocket progress + Flower | Deferred — real, but it is an orchestration want, not a quality gap. See Phase 3 |

### Phase 1 — the re-rank and hook layer (THIS PASS)

Runs **after** Podcli renders, **before** the run is marked `rendered`. Podcli still decides where to cut;
the LLM decides what is worth posting and what to call it.

| Capability | Donor source | Target | Reuse type |
| --- | --- | --- | --- |
| Batch LLM re-rank (group by chunk, one call per chunk, merge score + reason back onto candidates, sort) | `backend/pipeline/step3_scoring.py` | `src/auto_clipper/rerank.py` | adapted_code |
| Hook/title generation (id-keyed batch map, raw-response dump for debugging, fail-open keeps clips) | `backend/pipeline/step4_title.py` | `src/auto_clipper/titles.py` | adapted_code |
| Tolerant JSON extraction from LLM prose (markdown fence → whole body → regex scan) | `backend/utils/llm_client.py::parse_json_response` | `src/auto_clipper/llm_json.py` | adapted_code |
| Per-category prompt overlay with per-file fallback to defaults | `backend/core/shared_config.py::get_prompt_files` | `src/auto_clipper/prompts.py` | adapted_code |
| Scoring rubric prompt | `prompt/推荐理由.txt` | `presets/prompts/clip-rerank.txt` | translated_code |
| Title prompt | `prompt/标题生成.txt` | `presets/prompts/clip-title.txt` | translated_code |
| 7 category prompt overlays (business, knowledge, opinion, speech, entertainment, experience, content_review) | `prompt/<category>/` | `presets/prompts/<category>/` | translated_code |

**Rubric decision.** The donor's rubric is four axes aimed at Bilibili: information value, emotional
resonance, spread potential, structural completeness. Liam already has a six-axis clippability rubric in
`Skills/content-rewards-viral-app-campaign/SKILL.md` (clippable, result-driven, desire-to-know, repeatable,
controversy/tension, conversion path). **Liam's rubric is the spine; we import exactly one donor axis —
structural completeness** (does the topic open and close cleanly), because that is the axis that decides
whether a cut lands, and it is the one Liam's rubric has no word for. The prompts are rewritten in English
for TikTok/YouTube/IG/X, not translated literally.

**Wiring.**

- Schema migration `3`: add `llm_score REAL`, `llm_reason TEXT`, `hook_title TEXT`, `caption TEXT` to
  `clips`. Migration runner already handles versioned SQL (`db.py:SCHEMA`).
- Call site: `podcli.py::render_run`, after `import_podcli_outputs`, before `set_run_status`. Re-rank
  failure must set status `rendered` anyway and record the error — a dead LLM must never cost us a render.
- `scheduling.py:39` caption precedence becomes `caption → hook_title → transcript_excerpt → rationale`.
- LLM path: `local_llm.py` first (unpaid, matches the skill's "local unpaid Auto Clipper" framing),
  `app/services/llm.py` as the cloud fallback. No new client, no new API key surface.

**Hard constraint — re-rank ranks, it never deletes.** The donor drops everything below
`MIN_SCORE_THRESHOLD` in `step3_scoring.py:160`. We do not. Every rendered clip stays in the DB and stays
visible to the reviewer; the score only orders them. The approval gate remains the single place where
anything is filtered out, because that gate is what keeps public creator material research-only.

### Phase 2 — selection independence (NEXT, optional)

Only worth doing if Podcli's cuts prove to be the bottleneck rather than its ordering.

| Capability | Donor source | Target | Reuse type |
| --- | --- | --- | --- |
| Chunked outline extraction over a long transcript | `backend/pipeline/step1_outline.py` | `src/auto_clipper/outline.py` | adapted_code |
| Topic → timestamp boundary resolution against the transcript | `backend/pipeline/step2_timeline.py` | `src/auto_clipper/timeline.py` | adapted_code |

This would let us propose cut points ourselves and hand Podcli explicit in/out times, instead of accepting
whatever it picks. It is a real change in posture — do not start it before Phase 1 has run on real sources.

### Phase 3 — collections and orchestration (LATER)

| Capability | Donor source | Target | Reuse type |
| --- | --- | --- | --- |
| Topic clustering of high-scoring clips into a compilation | `backend/pipeline/step5_clustering.py` | `src/auto_clipper/collections.py` | adapted_code |
| Async run orchestration + progress events | `backend/services/processing_orchestrator.py`, `progress_event_service.py` | TBD — must fit our stack, not import Celery | design input only |

Our render is a blocking `subprocess` with a 7200s timeout and a PTY that screen-scrapes Podcli's
interactive picker for "clips selected" and writes `\r` ([podcli.py:104](../src/auto_clipper/podcli.py)).
It works. Replacing it is orchestration work, and pulling in Celery + Redis for one subprocess is not the
answer — revisit only if long sources actually block the agent path.

### Explicitly NOT assimilated

- **`backend/pipeline/config.py`** — stale duplicate. It defines `MIN_SCORE_THRESHOLD = 7.0` while the live
  value imported by `step3_scoring.py` is `core/shared_config.py:117`'s `0.7`, and the prompt asks for a
  0.0–1.0 score. Copying this file would silently threshold out every clip. Take the prompt's unit (0–1)
  and ignore both constants.
- **`llm_client.py::fix_common_json_errors`** — its regex #5,
  `re.sub(r'([a-zA-Z_][a-zA-Z0-9_]*)\s*:', r'"\1":', json_str)`, does not check whether the key is already
  quoted, so it rewrites `"start_time":` into `""start_time"":` and corrupts valid JSON on the repair path.
  Take the four-layer *extraction* ladder; drop the repair function. If a model returns unparseable JSON,
  retry the call — do not regex-patch it.
- **Dockerfiles** — not needed, and they are what tripped the repo-wide audit (three `rm -rf` hits, all the
  standard `rm -rf /var/lib/apt/lists/*` apt cleanup; verified false positives).
- **`docs/QUICK_START_GUIDE.md:50`** — `curl … | python` Poetry bootstrap. Never run.

## Donor gotchas worth carrying

- Their `_get_llm_evaluation` requires `len(parsed) == len(clips)` and returns `[]` on mismatch, silently
  losing a whole chunk. Ours must fall back per-clip, not per-chunk.
- Batch by chunk, not per clip. One call for N candidates is what makes this cheap enough to run on every
  render.
- They persist the raw LLM response per chunk before parsing (`step4_llm_raw_output/`). Keep that — it is
  the only way to debug a bad batch after the fact. It goes under the run's output dir, which is already
  inside the sealed-media boundary.
- Category-specific prompts are selected per-file with fallback to the default, so an overlay can override
  one prompt without forking all five. Keep that shape.

## Verification contract

Phase 1 is not done until:

1. `pytest test/auto_clipper` passes, including new tests for `llm_json` extraction (fenced, bare, prose-
   wrapped, and unparseable input) and for re-rank fail-open behavior with a stubbed LLM.
2. A real render on a real source shows `llm_score`, `llm_reason`, and `hook_title` populated in the DB,
   with `AUTO_CLIPPER_FAKE_RENDER=1` covering the offline path.
3. A stubbed LLM failure still produces `status = rendered` and a scheduled caption that falls back to the
   existing behavior — proving a dead LLM costs us nothing.
4. `auto-clipper schedule` emits a Postiz payload whose caption is the generated hook, verified in the
   written payload JSON with `CONTENT_STUDIO_ENABLE_LIVE_PUBLISH` **off**.
5. The approval gate is re-proven: a run with high scores still refuses to schedule without
   `auto-clipper approve`.
