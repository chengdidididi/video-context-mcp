# video-context-mcp

将 **YouTube** 与 **Bilibili** 视频（确定性 URL / BV 号 / Video ID）解析并打包为多模态大模型（VLM / Agent）友好的本地上下文包（`3×3` 零遮挡顶栏时间戳拼图 + 二维时间矩阵 JSON + 去重合并时间轴字幕）。

---

## 1. 前置环境依赖

运行本 MCP 服务需要宿主机已安装 **Node.js (`>= 20`)**、**`ffmpeg`**（含 `ffprobe`）以及 **`yt-dlp`**：

```bash
# macOS (Homebrew)
brew install node ffmpeg yt-dlp

# Windows (winget)
winget install OpenJS.NodeJS.LTS Gyan.FFmpeg yt-dlp.yt-dlp
```

---

## 2. 安装与注册方式

### 方式一：从 GitHub 远程拉取直接注册（免 `git clone`，推荐）

无需手动克隆仓库，直接通过 `npx -y github:chengdidididi/video-context-mcp` 拉取运行，所有参数通过外部环境变量注入。

#### A. 在 Magpie 中注册

- **通过 Magpie CLI 一行注册**：
  ```bash
  magpie library mcp add video-context \
    env=VIDEO_CONTEXT_OUTPUT_DIR=/path/to/your/output \
    env="BILIBILI_COOKIE=buvid3=...; SESSDATA=..." \
    timeout=300 \
    -- npx -y github:chengdidididi/video-context-mcp
  ```
- **通过 Magpie 图形界面（`Library → MCP`）添加**：
  - **Name**：`video-context`
  - **Command**：`npx`（macOS GUI 若找不到环境变量可填 `/opt/homebrew/bin/npx`）
  - **Args**：`-y` `github:chengdidididi/video-context-mcp`
  - **Timeout**：`300`（预留长视频流缓存与抽帧时间）
  - **Env**：填入 `VIDEO_CONTEXT_OUTPUT_DIR` 与 `BILIBILI_COOKIE`（见下方配置表），添加后为目标 Agent 打开开关即可。

#### B. 标准 `mcp_config.json` 远程注册（Claude Desktop / Cursor / Antigravity / Cherry Studio 等）

```json
{
  "mcpServers": {
    "video-context": {
      "command": "npx",
      "args": [
        "-y",
        "github:chengdidididi/video-context-mcp"
      ],
      "env": {
        "VIDEO_CONTEXT_OUTPUT_DIR": "/path/to/your/output",
        "BILIBILI_COOKIE": "buvid3=...; SESSDATA=..."
      }
    }
  }
}
```

> **提示**：通过 `npx` 远程运行时，若未显式设置 `VIDEO_CONTEXT_OUTPUT_DIR`，产物默认输出至用户主目录下的 `~/video-context-output/`（避免落入 `~/.npm/_npx` 隐藏临时缓存目录）。

---

### 方式二：克隆到本地目录部署与注册

适合需要持久化保存在本地 `config.yaml` 或二次开发的场景：

```bash
git clone https://github.com/chengdidididi/video-context-mcp.git
cd video-context-mcp
npm install
cp config.example.yaml config.yaml
# 按需编辑 config.yaml 填入 output.dir 与 auth.bilibili_cookie
```

本地挂载配置：

```json
{
  "mcpServers": {
    "video-context": {
      "command": "node",
      "args": [
        "/path/to/video-context-mcp/bin/video-context-mcp.js"
      ],
      "env": {
        "VIDEO_CONTEXT_OUTPUT_DIR": "/path/to/video-context-mcp/output"
      }
    }
  }
}
```

或在 Magpie 中注册本机路径：

```bash
magpie library mcp add video-context --local timeout=300 \
  -- node /path/to/video-context-mcp/bin/video-context-mcp.js
```

---

## 3. 统一配置（`config.yaml` 与外部环境变量映射）

所有设置均支持在本地 [config.example.yaml](./config.example.yaml)（复制为 `config.yaml`）中持久化保存，并与外部环境变量 **1:1 对接**。
覆盖优先级：**`单次工具入参 > 启动参数 (--output-dir) > 外部环境变量 (ENV) > config.yaml > 默认值`**。

