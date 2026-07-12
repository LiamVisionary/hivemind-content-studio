# Third-party and donor notices

- **MoneyPrinterTurbo** backbone: upstream work is MIT licensed; the original MIT notice remains attributable to its authors in git history and this notice.
- **Auto Clipper** donor: its package metadata declares `AGPL-3.0-or-later`. The combined project is therefore configured as AGPL-3.0-or-later.
- **AI Animation Factory** donor: private, owner-supplied source. Confirm that all contributed prompts/code may be distributed under the combined project's license before making this repository public.
- **Shared Brain skills**: snapshots preserve each skill's own frontmatter/license where provided. They are operational documentation and do not change third-party service or model terms.
- **Clueso video skills**: all 90 upstream workflows are vendored from commit `7f9594ba6d640e26c7da344403b29b9859498bf5` under Apache-2.0. The original license and byte-for-byte skill snapshots are retained under `skills/vendor/clueso-ai/`; project adapters add Hivemind Content Studio governance without replacing the upstream notices. Clueso MCP is an independent remote service whose account, privacy, and usage terms still apply.
- **UGC Lab prompt system**: the `ugc` and `formats` production templates under `src/hivemind_content_studio/templates/catalog/` are adapted from the publicly distributed UGC Lab prompt system and skill pack (`ugc-lab.twoclipping.workers.dev`, retrieved 2026-07-11). The upstream pack ships as installable agent skills with no stated license; the template bodies here are rewrites of that system's techniques (imperfection stacking, lock blocks, negative stacks, format catalog) rather than byte-for-byte copies, with each template's `source` frontmatter naming the origin. Review before commercial redistribution.

This is an engineering provenance note, not legal advice. Preserve upstream notices and review service/model licenses before commercial distribution.
