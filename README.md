# video-context-mcp

将 **YouTube**、**Bilibili** 视频（确定性 URL / BV 号 / Video ID）或**本地视频文件**一步解析并打包为多模态大模型（VLM / Agent）友好的极简本地上下文包（**整合元信息与章节的 `transcript.md` + `3×3` 零遮挡顶栏时间戳拼图 `grids/`**；遇到无字幕视频或带音轨本地视频时自动调用显式指定的云端 ASR 渠道补齐时间轴字幕），**MCP 响应仅回传精简统计与这两个核心输出路径**，消除大段文本与冗余索引文件的上下文损耗。

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

- **通过 Magpie CLI 一行注册（以启用 Cloudflare 或小米 MiMo ASR 为例）**：
  ```bash
  magpie library mcp add video-context \
    env=VIDEO_CONTEXT_OUTPUT_DIR=/path/to/your/output \
    env="BILIBILI_COOKIE=buvid3=...; SESSDATA=..." \
    env=VIDEO_CONTEXT_ASR_PROVIDER=cloudflare \
    env=CLOUDFLARE_ACCOUNT_ID=你的32位Account_ID \
    env=CLOUDFLARE_API_KEY=你的CF_Token \
    timeout=300 \
    -- npx -y github:chengdidididi/video-context-mcp
  ```
