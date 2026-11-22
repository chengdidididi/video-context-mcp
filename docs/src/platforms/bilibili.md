# `src/platforms/bilibili.js` 代码导读与注释

- **对应源码**：[bilibili.js](../../../src/platforms/bilibili.js#L1-L479)
- **所属层级**：平台适配层（Bilibili 原生 WBI 接口与高速分片流引擎）
- **下游依赖**：[subtitles.js](../../../src/parsers/subtitles.js)、[http.js](../../../src/utils/http.js)、[exec.js](../../../src/utils/exec.js)

## 1. 模块职责
针对 B 站深度定制的高可靠性原生客户端：涵盖 WBI 动态参数签名、`buvid3` 浏览器指纹自举（防 `-412` 封禁）、多 P 视频与章节读取、`ai-zh` 字幕直拉、`videoshot` 官方进度条雪碧图获取，以及基于官方 `upos` CDN 镜像优选与 `4MB` HTTP Range 并发的纯视频流下载器。

## 2. 核心函数与反风控设计详解

| 行号范围 | 函数名 | 核心原理与 Code Review 关注点 |
| :--- | :--- | :--- |
| [L10-L37](../../../src/platforms/bilibili.js#L10-L37) | `getMixinKey` & `signWbiParams` | 标准 B 站 WBI 签名实现：通过 64 位置换表 `MIXIN_KEY_ENC_TAB` 打乱 `imgKey + subKey` 取前 32 位，过滤 `!'()*` 特殊字符后按字典序拼接参数与当前秒级时间戳 `wts`，计算 MD5 生成 `w_rid`。 |
| [L43-L67](../../../src/platforms/bilibili.js#L43-L67) | `ensureBilibiliFingerCookies` | **防 `-412 request was banned` 关键机制**：当用户仅复制了部分 Cookie（缺 `buvid3`）或处于游客模式时，自动调用 `/x/frontend/finger/spi` 获取合法 `buvid3`、`buvid4` 并拼入进程级缓存。 |
| [L72-L131](../../../src/platforms/bilibili.js#L72-L131) | `fetchBilibiliView` | 调用 WBI 签名的 `/x/web-interface/wbi/view`，获取 `bvid`、`aid`、全部分 P 列表 `pages`（含每集独立 `cid` 与分辨率）并校验目标 `part` 是否越界。 |
| [L136-L210](../../../src/platforms/bilibili.js#L136-L210) | `fetchBilibiliSubtitlesAndChapters` | 调用 `/x/player/wbi/v2` 同时拿到官方章节 `view_points` 与字幕列表；按**人工中文字幕 > 人工其他语种 > `ai-zh` AI 中文字幕 > 其他 AI 字幕**打分选优，直拉 BCC JSON 清洗。 |
| [L215-L279](../../../src/platforms/bilibili.js#L215-L279) | `fetchBilibiliVideoshot` | 调用 `/x/player/videoshot?index=1` 拉取 `10×10` 进度条预览拼图至 `sprites/`，并将官方精确到秒的 `index` 时间数组按页切分写入 `sprites/sprites_index.json`。 |
| [L285-L379](../../../src/platforms/bilibili.js#L285-L379) | `downloadBilibiliDashStream` & `rankBilibiliCdnUrls` | 1. 请求 `fnval=4048` 获取纯视频 `.m4s` DASH 流（单文件 fMP4，FFmpeg 原生可读，彻底省去音频带宽）。<br>2. **清晰度与带宽优选**：Tier 2 按 `480p (32) > 720p (64) > 360p (16)` 排序，**同画质优先选更低 `bandwidth`（AV1/HEVC）**，长视频体积直降约 60%。<br>3. **防 `HTTP 567` 镜像打分**：对 `baseUrl` 和 `backupUrl` 按域名评分，强制优先走官方云厂商 `upos-*.bilivideo.com` 节点，将易断流的 `mcdn` / `szbdyd` PCDN 节点排到末尾。 |
| [L381-L479](../../../src/platforms/bilibili.js#L381-L479) | `downloadFromMirrorList` & `downloadRangeChunked` | **绕过单连接 `250KB/s` 限速设计**：先发 `Range: bytes=0-0` 探测总字节数；对 `>4MB` 的视频流拆分为 `4MB` 切片，使用 4 个并发 Worker 按字节偏移 `fh.write(buf, 0, len, chunk.start)` 写入 `.part` 临时文件（每个切片均处于 CDN 首包加速窗口内，且最多重试 3 次），全部写完后原子重命名为正式缓存文件。 |
