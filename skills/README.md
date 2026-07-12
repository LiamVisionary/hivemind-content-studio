# Agent skill shelves

`shared/` contains reviewed snapshots from the HivemindOS Shared Brain. They make the repo self-contained for agents while preserving one executable source of truth in `src/hivemind_content_studio/`.

Included capability groups:

- planning: AI animation factory, script-to-short
- generation: ComfyUI, MUAPI, Seedance, Higgsfield Cloud/consumer, LocalTTS, ElevenLabs/lip-sync TTS, AI UGC production
- sourcing: Pexels, Pixabay
- production: short-video assembly, subtitle timing, video-shot transcript, Auto Clipper
- quality and distribution: media-cache hygiene, video-render QA, social-video publishing

Refresh snapshots from a configured vault with:

```bash
python3 scripts/sync_shared_skills.py
```

The sync command copies only the allowlisted skill directories and never reads `Operations/Secure/` or environment files.

`vendor/clueso-ai/` contains all 90 workflows from the audited, pinned
`clueso-ai/skills` commit. The byte-for-byte upstream snapshot is kept once;
small `clueso-*` adapters apply the studio's central privacy, cost, mutation,
and publishing policy before referring to that source. Relative links under
`.agents/skills/` expose the adapters to general agent runtimes without copying
the workflow bodies. See `vendor/clueso-ai/AUDIT.md` and `PROVENANCE.json`.
