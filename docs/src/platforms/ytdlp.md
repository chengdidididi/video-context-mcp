# `src/platforms/ytdlp.js` 代码导读与注释

- **对应源码**：[ytdlp.js](../../../src/platforms/ytdlp.js#L1-L421)
- **所属层级**：平台适配层（YouTube 全链路与双平台 `yt-dlp` 兜底引擎）
- **下游依赖**：[config.js](../../../src/config.js)、[subtitles.js](../../../src/parsers/subtitles.js)、[exec.js](../../../src/utils/exec.js)、[http.js](../../../src/utils/http.js)

## 1. 模块职责
封装 `yt-dlp` 处理 YouTube 元信息、原音优先字幕提取、`storyboard` 雪碧图提取、纯视频流缓存下载（兼容横屏 16:9 与竖屏 9:16 Shorts）以及 Tier 3 `--download-sections` 流式区间切片，同时作为 B 站下载链路的自动后备引擎。

## 2. 核心函数与关键防坑设计

| 行号范围 | 函数 / 常量名 | 关键实现与 Code Review 关注点 |
| :--- | :--- | :--- |
| [L9-L32](../../../src/platforms/ytdlp.js#L9-L32) | `buildBaseYtDlpArgs` | 构建安全公共参数（`--no-playlist`、`--no-warnings`、自动挂载非空 `--cookies`）。注意：针对 `bilibili` 不强覆盖 `--user-agent`，以保留 `yt-dlp` 内置 `curl-impersonate` 的浏览器指纹一致性。 |
| [L51-L184](../../../src/platforms/ytdlp.js#L51-L184) | `extractSubtitlesFromYtDlpInfo` | **YouTube 自动字幕防 429 核心修复**：<br>- 人工字幕（`manualSubs`）优先选中文，其次原音与英文；<br>- **自动生成字幕（`autoSubs`）强制优先匹配 `/-orig$/i`（如 `en-orig` 原音识别轨）与视频原语言**，且优先挑选不含 `tlang=` 的直链，避开 YouTube 对未登录实时机器翻译轨的 `HTTP 429` 封锁与专有名词机翻失真。<br>- 若直链拉取失败，自动降级调用 `yt-dlp --skip-download --write-subs` 兜底。 |
| [L189-L271](../../../src/platforms/ytdlp.js#L189-L271) | `extractYoutubeStoryboards` | 从 `info.formats` 中筛选分辨率最高的 `sb0/sb1` 格式，下载前 10 张雪碧图分片，并根据每个 `fragment.duration` 与网格行列数精确推算每一小格的时间戳写入 `sprites_index.json`。 |
| [L277-L304](../../../src/platforms/ytdlp.js#L277-L304) | `FORMAT_SELECTORS` | **横竖屏双兼容清晰度回退链**：<br>- `tier2`：同时匹配横屏 `height=480` 与竖屏 Shorts `width=480`，若无 480p 自动**向上回退至 720p**（避免退回低码率 360p 导致文字糊化），最后兜底单流 `b`。<br>- `tier3`：优先匹配 `720p` → `1080p`。 |
| [L309-L366](../../../src/platforms/ytdlp.js#L309-L366) | `ensureCachedVideoStream` | 下载纯视频流至 `cache/`；若 `source_std.*` 或更高清的 `source_hd.*` 已存在且文件完整，直接秒级复用不重复联网。 |
| [L371-L417](../../../src/platforms/ytdlp.js#L371-L417) | `downloadVideoClipSection` | 利用 `yt-dlp --download-sections "*start-end"` 执行真正的 HTTP Range 区间拉流，使 2 小时超长视频只截取其中 30 秒时只需下载几 MB 数据。 |
