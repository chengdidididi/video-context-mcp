# Video Context MCP 全局架构流程与 Code Review 导读总览

本文档包含基于**统一 `config.yaml` + 外部环境变量双向对接 + 单一 `output/` 输出目录**定稿后的全局端到端流程 Mermaid 图、配置映射表及全部 15 个核心源码文件的逐文件注释索引。

---

## 1. 全局端到端架构与配置/数据流图

```mermaid
flowchart TD
    subgraph CfgSource["0. 统一配置源 (单次入参 > 环境变量 > config.yaml > 默认值)"]
        EnvVars["Agent 外部环境变量 (VIDEO_CONTEXT_* / BILIBILI_COOKIE)"] --> ConfigHub["src/config.js (loadEffectiveConfig & saveConfigUpdates)"]
        YamlFile["config.yaml (唯一持久化配置文件, 保留注释写回)"] <--> ConfigHub
    end

    subgraph Entry["1. 接入与入口层 (bin/ & src/mcp-server.js)"]
        MCPClient["MCP 客户端 (Stdio JSON-RPC)"] --> BinMCP["bin/video-context-mcp.js"]
        BinMCP --> MCPServer["src/mcp-server.js (6 Tools + Zod 校验)"]
        MCPServer --> Pipeline["src/pipeline.js (核心业务编排)"]
        ConfigHub --> Pipeline
    end

    subgraph PreCheck["2. 寻址归一化与鉴权守卫 (url-parser / auth)"]
        Pipeline -- "video_config 工具" --> YamlFile
        Pipeline --> UrlParse["url-parser.resolveVideoInput (URL / BV / av / b23.tv / YT ID 归一化)"]
        UrlParse --> PlatformBranch{"平台分流"}
        PlatformBranch -- "Bilibili" --> BiliAuth["auth.ensureBilibiliAuth (读 BILIBILI_COOKIE 或 config.yaml 验 nav 登录态)"]
        BiliAuth -- "未登录且未开 allow_guest" --> AuthBlock["抛出 AuthRequiredError (拦截 360p 无字幕静默降级)"]
    end

    subgraph Tier1["3. Tier 1: video_inspect 极速探针档 (1-3s, 零视频流)"]
        BiliAuth -- "验证通过" --> BiliT1["bilibili.js: WBI view + player/v2 (ai-zh 字幕/章节) + videoshot 雪碧图"]
        PlatformBranch -- "YouTube (公开视频免 Cookie)" --> YtT1["ytdlp.js: dump-single-json + en-orig 原音优先字幕 + storyboard 雪碧图"]
        BiliT1 --> SubClean["subtitles.js: 滚动重叠去重 + 短句语义合并"]
        YtT1 --> SubClean
        SubClean --> WriteT1["落盘 output/<bundle_id>/: manifest.json + transcript.md + subtitles/ + sprites/"]
    end

    subgraph Tier2["4. Tier 2: video_extract_grids 全局标准档"]
        WriteT1 --> StreamDL{"缓存纯视频流至 output/<bundle_id>/cache/"}
        StreamDL -- "Bilibili" --> BiliDash["bilibili.downloadBilibiliDashStream (upos 镜像优选 + 4MB Range 4路并发)"]
        StreamDL -- "YouTube / B站后备" --> YtStream["ytdlp.ensureCachedVideoStream (480p -> 720p 向上回退)"]
        BiliDash --> SceneDet["ffmpeg.probeVideo + detectSceneChanges"]
        YtStream --> SceneDet
        SceneDet --> Sampler["sampler.buildHybridSamplePlan (场景 + 字幕锚点 + 保底 + 优先级防抖)"]
        Sampler --> ExtractF["ffmpeg.extractLanczosFrames (Lanczos 等比居中补黑边)"]
        ExtractF --> GridComp["grid-composer.composeGrids (Sharp 顶栏 SVG 水印 + 网格拼合)"]
        GridComp --> WriteT2["落盘 output/<bundle_id>/: grids/*.jpg + frames_index.json"]
    end

    subgraph Tier3["5. Tier 3: video_extract_clip 局部显微镜档"]
        WriteT1 --> ClipSrc{"本地 cache/ 已有满足画质视频流?"}
        ClipSrc -- "是" --> ReuseCache["直接本地 FFmpeg -ss 毫秒级寻址"]
        ClipSrc -- "否 (超长视频按需切片)" --> RangeDL["ytdlp.downloadVideoClipSection (--download-sections Range 切片)"]
        ReuseCache --> ModeBranch{"output_mode"}
        RangeDL --> ModeBranch
        ModeBranch -- "grid" --> ClipGrid["生成局部顶栏时间戳拼图 -> clips/<slug>/"]
        ModeBranch -- "raw_frames" --> ClipRaw["导出 720p/1080p 无水印高清原图 -> clips/<slug>/raw_frames/"]
    end
```

