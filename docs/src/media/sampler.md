# `src/media/sampler.js` 代码导读与注释

- **对应源码**：[sampler.js](../../src/media/sampler.js#L1-L255)
- **所属层级**：媒体处理层（「两道栅栏 + 一个上限」视觉状态采样引擎）

## 1. 模块职责
纯函数与无磁盘状态机模块，负责在 `160×90` 灰度探针流上执行**局部网格累积变化检测（第一道栅栏）+ 动后取静落点检测（第二道栅栏）+ 变化强度×时间间距预算优选裁剪（一个上限）**。

## 2. 核心函数拆解

| 行号范围 | 函数名 | 算法细节与 Code Review 关注点 |
| :--- | :--- | :--- |
| [L7-L45](../../src/media/sampler.js#L7-L45) | `computePatchVisualDiff` | 将 `160×90` 灰度帧划分为 `8×6 = 48` 个局部小块（每块 `20×15`），单趟统计每块的归一化 L1 像素差，同时提取前 2 大变化块均值 `top2Avg`（捕捉角落弹窗、代码增改、Tooltip 等局部小变化）与全图均值 `meanDiff`（捕捉滚屏与切镜），合成综合新颖度 `novelty = max(meanDiff * 1.8, top2Avg)`。 |
| [L56-L150](../../src/media/sampler.js#L56-L150) | `createTwoGateTracker` | **两道栅栏流式状态机（常驻内存 `< 100KB`）**：<br>- **第一道栅栏（累积局部差）**：将当前帧与上一张已入选基准帧 `refBuf` 比对，一旦 `vsRef.novelty >= diffThreshold`（默认 `0.15`），说明画面相比上次截图已发生实质变化。<br>- **第二道栅栏（动后取静 Settle）**：触发后不急于在滚动或淡入动画半途落刀，而是观察相邻步瞬时运动 `vsPrev.novelty`；若画面回退到原状（`< 0.65 * diffThreshold`）则判定为瞬时闪烁误报自动取消；等 `vsPrev.novelty <= settleThreshold`（默认 `0.045`）停稳瞬间精准抓拍；若连续运动超过 `maxPendingWaitSec`（`2.4s`，如实拍运镜），则选窗口内运动模糊最小的一帧兜底输出。 |
| [L159-L255](../../src/media/sampler.js#L159-L255) | `finalizeSamplePlan` | **字幕协同与「一个上限」优选裁剪**：<br>1. 若视觉落点与字幕句首对齐（`±1.0s`），赋予 `+0.15` 重要性加权；<br>2. 对超过 `maxIntervalSec`（默认 `15s`）的纯静止长段落做稀疏保底补点；<br>3. 当候选帧超过 `maxFrames`（默认 `180`）时，迭代剔除 `importance * min(左邻间距, 右邻间距)` 最小的点——既优先淘汰密集微动帧，又保证全片大切换与稀疏段落不被饿死。 |
