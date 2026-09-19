# Background music

**This directory ships empty.** Nothing tracked, nothing bundled in the desktop
build.

Until 2026-09-04 it carried 29 MP3s (`output000.mp3` … `output028.mp3`, 55 MB)
inherited from the MoneyPrinterTurbo donor. They had no provenance of any kind —
no artist, no source, no licence — and upstream's README only said where they
lived. Redistributing them inside an AGPL-3.0-or-later release was the single
most likely thing in this repository to draw a takedown, so they were removed.

## What that changes

Nothing that had music keeps it, and nothing that had none reports an error.

* `bgm_type` still defaults to `random`, which now means *one of yours*.
  `app.services.bgm.list_bgm_files` reads this directory **and** the uploads
  directory (`storage/bgm`), so a track you add to either is in the pool.
* With both empty, `app.services.video.get_bgm_file` returns no file and the
  render continues with narration only. The log line says where to put a track
  and how to turn background music off, rather than naming a file that is gone.
* `--bgm-file` and the app's own upload path are unaffected: they resolve inside
  `storage/bgm` first and this directory second.

## Adding music

Put the file here (or upload it in the app, which writes to `storage/bgm`), and
record it below with where it came from and under what terms. Supported
extensions are in `app.services.bgm.SUPPORTED_BGM_EXTENSIONS`.

| File | Source | Licence |
|---|---|---|
| _(none)_ | | |

Anything added here is redistributed with the app, so CC0 or a track you own
outright is the only safe kind. A track licensed to you personally belongs in
`storage/bgm`, which is your machine's state and is never packaged.
