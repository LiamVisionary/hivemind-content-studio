# RIFE-4.25-MLX — Benchmarks (M5 Max, fp32, GPU)

Single mid-frame interpolation (`Model.inference`), mean of 3 runs.


| Resolution | scale | Latency | Peak mem |
|---|---|---|---|
| 480p (480×854) | 1.0 | 168 ms | 1088 MB |
| 480p (480×854) | 0.5 | 135 ms | 977 MB |
| 720p (720×1280) | 1.0 | 260 ms | 1641 MB |
| 720p (720×1280) | 0.5 | 258 ms | 1513 MB |
| 1080p (1080×1920) | 1.0 | 554 ms | 1931 MB |
| 1080p (1080×1920) | 0.5 | 581 ms | 1865 MB |
| 4K (2160×3840) | 1.0 | 2112 ms | 5016 MB |
| 4K (2160×3840) | 0.5 | 2019 ms | 4878 MB |
