# `src/pipeline.js` 代码导读与注释

- **对应源码**：[pipeline.js](../../src/pipeline.js#L1-L797)
- **所属层级**：核心业务编排层（Orchestrator）

## 1. 模块职责
统一读取 `config.yaml` 与外部环境变量合并后的动态配置，编排输入归一化、B 站防静默降级鉴权、Tier 1/2/3 三档提取流水线，并确保所有持久化产物与临时中间文件 100% 落入 `output/<bundle_id>/` 目录内。

## 2. 核心函数逐个拆解

| 行号范围 | 函数名 | 核心流程与 Code Review 关注点 |
| :--- | :--- | :--- |
| [L42-L67](../../src/pipeline.js#L42-L67) | `getBundlePaths` & `maskConfigSecrets` | 统一定义 `output/<bundle_id>/` 目录规范；对外返回配置时自动将 `bilibili_cookie` 脱敏为 `<configured: N chars>`，防止敏感凭证被打印进对话上下文。 |
| [L70-L83](../../src/pipeline.js#L70-L83) | `withTempBilibiliCookieFile` | 仅在 B 站回退调用 `yt-dlp` 时在 `output/<bundle>/cache/` 下创建临时 Netscape 文件并在 `finally` 中立即清理，彻底告别常驻 `cookies/` 目录。 |
| [L88-L142](../../src/pipeline.js#L88-L142) | `manageConfig(updates)` | 校验 `output_dir` 可写性并将变更项无损写回 `config.yaml`，同时返回 `env_var_mapping` 对照表。 |
| [L147-L160](../../src/pipeline.js#L147-L160) | `getAuthStatus()` | 聚合系统二进制状态、`config.yaml` 路径、`active_output_dir`、当前激活的环境变量列表以及 B 站登录核验结果。 |
| [L165-L387](../../src/pipeline.js#L165-L387) | `inspectVideo`（**Tier 1**） | B 站走 WBI 原生接口直拉 `ai-zh` 字幕与 `videoshot` 雪碧图；YouTube 免 Cookie 走 `yt-dlp` 拉 `en-orig` 原音轨字幕与 `storyboard`；落盘 `manifest.json`、`transcript.md`、`subtitles/subtitles.json`、`sprites/`。 |
| [L438-L570](../../src/pipeline.js#L438-L570) | `extractVideoGrids`（**Tier 2**） | 动态继承 `config.yaml` / 环境变量中的抽帧与网格规格 → 缓存纯视频流至 `cache/` → 场景检测与字幕融合防抖 → 生成 `grids/` 零遮挡拼图与 `frames_index.json`（临时单帧在 `finally` 中自动销毁）。 |
| [L597-L797](../../src/pipeline.js#L597-L797) | `extractVideoClip`（**Tier 3**） | 复用本地缓存流或通过 `--download-sections` 执行 HTTP Range 区间切片，支持输出局部拼图（`grid`）或无水印高清原图（`raw_frames`）。 |
