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
| [L173-L545](../../src/pipeline.js#L173-L545) | `extractVideo` & `runExtractVideoInternal` | **一步到位极速主流程**：<br>1. `inFlightExtractions` 防重锁：同一视频并发重试时直接共享执行中的 Promise；<br>2. `Promise.all` 并发拉取字幕（章节合并入 `transcript.md`）、雪碧图与紧凑纯视频流（复用 `ytdlp_info.json` 省去二次解密）；<br>3. 运行单进程多线程 `scanSinglePassVideoStream` 一步完成两道栅栏检测与候选帧内存 JPEG 捕获；<br>4. 并发合成 `grids/`，并在 `finally` 中按 `keep_video_cache`（默认 `false`）自动清理 `cache/` 临时原视频流。 |
| [L560-L597](../../src/pipeline.js#L560-L597) | `buildPathsOnlyReturnPayload` | **精简防误读返回体**：仅输出关键路径（无字幕时 `transcript: null`；不展开 `sprite_files` 列表避免模型把雪碧图与高清宫格双份重复读取）及一行 `reading_guide`。 |
