# Clueso video workflow shelf

This shelf vendors all 90 audited workflows from `clueso-ai/skills` while
keeping Hivemind Content Studio as the single routing and governance authority.

- `upstream/` is the byte-for-byte pinned source and the single source of truth
  for Clueso workflow content.
- `adapters/` contains small namespaced agent entrypoints. They apply
  `POLICY.md`, then route the agent to the corresponding upstream workflow.
- `.agents/skills/clueso-*` contains relative links to those adapters so general
  agent runtimes can discover them without duplicating content.
- `PROVENANCE.json` records the commit, archive digest, every skill digest, and
  audited installer artifact.

Refresh only from a separately reviewed checkout pinned to the constants in
`scripts/vendor_clueso_skills.py`. A new upstream commit requires a new audit and
an intentional update of those constants; do not bypass the hash checks.

