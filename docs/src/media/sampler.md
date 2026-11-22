# `src/media/sampler.js` 代码导读与注释

- **对应源码**：[sampler.js](../../../src/media/sampler.js#L1-L186)
- **所属层级**：媒体处理层（多信号抽帧时间轴规划器）

## 1. 模块职责
纯函数式算法模块（零 I/O 副作用），负责在 Tier 2 中将**画面场景切换信号、字幕语义锚点与最大静默保底间隔**融合为最优抽帧时间序列，并在 Tier 3 中生成固定高频采样序列。

## 2. 核心算法拆解

| 行号范围 | 函数名 | 算法细节与 Code Review 关注点 |
| :--- | :--- | :--- |
| [L3-L7](../../../src/media/sampler.js#L3-L7) | `PRIORITY` 权重表 | 定义信号优先级：`scene (3) > subtitle (2) > fallback (1)`。 |
| [L17-L158](../../../src/media/sampler.js#L17-L158) | `buildHybridSamplePlan` | **四步融合防抖算法**：<br>1. **自适应最小间距（[L29-L32](../../../src/media/sampler.js#L29-L32)）**：结合 `maxFrames`（默认 180 帧 = 20 张拼图）动态计算 `effectiveMinInterval`，防止 1 小时超长视频无上限膨胀。<br>2. **候选信号收集（[L36-L69](../../../src/media/sampler.js#L36-L69)）**：<br>   - 首帧锚点 + 视觉突变点 `rawTs + 0.1s`（微延 `0.1s` 避开转场叠化残影）；<br>   - 字幕锚点 `min(seg.start + 0.4s, 句中点)`（确保翻页或弹窗已稳定浮现）。<br>3. **带优先级的防抖去重（[L75-L96](../../../src/media/sampler.js#L75-L96)）**：当两个候选点间距 `< effectiveMinInterval`（默认 `1.0s`）时，若后一个点是更高优先级的 `scene`（例如刚开口说话 `0.4s` 后才真正切出新 PPT），**用 `scene` 点替换掉前一个 `subtitle` 点**，避免截到翻页前的旧画面！<br>4. **静默大空隙均匀插值保底（[L99-L137](../../../src/media/sampler.js#L99-L137)）**：扫描所有相邻采样点间距，凡超过 `maxIntervalSec`（默认 `8.0s`）的空白段（如无字幕纯演示段）自动等分插入 `fallback` 采样点。 |
| [L163-L186](../../../src/media/sampler.js#L163-L186) | `buildIntervalSamplePlan` | Tier 3 等间隔采样规划：同时输出原视频全局时间戳 `timestampSec`（用于打印顶栏水印，与全片字幕严格对齐）和切片内相对偏移 `localSec`（用于流式切片文件的本地寻址）。 |
