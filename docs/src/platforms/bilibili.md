# `src/platforms/bilibili.js` 代码导读与注释

- **对应源码**：[bilibili.js](../../../src/platforms/bilibili.js#L1-L479)
- **所属层级**：平台适配层（Bilibili 原生 WBI 接口与高速分片流引擎）
- **下游依赖**：[subtitles.js](../../../src/parsers/subtitles.js)、[http.js](../../../src/utils/http.js)、[exec.js](../../../src/utils/exec.js)

## 1. 模块职责
针对 B 站深度定制的高可靠性原生客户端：涵盖 WBI 动态参数签名、`buvid3` 浏览器指纹自举（防 `-412` 封禁）、多 P 视频与章节读取、`ai-zh` 字幕直拉，以及基于官方 `upos` CDN 镜像优选与 `4MB` HTTP Range 并发的纯视频流下载器。

## 2. 核心函数与反风控设计详解

| 行号范围 | 函数名 | 核心原理与 Code Review 关注点 |
| :--- | :--- | :--- |
| [L11-L38](../../../src/platforms/bilibili.js#L11-L38) | `getMixinKey` & `signWbiParams` | 标准 B 站 WBI 签名实现：通过 64 位置换表 `MIXIN_KEY_ENC_TAB` 打乱 `imgKey + subKey` 取前 32 位，过滤 `!'()*` 特殊字符后按字典序拼接参数与当前秒级时间戳 `wts`，计算 MD5 生成 `w_rid`。 |
| [L44-L68](../../../src/platforms/bilibili.js#L44-L68) | `ensureBilibiliFingerCookies` | **防 `-412 request was banned` 关键机制**：当用户仅复制了部分 Cookie（缺 `buvid3`）或处于游客模式时，自动调用 `/x/frontend/finger/spi` 获取合法 `buvid3`、`buvid4` 并拼入进程级缓存。 |
| [L73-L132](../../../src/platforms/bilibili.js#L73-L132) | `fetchBilibiliView` | 调用 WBI 签名的 `/x/web-interface/wbi/view`，获取 `bvid`、`aid`、全部分 P 列表 `pages`（含每集独立 `cid` 与分辨率）并校验目标 `part` 是否越界。 |
| [L137-L211](../../../src/platforms/bilibili.js#L137-L211) | `fetchBilibiliSubtitlesAndChapters` | 调用 `/x/player/wbi/v2` 同时拿到官方章节 `view_points` 与字幕列表；按**人工中文字幕 > 人工其他语种 > `ai-zh` AI 中文字幕 > 其他 AI 字幕**打分选优，直拉 BCC JSON 清洗。 |
| [L217-L309](../../../src/platforms/bilibili.js#L217-L309) | `downloadBilibiliDashStream` & `rankBilibiliCdnUrls` | 请求 `fnval=4048` 获取纯视频 `.m4s` DASH 流；优先 `480p (32) > 360p (16) > 720p (64)`、`≤35fps` 与最低带宽，并强制优先走官方云厂商 `upos-*.bilivideo.com` 节点避开 PCDN `HTTP 567`。 |
| [L311-L410](../../../src/platforms/bilibili.js#L311-L410) | `downloadFromMirrorList` & `downloadRangeChunked` | **绕过单连接 `250KB/s` 限速设计**：对 `>4MB` 的视频流拆分为 `4MB` 切片，4 并发 Worker 按字节偏移写入 `.part` 临时文件后原子重命名。 |
