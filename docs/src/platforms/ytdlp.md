# `src/platforms/ytdlp.js` 代码导读与注释

- **对应源码**：[ytdlp.js](../../../src/platforms/ytdlp.js#L1-L421)
- **所属层级**：平台适配层（YouTube 全链路与双平台 `yt-dlp` 兜底引擎）
- **下游依赖**：[config.js](../../../src/config.js)、[subtitles.js](../../../src/parsers/subtitles.js)、[exec.js](../../../src/utils/exec.js)、[http.js](../../../src/utils/http.js)

## 1. 模块职责
封装 `yt-dlp` 处理 YouTube 元信息、原音优先字幕提取与轻量纯视频流并发下载（兼容横屏 16:9 与竖屏 9:16 Shorts），同时作为 B 站下载链路的自动后备引擎。

## 2. 核心函数与关键防坑设计

| 行号范围 | 函数 / 常量名 | 关键实现与 Code Review 关注点 |
| :--- | :--- | :--- |
| [L9-L32](../../../src/platforms/ytdlp.js#L9-L32) | `buildBaseYtDlpArgs` | 构建安全公共参数（`--no-playlist`、`--no-warnings`、自动挂载非空 `--cookies`）。注意：针对 `bilibili` 不强覆盖 `--user-agent`，以保留 `yt-dlp` 内置 `curl-impersonate` 的浏览器指纹一致性。 |
| [L51-L184](../../../src/platforms/ytdlp.js#L51-L184) | `extractSubtitlesFromYtDlpInfo` | **YouTube 自动字幕防 429 核心修复**：<br>- 人工字幕（`manualSubs`）优先选中文，其次原音与英文；<br>- **自动生成字幕（`autoSubs`）强制优先匹配 `/-orig$/i`（如 `en-orig` 原音识别轨）与视频原语言**，且优先挑选不含 `tlang=` 的直链，避开 YouTube 对未登录实时机器翻译轨的 `HTTP 429` 封锁与专有名词机翻失真。<br>- 若直链拉取失败，自动降级调用 `yt-dlp --skip-download --write-subs` 兜底。 |
| [L203-L281](../../../src/platforms/ytdlp.js#L203-L281) | `selectOptimalYtDlpFormat` | **JS 精准体积/解码选流器**：直接从 `info.formats` 中筛选短边匹配 `360p–480p`、直连 `https` 协议（避开体积暴涨 4 倍的 `m3u8` 切片流）、`≤35fps`（避开 `60fps` 翻倍体积与解码耗时）、纯视频轨且优先 H.264 (`avc1`) 的最小流。 |
| [L286-L369](../../../src/platforms/ytdlp.js#L286-L369) | `ensureCachedVideoStream` | 优先通过 `--load-info-json` 复用已获取的元数据（彻底省去第二次网页请求与 Deno JS 挑战求解耗时），并开启 `--concurrent-fragments 4 --http-chunk-size 10M` 绕开单连接限速。 |
