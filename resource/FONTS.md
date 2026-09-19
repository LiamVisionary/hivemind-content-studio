# Fonts in this directory

Every font tracked here is redistributable, and this file is the record of why.
`scripts/generate_notices.py` covers dependencies; fonts are files in the tree,
so they are recorded by hand.

| File | Family | Source | Licence |
|---|---|---|---|
| `BeVietnamPro-Bold.ttf` | Be Vietnam Pro | [Be Vietnam Pro](https://github.com/bekaescapes/be-vietnam-pro) (Google Fonts) | SIL Open Font License 1.1 |
| `BeVietnamPro-Medium.ttf` | Be Vietnam Pro | as above | SIL Open Font License 1.1 |
| `Charm-Bold.ttf` | Charm | [Charm](https://fonts.google.com/specimen/Charm) (Google Fonts) | SIL Open Font License 1.1 |
| `Charm-Regular.ttf` | Charm | as above | SIL Open Font License 1.1 |

`BeVietnamPro-Bold.ttf` is the subtitle default
(`app.utils.utils.DEFAULT_SUBTITLE_FONT`). It covers Latin and Vietnamese. Charm
covers Latin and Thai.

## What was removed, and what happens to a task that names it

These five were tracked here until 2026-09-04 and are gone:

* `MicrosoftYaHeiBold.ttc`, `MicrosoftYaHeiNormal.ttc` — Microsoft YaHei, which
  ships with Windows under a licence that does not permit redistribution.
* `STHeitiLight.ttc`, `STHeitiMedium.ttc` — Apple's STHeiti, which ships with
  macOS under the same kind of terms. `STHeitiMedium.ttc` was the subtitle
  default, so every rendered short burned a font this project had no right to
  ship.
* `UTM Kabel KT.ttf` — from a Vietnamese font pack with no licence anywhere.

None of them carried a licence file, and `THIRD_PARTY_NOTICES.md` never
mentioned them. Together they were 142 MB of a repository that is distributed
under AGPL-3.0-or-later.

Nothing that named them broke. `app.utils.utils.resolve_font_path` takes a font
*name* and looks, in order, at the fonts bundled here, then at the fonts
installed on the machine — including under the names the OS gives those same
faces (`STHeitiMedium.ttc` → `STHeiti Medium.ttc`, `MicrosoftYaHeiBold.ttc` →
`msyhbd.ttc`). So a saved task that still names YaHei renders in YaHei on a
Windows machine that has it, from the user's own copy, and falls back to the
bundled OFL font with a warning that names the fix anywhere else.

A subtitle whose script the chosen face cannot draw is the other half:
`app.services.video.resolve_subtitle_font` checks the glyphs before rendering and
switches to an installed font that covers them (PingFang or STHeiti on macOS,
Microsoft YaHei on Windows, Noto Sans CJK on Linux) rather than emitting blank
subtitles.

## Adding a font

Drop the file in this directory, add a row above with its source and licence, and
pass its file name as `font_name`. `test/studio/test_repo_contract.py` fails if a
font is tracked here without a row in this table.