- **通过 Magpie 图形界面（`Library → MCP`）添加**：
  - **Name**：`video-context`
  - **Command**：`npx`（macOS GUI 若找不到环境变量可填 `/opt/homebrew/bin/npx`）
  - **Args**：`-y` `github:chengdidididi/video-context-mcp`
  - **Timeout**：`300`
  - **Env**：填入 `VIDEO_CONTEXT_OUTPUT_DIR`、`BILIBILI_COOKIE`、必选渠道 `VIDEO_CONTEXT_ASR_PROVIDER`（如 `cloudflare` / `mimo` / `siliconflow`）及对应渠道 Key（见下方配置表），添加后为目标 Agent 打开开关即可。

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
        "BILIBILI_COOKIE": "buvid3=...; SESSDATA=...",
        "VIDEO_CONTEXT_ASR_PROVIDER": "mimo",
        "MIMO_API_KEY": "sk-..."
      }
    }
  }
}
```

> **提示**：通过 `npx` 远程运行时，若未显式设置 `VIDEO_CONTEXT_OUTPUT_DIR`，产物默认输出至用户主目录下的 `~/video-context-output/`。

---

### 方式二：克隆到本地目录部署与注册

```bash
git clone https://github.com/chengdidididi/video-context-mcp.git
cd video-context-mcp
npm install
cp config.example.yaml config.yaml
# 按需编辑 config.yaml 填入 output.dir 与 auth.bilibili_cookie
```

在 Magpie 中注册本机路径：

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
| `output.dir` | `VIDEO_CONTEXT_OUTPUT_DIR` | `"./output"` | 产物统一输出根目录（`npx` 远程模式默认 `~/video-context-output`） |
| `output.keep_video_cache` | `VIDEO_CONTEXT_KEEP_VIDEO_CACHE` | `false` | 拼图合成后是否保留 `cache/` 下的临时原视频流（默认 `false` 用完即焚，零原片磁盘残留） |
| `runtime.timeout_sec` | `VIDEO_CONTEXT_TIMEOUT_SEC` | `300` | 下载与媒体处理的全局单任务超时上限（秒，默认 5 分钟；执行期间每 5s 发送 MCP `notifications/progress` 心跳保活） |
| `auth.bilibili_cookie` | `BILIBILI_COOKIE` | `""` | B 站登录 Cookie（用于获取 `ai-zh` 字幕与 >=480p 视频流；公开 YouTube 视频免配 Cookie） |
| `auth.allow_guest_degraded` | `VIDEO_CONTEXT_ALLOW_GUEST` | `false` | 未配 B 站 Cookie 时是否允许降级为 360p 无 AI 字幕游客模式 |
| `asr.provider` | `VIDEO_CONTEXT_ASR_PROVIDER` | `""` | **必填指定**的唯一云端 ASR 渠道（如 `"siliconflow"` / `"mimo"` / `"cloudflare"`；触发 ASR 时未指定将直接报错阻断） |
| `asr.language` / `asr.prompt` | `VIDEO_CONTEXT_ASR_LANGUAGE` / `VIDEO_CONTEXT_ASR_PROMPT` | `"auto"` / `""` | ASR 语言提示与可选热词上下文 |
| `asr.providers.siliconflow.*` | `SILICONFLOW_API_KEY` / `SILICONFLOW_MODEL` 等 | `SenseVoiceSmall` | `openai-transcriptions` 协议槽位（短切片赋时档） |
| `asr.providers.mimo.*` | `MIMO_API_KEY` / `MIMO_MODEL` 等 | `mimo-v2.5-asr` | `openai-chat-audio` 协议槽位（自动 Data URL 封装 + 短切片赋时档） |
| `asr.providers.cloudflare.*` | `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_KEY` 等 | `whisper-large-v3-turbo` | `cloudflare` 协议槽位（75~90s 长切片 + 原生逐句时间轴档） |
| `sampling.probe_fps` | `VIDEO_CONTEXT_PROBE_FPS` | `2.5` | 内存灰度探针流采样帧率（默认每 `0.4s` 扫描一次） |
| `sampling.diff_threshold` | `VIDEO_CONTEXT_DIFF_THRESHOLD` | `0.15` | **第一道栅栏**：`8×6` 局部块相对上一入选帧的累积视觉变化阈值 |
| `sampling.settle_threshold` | `VIDEO_CONTEXT_SETTLE_THRESHOLD` | `0.045` | **第二道栅栏**：动后取静（Settle）帧间稳定阈值（跳过滚动模糊与转场残影） |
| `sampling.min_interval_sec` | `VIDEO_CONTEXT_MIN_INTERVAL_SEC` | `0.8` | 相邻入选帧最小防抖间隔（秒） |
| `sampling.max_interval_sec` | `VIDEO_CONTEXT_MAX_INTERVAL_SEC` | `15.0` | 长时间完全静止画面的最大保底间隔（秒） |
| `sampling.max_frames` | `VIDEO_CONTEXT_MAX_FRAMES` | `180` | **全局上限**：单视频最大抽帧总数（超出时按「变化强度 × 时间间距」自动优选裁剪） |
| `grid.cols` / `grid.rows` | `VIDEO_CONTEXT_GRID_COLS` / `VIDEO_CONTEXT_GRID_ROWS` | `3` / `3` | 网格拼图列数与行数 |
| `grid.cell_width` / `grid.cell_height` | `VIDEO_CONTEXT_CELL_WIDTH` / `VIDEO_CONTEXT_CELL_HEIGHT` | `640` / `360` | 单格画面内容宽高（px，Lanczos 等比居中补黑边） |
| `grid.header_height` | `VIDEO_CONTEXT_HEADER_HEIGHT` | `24` | 单格顶部零遮挡纯黑时间戳栏高度（px） |
| `grid.gutter` / `grid.jpeg_quality` | `VIDEO_CONTEXT_GRID_GUTTER` / `VIDEO_CONTEXT_JPEG_QUALITY` | `8` / `85` | 分隔线宽度（px，默认 `8px` 防止视觉 Patch 跨格串行）与输出 JPEG 质量（`1–100`） |
| `binaries.yt_dlp` / `ffmpeg` / `ffprobe` | `YTDLP_PATH` / `FFMPEG_PATH` / `FFPROBE_PATH` | `""` | 自定义外部二进制路径（留空自动寻址） |

---

## 4. 暴露的 MCP 工具与输出结构

### MCP Tools
- `video_extract`（**核心一步提取管线**）：面向模型收敛了全部低层调优参数，仅需传入确定性 URL / BV 号即可一步完成：原音/AI 字幕去重合并（顶部自带元信息、简介与章节目录）、`360p/480p@≤30fps` 轻量纯视频流并发快拉、**单趟多线程 FFmpeg 内存流式扫描（「`8×6` 局部块累积对比 + 动后取静 + 最大帧数优选封顶」）**、`3×3` 零遮挡顶栏时间戳拼图合成（`8px` 宽分隔防串格），落盘后**自动清除临时原视频缓存**，仅回传 `transcript` 与 `grid_files` 路径。
- `video_auth_status`：自检二进制依赖、当前生效输出目录、激活的环境变量覆盖项及 B 站实时登录态。
- `video_config`：读取当前生效配置，或将常用配置无损持久化写回 `config.yaml`。
- `video_read_image`：按需单张返回网格图的 MCP `ImageContent`（兼容无本地文件读图能力的宿主客户端）。

### 标准 `output` 极简产物结构
```text
output/
└── <platform>_<video_id>_p<part>/
    ├── manifest.json            # 轻量完成态缓存清单 (~0.7KB)
    ├── transcript.md            # 整合标题/作者/时长/简介/章节与去重时间轴字幕的唯一文本文件
    └── grids/                   # 两道栅栏+上限精选的 3x3 零遮挡顶栏时间戳拼图 (8px 分隔)
```

---

## 5. 架构流程图与源码导读

完整的全局架构 Mermaid 流程图及全部 15 个核心源码文件的逐行号注释导读文档见 [docs/README.md](./docs/README.md)。