| `config.yaml` 字段 | 对应外部环境变量 | 默认值 | 说明 |
| :--- | :--- | :---: | :--- |
| `output.dir` | `VIDEO_CONTEXT_OUTPUT_DIR` | `"./output"` | 产物与流缓存统一输出根目录（`npx` 远程模式默认 `~/video-context-output`） |
| `auth.bilibili_cookie` | `BILIBILI_COOKIE` | `""` | B 站登录 Cookie（支持直接填浏览器请求头 `buvid3=...; SESSDATA=...`，用于获取 `ai-zh` 字幕与 >=480p 视频流；公开 YouTube 视频免配 Cookie） |
| `auth.allow_guest_degraded` | `VIDEO_CONTEXT_ALLOW_GUEST` | `false` | 未配 B 站 Cookie 时是否允许降级为 360p 无 AI 字幕游客模式 |
| `sampling.scene_threshold` | `VIDEO_CONTEXT_SCENE_THRESHOLD` | `0.25` | Tier 2 FFmpeg 场景切换检测阈值（`0.05–0.95`） |
| `sampling.min_interval_sec` | `VIDEO_CONTEXT_MIN_INTERVAL_SEC` | `1.0` | Tier 2 相邻采样帧最小防抖间隔（秒） |
| `sampling.max_interval_sec` | `VIDEO_CONTEXT_MAX_INTERVAL_SEC` | `8.0` | Tier 2 最大静默保底抽帧间隔（秒） |
| `sampling.max_frames` | `VIDEO_CONTEXT_MAX_FRAMES` | `180` | Tier 2 单视频全局最大抽帧上限 |
| `sampling.clip_interval_sec` | `VIDEO_CONTEXT_CLIP_INTERVAL_SEC` | `0.5` | Tier 3 局部显微镜默认抽帧间隔（秒） |
| `sampling.clip_max_span_sec` | `VIDEO_CONTEXT_CLIP_MAX_SPAN_SEC` | `180` | Tier 3 单次局部切片最大允许跨度（秒） |
| `grid.cols` / `grid.rows` | `VIDEO_CONTEXT_GRID_COLS` / `VIDEO_CONTEXT_GRID_ROWS` | `3` / `3` | 网格拼图列数与行数 |
| `grid.cell_width` / `grid.cell_height` | `VIDEO_CONTEXT_CELL_WIDTH` / `VIDEO_CONTEXT_CELL_HEIGHT` | `640` / `360` | 单格画面内容宽高（px，Lanczos 等比居中补黑边） |
| `grid.header_height` | `VIDEO_CONTEXT_HEADER_HEIGHT` | `24` | 单格顶部零遮挡纯黑时间戳栏高度（px） |
| `grid.gutter` / `grid.jpeg_quality` | `VIDEO_CONTEXT_GRID_GUTTER` / `VIDEO_CONTEXT_JPEG_QUALITY` | `2` / `85` | 分隔线宽度（px）与输出 JPEG 质量（`1–100`） |
| `binaries.yt_dlp` / `ffmpeg` / `ffprobe` | `YTDLP_PATH` / `FFMPEG_PATH` / `FFPROBE_PATH` | `""` | 自定义外部二进制路径（留空自动寻址） |

---

## 4. 暴露的 MCP 工具与输出结构

### MCP Tools
- `video_auth_status`：自检二进制依赖、当前生效输出目录、激活的环境变量覆盖项及 B 站实时登录态。
- `video_config`：读取当前生效配置，或将配置修改无损持久化写回 `config.yaml`。
- `video_inspect`（**Tier 1 极速探针**）：1–3 秒内免视频流获取元信息、章节、去重合并后的 `transcript.md` 与平台原生进度条预览雪碧图 `sprites/`。
- `video_extract_grids`（**Tier 2 全局标准档**）：本地缓存 `480p/720p` 纯视频流，融合场景切换 + 字幕语义锚点 + 保底间隔与优先级防抖，输出 `3×3` 零遮挡顶栏时间戳拼图 `grids/` 与二维时间矩阵 `frames_index.json`。
- `video_extract_clip`（**Tier 3 局部显微镜**）：针对指定 `[start_time, end_time]` 区间（复用本地缓存或通过 HTTP Range 切片），按 `0.5s` 高密生成局部拼图或导出无水印高清原图（`output_mode: "raw_frames"`）。
- `video_read_image`：按需单张返回图片的 MCP `ImageContent`（兼容无本地文件读图能力的宿主客户端）。

### 标准 `output` 产物结构
```text
output/
└── <platform>_<video_id>_p<part>/
    ├── manifest.json            # 视频元信息、章节、分P列表与各阶段完成状态
    ├── transcript.md            # 去重合并后的紧凑时间轴字幕（供 AI 直接阅读）
    ├── frames_index.json        # Tier 2 拼图 3x3 二维时间矩阵与帧详情
    ├── subtitles/
    │   └── subtitles.json       # 毫秒级结构化字幕数组
    ├── sprites/                 # Tier 1 平台原生进度条预览雪碧图与索引
    ├── grids/                   # Tier 2 生成的 3x3 零遮挡顶栏时间戳拼图
    ├── clips/                   # Tier 3 局部显微镜拼图或无水印高清原图
    └── cache/                   # 纯视频流缓存（临时抽帧目录自动销毁）
```

---

## 5. 架构流程图与源码导读

完整的全局架构 Mermaid 流程图及全部 15 个核心源码文件的逐行号注释导读文档见 [docs/README.md](./docs/README.md)。
