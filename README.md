# video-context-mcp

An MCP Server that converts deterministic **YouTube** and **Bilibili** URLs / BV IDs into VLM-friendly local **Video Context Bundles** (`3×3` zero-occlusion timestamped grids + 2D timestamp matrix JSON + deduplicated transcript).

## Requirements

- Node.js `>= 20`
- `yt-dlp` and `ffmpeg` / `ffprobe` in `PATH` (e.g. `brew install node ffmpeg yt-dlp`)

## Quick Start

```bash
npm install
cp config.example.yaml config.yaml
```

## Unified Configuration (`config.yaml` + Environment Variables)

All adjustable and persistable settings live in a single `config.yaml` file at the project root (copy from [config.example.yaml](./config.example.yaml)), and **every setting maps 1-to-1 to an external Environment Variable** for Agent MCP Settings UI integration:

**Precedence**: `Per-call Tool Args > Startup CLI (--output-dir) > External Environment Variables > config.yaml > Defaults`

| `config.yaml` Key | Environment Variable | Default | Description |
| :--- | :--- | :---: | :--- |
| `output.dir` | `VIDEO_CONTEXT_OUTPUT_DIR` | `"./output"` | Unified output directory for all bundles & stream caches |
| `auth.bilibili_cookie` | `BILIBILI_COOKIE` | `""` | Bilibili Cookie string (`buvid3=...; SESSDATA=...`) for `ai-zh` subtitles & >=480p streams |
| `auth.allow_guest_degraded` | `VIDEO_CONTEXT_ALLOW_GUEST` | `false` | Allow degraded 360p guest mode on Bilibili when cookie is absent |
| `sampling.scene_threshold` | `VIDEO_CONTEXT_SCENE_THRESHOLD` | `0.25` | Tier 2 FFmpeg scene change threshold |
| `sampling.min_interval_sec` | `VIDEO_CONTEXT_MIN_INTERVAL_SEC` | `1.0` | Tier 2 minimum debounce interval (sec) |
| `sampling.max_interval_sec` | `VIDEO_CONTEXT_MAX_INTERVAL_SEC` | `8.0` | Tier 2 maximum fallback interval (sec) |
| `sampling.max_frames` | `VIDEO_CONTEXT_MAX_FRAMES` | `180` | Tier 2 max sampled frames per video |
| `sampling.clip_interval_sec` | `VIDEO_CONTEXT_CLIP_INTERVAL_SEC` | `0.5` | Tier 3 default microscope interval (sec) |
| `sampling.clip_max_span_sec` | `VIDEO_CONTEXT_CLIP_MAX_SPAN_SEC` | `180` | Tier 3 max clip window span (sec) |
| `grid.cols` / `grid.rows` | `VIDEO_CONTEXT_GRID_COLS` / `VIDEO_CONTEXT_GRID_ROWS` | `3` / `3` | Grid columns and rows |
| `grid.cell_width` / `grid.cell_height` | `VIDEO_CONTEXT_CELL_WIDTH` / `VIDEO_CONTEXT_CELL_HEIGHT` | `640` / `360` | Single frame content dimensions (px) |
| `grid.header_height` | `VIDEO_CONTEXT_HEADER_HEIGHT` | `24` | Zero-occlusion black top timestamp bar height (px) |
| `grid.gutter` / `grid.jpeg_quality` | `VIDEO_CONTEXT_GRID_GUTTER` / `VIDEO_CONTEXT_JPEG_QUALITY` | `2` / `85` | Cell separator width (px) & JPEG quality |
| `binaries.yt_dlp` / `ffmpeg` / `ffprobe` | `YTDLP_PATH` / `FFMPEG_PATH` / `FFPROBE_PATH` | `""` | Optional custom binary paths |

*(Note: Public YouTube videos require zero cookies. Override YAML location via `VIDEO_CONTEXT_CONFIG_PATH` if needed.)*

## MCP Server Configuration

```json
{
  "mcpServers": {
    "video-context": {
      "command": "node",
      "args": [
        "/path/to/video-context-mcp/bin/video-context-mcp.js"
      ],
      "env": {
        "VIDEO_CONTEXT_OUTPUT_DIR": "/path/to/video-context-mcp/output",
        "BILIBILI_COOKIE": "buvid3=...; SESSDATA=..."
      }
    }
  }
}
```

## MCP Tools

- `video_auth_status`: Check binary availability, active output directory, active env overrides, and live Bilibili login status.
- `video_config`: Read effective configuration or persist updates directly into `config.yaml`.
- `video_inspect` (**Tier 1**): Fast probe (~1–3s, zero video stream download) outputting `manifest.json`, deduplicated `transcript.md`, and native progress-bar `sprites/`.
- `video_extract_grids` (**Tier 2**): Cache `480p`/`720p` pure video stream, fuse scene detection + subtitle anchors + fallback with debounce, and compose zero-occlusion timestamped `3×3` grids (`grids/` + `frames_index.json`).
- `video_extract_clip` (**Tier 3**): Extract high-density frames (`0.5s`) or clean unwatermarked HD `raw_frames` for a specific `[start_time, end_time]` window.
- `video_read_image`: Return a single generated image as MCP `ImageContent`.

## Architecture & Code Walkthrough

See [docs/README.md](./docs/README.md) for the end-to-end Mermaid architecture diagram and file-by-file code annotations.
