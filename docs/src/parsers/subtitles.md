# `src/parsers/subtitles.js` 代码导读与注释

- **对应源码**：[subtitles.js](../../../src/parsers/subtitles.js#L1-L277)
- **所属层级**：解析层（多格式字幕解析、滚动去重与语义合并）

## 1. 模块职责
兼容 B 站 BCC JSON、YouTube `json3` 以及通用 `WebVTT / SRT` 三种字幕源码格式，消除自动生成字幕特有的**逐词标签、滚动多行重复与刷屏占位符**，输出毫秒级 `subtitles.json`（供抽帧联动）和省 Token 的 `transcript.md`（供 AI 直接阅读）。

## 2. 核心管线与算法拆解

| 行号范围 | 函数名 | 算法细节与 Code Review 关注点 |
| :--- | :--- | :--- |
| [L6-L20](../../../src/parsers/subtitles.js#L6-L20) | `parseBilibiliBccJson` | 解析 B 站原生 `{ body: [{ from, to, content }] }` 结构并交由统一清洗管线处理。 |
| [L25-L45](../../../src/parsers/subtitles.js#L25-L45) | `parseYoutubeJson3` | 解析 YouTube `timedtext?fmt=json3` 的 `events` 数组（`tStartMs` + `dDurationMs` + `segs[].utf8`），天然规避 VTT 样式污染。 |
| [L50-L103](../../../src/parsers/subtitles.js#L50-L103) | `parseVttOrSrt` & `cleanInlineText` | 状态机式扫描 `-->` 时间轴行，自动剔除 `<00:00:01.500>` 逐词时间戳、`<c>` / HTML 标签、ASS `{\an8}` 位置标签及 HTML 实体转义，并对单条 Cue 内部重复行先做一次折叠。 |
| [L129-L233](../../../src/parsers/subtitles.js#L129-L233) | `cleanAndMergeSegments` | **核心两趟清洗管线**：<br>- **Pass 1（滚动重叠去重，[L135-L185](../../../src/parsers/subtitles.js#L135-L185)）**：处理 YouTube 自动字幕“上一条为 `A B`，下一条滚出 `A B C` 或 `B C D`”的重叠现象——通过前缀包含检测与 `findSuffixPrefixOverlap`（最长后缀-前缀子串匹配，`>=4` 字符）仅保留新增增量文本，彻底消除重复文字。<br>- **Pass 2（短碎句合并与噪音折叠，[L188-L225](../../../src/parsers/subtitles.js#L188-L225)）**：折叠连续重复的 `[Music]` / `[音乐]` 标记；当相邻短句未以句末标点结尾、停顿间隙 `<= 0.6s` 且合并后长度 `<= 72` 字符时自动拼成完整语义句（中英文拼接自动判断空格）。 |
| [L251-L277](../../../src/parsers/subtitles.js#L251-L277) | `formatTranscriptMarkdown` | 生成带标题元信息头与 `[MM:SS] 文本` 格式的紧凑 Markdown，较原始字幕节省约 50% 上下文开销。 |
