# `desktop-python` is not staged in this checkout

The frozen interpreter, the desktop dependency set and the static ffmpeg/ffprobe pair.

`tauri.conf.json` declares this directory in `bundle.resources`, and
`tauri-build` refuses to compile when a declared resource path does not
exist — which is the gate that stops the app being packaged without its
runtimes. This placeholder is what lets a bare `cargo test` run in a
checkout that has never built anything.

The release build replaces this whole directory:

    scripts/build_desktop_python.py --build desktop/src-tauri/resources/desktop-python --ffmpeg-dir vendor/ffmpeg/darwin-arm64

`python3 scripts/stage_desktop_resources.py --verify` fails while this
file is still here, so a build cannot ship the placeholder by accident.
