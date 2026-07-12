# Clueso skills security audit

Verdict: **conditionally approved** for project-local, provider-namespaced use.
No malicious payload was found. The conditions are the policy adapter, remote
data-disclosure warning, explicit provider selection, and existing studio gates.

## Audited source

- Repository: `https://github.com/clueso-ai/skills.git`
- Commit: `7f9594ba6d640e26c7da344403b29b9859498bf5`
- Git archive SHA-256: `71075831131584ab199063deb1f03ed4d3a057693d61dd06a55227a4a2e66039`
- License: Apache-2.0
- Contents: 90 skill directories, each containing only `SKILL.md`
- Commit signatures: the current 2026-07-10 commits are not signed; earlier
  commits include GitHub-verified signatures. Pinning and hashes therefore
  provide reproducibility, not author cryptographic identity for the current tip.

Static inspection found no symlinks, binaries, large files, executable skill
payloads, lifecycle manifests, encoded blobs, HTML comments, bidirectional text
controls, shell command blocks, credential collection, or hidden environment
access. The repository's only executable code is its stdlib validation script
and GitHub workflows; neither is installed. The deploy workflow sends its own
repository secret only to GitHub's repository-dispatch API when Clueso runs it.

All 90 skills declare `requires: clueso-mcp`. Their upstream metadata says
`external-apis: none`, but operationally Clueso MCP is a remote API and many
workflows upload media or mutate projects. Every skill also repeats provider
setup language that favors Clueso and includes Claude-specific installation
guidance. The project adapters correct that metadata and make routing/runtime
neutral without changing the byte-for-byte upstream reference material.

## Installer audit

The suggested shorthand currently resolves to `skills@1.5.16` from
`vercel-labs/skills`.

- npm integrity: `sha512-O+pjcrnm5WkSSBD3WJxjdDssE+oynm7k1LnKMjXvsVeQdmKmY/a+gi6WUOhyGVIYptkFmBBEho/zyf22UtN6cw==`
- Tarball SHA-256: `f7f0177345ed74c8a28990fde2c05a4e4967919fd264cc73bde5def9003ec2e0`
- Lifecycle behavior: no install/postinstall hook in the published package
- Production dependency audit: zero known vulnerabilities reported on 2026-07-11
- Network behavior: clones/fetches the source, queries a Vercel security-audit
  endpoint, and sends install telemetry to `add-skill.vercel.sh` unless telemetry
  is disabled; audit lookup itself is not governed by the telemetry flag
- Filesystem behavior: can overwrite canonical skill directories, create agent
  symlinks/copies, and write project/global lock state

An empty-home sandbox run used the audited CLI against the pinned local checkout
with `DO_NOT_TRACK=1`. It copied exactly 90 byte-identical skills into the
disposable project and wrote nothing outside it. The real repository does not
run the network shorthand: `scripts/vendor_clueso_skills.py` validates the
source commit, origin, clean state, archive hash, file shape, and then creates
the immutable snapshot plus namespaced DRY adapters without telemetry.

