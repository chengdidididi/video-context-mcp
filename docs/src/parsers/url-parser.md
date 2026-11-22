# `src/parsers/url-parser.js` 代码导读与注释

- **对应源码**：[url-parser.js](../../../src/parsers/url-parser.js#L1-L195)
- **所属层级**：解析层（确定性视频标识归一化）
- **下游依赖**：[http.js](../../../src/utils/http.js)（仅用于 `b23.tv` 302 短链还原）

## 1. 模块职责
将用户或上层 AI 传入的各种确定性视频链接、短链、分享口令或裸 ID 归一化为标准结构 `{ platform, videoId, idType, part, partExplicit, canonicalUrl }`，并**显式拒绝模糊标题输入**（符合 SPEC 1.3 单一职责边界）。

## 2. 解析分支拆解

| 行号范围 | 处理分支 | 逻辑说明与 Code Review 关注点 |
| :--- | :--- | :--- |
| [L27-L50](../../../src/parsers/url-parser.js#L27-L50) | 裸 `BV` 号与裸 `av` 号识别 | 精确匹配 12 位 `BV` 号（`/^BV[0-9A-Za-z]{10}$/`）与 `av` 数字号，自动补全标准 URL 并绑定分 P 参数。 |
| [L52-L62](../../../src/parsers/url-parser.js#L52-L62) | 裸 11 位 YouTube Video ID | 匹配 `/^[0-9A-Za-z_-]{11}$/`（排除 `BV` 开头避免冲突）。 |
| [L64-L87](../../../src/parsers/url-parser.js#L64-L87) | 移动端分享文案提取与模糊标题拦截 | 若输入非纯 URL（例如 B 站 App 复制出的 `【视频标题】 https://b23.tv/xxx`），自动从中提取内嵌 URL 或 `BV` 号递归解析；若既无合法 URL 也无 `BV`/ID（即纯文字标题），立即抛出明确错误提示先搜索确定性链接。 |
| [L92-L104](../../../src/parsers/url-parser.js#L92-L104) | `b23.tv` 短链还原 | 使用 `redirect: 'manual'` 发起单次请求读取 `Location` 响应头，还原出包含原分 P 参数 `?p=N` 的真实长链接后再递归归一化。 |
| [L106-L144](../../../src/parsers/url-parser.js#L106-L144) | Bilibili 标准域名清洗 | 剥离 `?spm_id_from`、`vd_source` 等追踪参数，提取 `?p=N`（若调用工具时显式传了 `explicitPart`，优先级高于 URL 中的 `p`），并记录 `partExplicit` 供多 P 视频提示使用。 |
| [L146-L181](../../../src/parsers/url-parser.js#L146-L181) | YouTube 多形态链接支持 | 完整覆盖 `youtube.com/watch?v=`、`youtu.be/<id>`、`/shorts/<id>`、`/live/<id>`、`/embed/<id>` 及 `youtube-nocookie.com`。 |
