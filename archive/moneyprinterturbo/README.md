# MoneyPrinterTurbo's own shell, archived

Everything in this directory is the donor project's **user interface**, not its
engine. The engine — `app/` at the repository root — is still live code: the
faceless lane calls it, and its tests still run in `test/services`. What was
archived here is the second UI that shipped alongside it and that this product
never starts: a Streamlit app, its launchers, the donor's HTTP API entry point,
the donor's README, sponsor logos, screenshots, Colab notebook, agent skill and
landing page.

It moved because it was shipping without being used. `scripts/hivemind-studio-stack`
never launched it, the control API has no route to it, and `docs/RELEASE.md` §1
lists it under "not shipped at all" — yet it pulled `streamlit` into every
install, wrote the ruff and coverage configuration around itself, ran seven test
files in CI, and left a second UI on a user's disk that polls
`harry0703/MoneyPrinterTurbo` for releases and offers to update them to a
different product.

Nothing here is deleted, because it is the reference for how the engine's
parameters are meant to be driven, and because the engine's upstream sync
(`[tool.hivemind.upstream]` in `pyproject.toml`) is easier to reconcile with the
donor's own UI in the tree.

## What is here

| Path | What it is |
|---|---|
| `webui/` | The Streamlit app, its styles, `.streamlit` config and 11 locale files |
| `webui.sh`, `webui.bat` | Launchers, repointed at the repository root |
| `main.py` | The donor's uvicorn entry point for `app.asgi:app` |
| `docs/upstream/` | The donor's README |
| `docs/sponsors/`, `docs/*.jpg`, `docs/MoneyPrinterTurbo.ipynb`, `docs/voice-list.txt` | The donor's sponsor logos, screenshots, Colab notebook and voice list |
| `docs/skill/` | `moneyprinterturbo-video`, an agent skill authored by harry0703 |
| `resource/public/index.html` | The donor's landing page |
| `test/` | The seven `test_webui_*.py` files, which follow the UI they cover |

## Running it against `app/`

The dependencies live behind an extra, because five packages that only this
shell and the donor API import are about a third of the venv:

```sh
uv sync --extra faceless-webui
./archive/moneyprinterturbo/webui.sh          # http://127.0.0.1:8501
```

The launcher resolves the repository root itself (two directories up), puts it
on `PYTHONPATH` so `app` resolves to this repository's package rather than a
same-named dependency, and picks a free port in 8501-8599. `resource/fonts` and
`resource/songs` are still read from the repository root — see `resource/FONTS.md`
and `resource/SONGS.md` for what does and does not ship in them.

The donor's HTTP API and its archived tests are run the same way, from the root:

```sh
uv run python archive/moneyprinterturbo/main.py
uv run pytest archive/moneyprinterturbo/test
```

`pytest` does not collect this directory on its own: `testpaths` is `test`.

## Licence

This is the same MoneyPrinterTurbo work described in `THIRD_PARTY_NOTICES.md` —
MIT upstream, attributable to harry0703 and contributors, inside a combined work
that is AGPL-3.0-or-later. The `docs/skill/` skill is the donor's, and the
sponsor logos are their owners' marks, kept only as the historical record of the
donor README they belonged to.
