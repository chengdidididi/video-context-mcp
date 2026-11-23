# `src/pipeline.js` 代码导读与注释

- **对应源码**：[pipeline.js](../../src/pipeline.js#L1-L561)
- **所属层级**：核心业务编排层（一步到位提取管线）

## 1. 模块职责
已移除旧版三层拆分逻辑，统一收敛为单一核心管线 `extractVideo`，一步串联寻址鉴权、元数据/去重字幕/官方雪碧图拉取、纯视频流缓存、两道栅栏+上限采样、零遮挡 `3×3` 拼图合成，并**严格只返回统计摘要与已落盘文件路径（零大段文本内联）**。

## 2. 核心函数拆解

| 行号范围 | 函数名 | 核心流程与 Code Review 关注点 |
| :--- | :--- | :--- |
| [L40-L78](../../src/pipeline.js#L40-L78) | `getBundlePaths` / `maskConfigSecrets` / `withTempBilibiliCookieFile` | 统一定义 `output/<bundle_id>/` 目录结构；对外配置展示自动脱敏 Cookie；`yt-dlp` 后备调用所需的临时 Netscape 文件用完即删。 |
| [L83-L137](../../src/pipeline.js#L83-L137) | `manageConfig` | 校验并持久化更新 `config.yaml` 中的 19 项参数。 |
| [L142-L155](../../src/pipeline.js#L142-L155) | `getAuthStatus` | 汇总二进制依赖、当前生效输出路径、环境变量覆盖项与 B 站实时登录态。 |
| [L170-L503](../../src/pipeline.js#L170-L503) | `extractVideo` | **一步到位主流程**：<br>1. 若目标 Bundle 已完成且未设 `force`，毫秒级直接返回路径清单；<br>2. 拉取元信息、去重合并字幕 `transcript.md` 与平台原生进度条雪碧图 `sprites/`；<br>3. 缓存 `480p -> 720p` 纯视频流至 `cache/`；<br>4. 运行 `scanGrayscaleProbeStream` + `createTwoGateTracker` + `finalizeSamplePlan`；<br>5. 抽取高清帧合成 `grids/` 与 `frames_index.json`（临时帧目录在 `finally` 中销毁）。 |
| [L520-L561](../../src/pipeline.js#L520-L561) | `buildPathsOnlyReturnPayload` | **精简返回体构建**：仅输出元信息数字统计与 `paths` 绝对路径字典（含 `manifest`、`transcript`、`frames_index`、`sprite_files`、`grid_files`），将单次 MCP 响应体控制在约 200 Tokens，彻底消除永久上下文负担。 |
