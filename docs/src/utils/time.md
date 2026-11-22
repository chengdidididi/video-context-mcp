# `src/utils/time.js` 代码导读与注释

- **对应源码**：[time.js](../../../src/utils/time.js#L1-L118)
- **所属层级**：底层工具层（时间戳解析与多场景格式化）

## 1. 模块职责
统一处理用户输入、字幕文件（SRT/VTT）、拼图顶栏水印以及安全文件名之间的时间戳双向转换。

## 2. 核心函数说明

| 行号范围 | 函数名 | 输入 / 输出示例与设计细节 |
| :--- | :--- | :--- |
| [L4-L53](../../../src/utils/time.js#L4-L53) | `parseTimestampSec(input)` | 支持四种常见格式归一化为浮点秒数：<br>- 纯数字或带 `s`：`124.5` / `"124.5s"` → `124.5`<br>- 语义缩写：`"02m10s"` / `"1h02m10.5s"` → `130` / `3730.5`<br>- 冒号时间（兼容 SRT 逗号毫秒）：`"04:10"` / `"00:01:24,500"` → `250` / `84.5`<br>对负数、`NaN`、非法字符串显式抛错拦截。 |
| [L58-L75](../../../src/utils/time.js#L58-L75) | `formatFrameTimestamp(sec, forceHours)` | 用于 `3×3` 拼图顶部 `24px` 黑边水印，精确到 `0.1s`（如 `"01:24.5"`；当全片时长 `>= 1 小时` 时传入 `forceHours=true` 统一对齐为 `"00:01:24.5"`）。注意对 `Math.round(clamped * 10)` 做整数进位，避免 `59.96s` 格式化出 `:60.0` 的经典浮点进位 Bug。 |
| [L80-L94](../../../src/utils/time.js#L80-L94) | `formatTranscriptTimestamp(sec, forceHours)` | 用于 `transcript.md` 行首时间戳（向下取整到秒，如 `"01:24"`），省去冗余毫秒字符节省 LLM Token。 |
| [L99-L113](../../../src/utils/time.js#L99-L113) | `formatSlugTimestamp(sec)` | 生成跨平台文件系统安全的无冒号时间后缀（如 `"00m28s"`），用于拼图文件名 `grid_001_00m01s-00m28s.jpg` 与切片目录名（兼容 Windows/macOS 禁止或敏感的 `:` 字符）。 |
| [L115-L118](../../../src/utils/time.js#L115-L118) | `roundSec(sec, decimals)` | 控制 JSON 矩阵中的浮点数精度（默认保留 2 位小数）。 |
