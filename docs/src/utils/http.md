# `src/utils/http.js` 代码导读与注释

- **对应源码**：[http.js](../../../src/utils/http.js#L1-L232)
- **所属层级**：底层工具层（Cookie 解析转换与流式 HTTP 传输）

## 1. 模块职责
将来自 `config.yaml` 或 `BILIBILI_COOKIE` 环境变量的字符串解析为标准 HTTP `Cookie` 请求头，支持在极少数需要调用 `yt-dlp` 后备引擎时在 `output/<bundle>/cache/` 下生成用完即焚的临时 Netscape 文件，并提供带停滞熔断的流式下载器。

## 2. 核心函数详解

| 行号范围 | 函数名 | 关键实现与 Code Review 关注点 |
| :--- | :--- | :--- |
| [L10-L81](../../../src/utils/http.js#L10-L81) | `parseCookieEntries` | 同时支持**裸请求头字符串**（`buvid3=...; SESSDATA=...`）与**多行 Netscape 文本**（先剥离 `#HttpOnly_` 前缀再跳过普通 `#` 注释，防止漏读 `SESSDATA`）。 |
| [L87-L105](../../../src/utils/http.js#L87-L105) | `resolveCookieHeader` | 接收内联配置值（若传入的是有效文件路径也兼容读取），去重拼装为 `k1=v1; k2=v2` 请求头供原生 API 直接使用，无需在磁盘常驻任何 `cookies.txt`。 |
| [L110-L123](../../../src/utils/http.js#L110-L123) | `writeTempNetscapeCookieFile` | 仅当 B 站原生直连失败、回退调用外部进程 `yt-dlp` 时，将内存 Cookie 转为临时 Netscape 格式写入 `output/<bundle>/cache/`，由调用方 `finally` 立即删除。 |
| [L154-L232](../../../src/utils/http.js#L154-L232) | `downloadFile` | `headerTimer`（仅管响应头返回前）+ `stallTimer`（流传输期间无数据停滞熔断）+ `Readable.fromWeb` 流式落盘与 `25%` 进度日志。 |
