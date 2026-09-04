# `studio` is not staged in this checkout

The application: the Python package, the two Node services and the three built frontends.

`tauri.conf.json` declares this directory in `bundle.resources`, and
`tauri-build` refuses to compile when a declared resource path does not
exist — which is the gate that stops the app being packaged without its
runtimes. This placeholder is what lets a bare `cargo test` run in a
checkout that has never built anything.

The release build replaces this whole directory:

    python3 scripts/stage_desktop_resources.py

`python3 scripts/stage_desktop_resources.py --verify` fails while this
file is still here, so a build cannot ship the placeholder by accident.