---

## 2. 统一 `config.yaml` 与外部环境变量映射表

所有可调控设置均集中在项目根目录唯一的 `config.yaml`（模板见 [config.example.yaml](../config.example.yaml)），并支持在任意 Agent 的环境变量设置面板中直接覆盖：

| `config.yaml` 字段路径 | 对应外部环境变量名 | 默认值 | 说明 |
| :--- | :--- | :---: | :--- |
| `output.dir` | `VIDEO_CONTEXT_OUTPUT_DIR` | `"./output"` | 产物与缓存统一输出根目录 |
| `auth.bilibili_cookie` | `BILIBILI_COOKIE` | `""` | B 站登录 Cookie 字符串（获取 `ai-zh` 字幕与 >=480p 流） |
| `auth.allow_guest_degraded` | `VIDEO_CONTEXT_ALLOW_GUEST` | `false` | 未登录时是否允许降级为 360p 无字幕游客模式 |
| `sampling.scene_threshold` | `VIDEO_CONTEXT_SCENE_THRESHOLD` | `0.25` | Tier 2 视觉场景切换阈值 |
| `sampling.min_interval_sec` | `VIDEO_CONTEXT_MIN_INTERVAL_SEC` | `1.0` | Tier 2 最小防抖间隔（秒） |
| `sampling.max_interval_sec` | `VIDEO_CONTEXT_MAX_INTERVAL_SEC` | `8.0` | Tier 2 最大静默保底间隔（秒） |
| `sampling.max_frames` | `VIDEO_CONTEXT_MAX_FRAMES` | `180` | Tier 2 全片最大抽帧上限 |
| `sampling.clip_interval_sec` | `VIDEO_CONTEXT_CLIP_INTERVAL_SEC` | `0.5` | Tier 3 局部显微镜默认间隔（秒） |
| `sampling.clip_max_span_sec` | `VIDEO_CONTEXT_CLIP_MAX_SPAN_SEC` | `180` | Tier 3 单次最大跨度（秒） |
| `grid.cols` / `grid.rows` | `VIDEO_CONTEXT_GRID_COLS` / `VIDEO_CONTEXT_GRID_ROWS` | `3` / `3` | 拼图列数与行数 |
| `grid.cell_width` / `grid.cell_height` | `VIDEO_CONTEXT_CELL_WIDTH` / `VIDEO_CONTEXT_CELL_HEIGHT` | `640` / `360` | 单格内容宽高（px） |
| `grid.header_height` | `VIDEO_CONTEXT_HEADER_HEIGHT` | `24` | 顶部零遮挡黑边高度（px） |
| `grid.gutter` / `grid.jpeg_quality` | `VIDEO_CONTEXT_GRID_GUTTER` / `VIDEO_CONTEXT_JPEG_QUALITY` | `2` / `85` | 分隔线宽度（px）与 JPEG 质量 |
| `binaries.yt_dlp` / `ffmpeg` / `ffprobe` | `YTDLP_PATH` / `FFMPEG_PATH` / `FFPROBE_PATH` | `""` | 外部二进制路径覆盖 |

---

## 3. 全量已实现模块与注释文档索引表（15 个核心文件）

