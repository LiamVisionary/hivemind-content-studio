Vendored from https://github.com/xocialize/rife-mlx at commit
764b89be56497fb26243d1de75f2957f3889e5d3 (2026-08-10). MIT license (upstream
LICENSE retained). Apple-MLX port of Practical-RIFE 4.25 — used by
bin/rife-interpolate via the repo venv for proper RIFE frame interpolation on
the native MLX lane. Weights auto-download from mlx-community/RIFE-4.25 on
first use. Reinstall into the venv with:
  uv pip install --python .venv/bin/python packages/media-gateway/vendor/rife-mlx