| 层级 | 已实现源码文件 | 行数 | 对应代码注释导读文档 | 核心审查点摘要 |
| :--- | :--- | :---: | :--- | :--- |
| **入口层** | [bin/video-context-mcp.js](../bin/video-context-mcp.js) | 20 | [docs/bin/video-context-mcp.md](./bin/video-context-mcp.md) | `--output-dir` 启动参数注入、纯净 `stdout` 保护 |
| **配置层** | [src/config.js](../src/config.js) | 293 | [docs/src/config.md](./src/config.md) | 单一 `config.yaml` 读写（保留注释 AST 更新）+ 19 项环境变量双向映射 |
| **协议层** | [src/mcp-server.js](../src/mcp-server.js) | 346 | [docs/src/mcp-server.md](./src/mcp-server.md) | 6 个 MCP 工具（含统一配置读写工具 `video_config`）与 Zod 校验 |
| **编排层** | [src/pipeline.js](../src/pipeline.js) | 797 | [docs/src/pipeline.md](./src/pipeline.md) | 动态配置继承、Cookie 脱敏、Tier 1/2/3 编排、`output/` 规整落盘 |
| **工具层** | [src/utils/exec.js](../src/utils/exec.js) | 82 | [docs/src/utils/exec.md](./src/utils/exec.md) | 数组参数 `spawn` 防 Shell 注入、`SIGKILL` 超时控制、有界并发池 |
| **工具层** | [src/utils/http.js](../src/utils/http.js) | 232 | [docs/src/utils/http.md](./src/utils/http.md) | 裸请求头与 `#HttpOnly_` 解析、临时 Netscape 生成、流式写盘防卡死 |
| **工具层** | [src/utils/time.js](../src/utils/time.js) | 118 | [docs/src/utils/time.md](./src/utils/time.md) | 多格式时间输入解析、防 `:60.0` 进位 Bug、跨平台安全文件名 |
| **解析层** | [src/parsers/url-parser.js](../src/parsers/url-parser.js) | 195 | [docs/src/parsers/url-parser.md](./src/parsers/url-parser.md) | 双平台 URL/BV/av/`b23.tv`/Shorts 归一化、模糊标题拦截 |
| **解析层** | [src/parsers/subtitles.js](../src/parsers/subtitles.js) | 277 | [docs/src/parsers/subtitles.md](./src/parsers/subtitles.md) | BCC/`json3`/VTT 解析、滚动字幕后缀-前缀重叠去重、短句合并 |
| **平台层** | [src/platforms/auth.js](../src/platforms/auth.js) | 149 | [docs/src/platforms/auth.md](./src/platforms/auth.md) | 专注 B 站 `nav` 登录态校验 + WBI 提取 |
| **平台层** | [src/platforms/bilibili.js](../src/platforms/bilibili.js) | 479 | [docs/src/platforms/bilibili.md](./src/platforms/bilibili.md) | WBI 签名、`buvid3` 自举防 `-412`、`upos` 镜像优选、`4MB` Range 并发拉流 |
| **平台层** | [src/platforms/ytdlp.js](../src/platforms/ytdlp.js) | 421 | [docs/src/platforms/ytdlp.md](./src/platforms/ytdlp.md) | YouTube `*-orig` 原音轨优先防 429、横竖屏 480p→720p 选择器、区间切片 |
| **媒体层** | [src/media/sampler.js](../src/media/sampler.js) | 186 | [docs/src/media/sampler.md](./src/media/sampler.md) | 场景+字幕+保底多信号融合、`scene > subtitle` 优先级替换防抖 |
| **媒体层** | [src/media/ffmpeg.js](../src/media/ffmpeg.js) | 202 | [docs/src/media/ffmpeg.md](./src/media/ffmpeg.md) | `-fps_mode vfr` 场景检测、Lanczos 超采样补黑边、片尾 EOF 回退重试 |
| **媒体层** | [src/media/grid-composer.js](../src/media/grid-composer.js) | 168 | [docs/src/media/grid-composer.md](./src/media/grid-composer.md) | `sharp` 零遮挡 SVG 顶栏渲染、动态网格拼合与二维时间矩阵生成 |
