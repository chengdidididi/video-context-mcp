# `src/media/grid-composer.js` 代码导读与注释

- **对应源码**：[grid-composer.js](../../../src/media/grid-composer.js#L1-L167)
- **所属层级**：媒体处理层（零遮挡顶栏 SVG 渲染与 `3×3` 网格拼图合成）
- **下游依赖**：`sharp`、[config.js](../../../src/config.js)、[time.js](../../../src/utils/time.js)

## 1. 模块职责
不依赖宿主系统 FFmpeg 是否编译了 `libfreetype/drawtext`，直接通过高性能图像处理库 `sharp`（底层 `libvips` + 内置 SVG 光栅化）为每一帧顶部外扩 `24px` 纯黑信息栏、烙印 `#帧号 | 时间戳`，并将每 9 帧拼合为一张 `1924 × 1156` 的 `3×3` 网格图，同时同步产出二维时间矩阵 `matrix_sec`。

## 2. 核心函数与几何计算详解

| 行号范围 | 函数名 | 关键实现与 Code Review 关注点 |
| :--- | :--- | :--- |
| [L11-L24](../../../src/media/grid-composer.js#L11-L24) | `createHeaderBarSvg(label, width, height)` | 生成 `640 × 24` 纯黑背景 SVG，底部带 `1px` `#262626` 细微分割线，左侧使用高对比度纯白粗体等宽字体渲染 `#001 | 00:12.5`，并对 `& < >` 做 XML 转义防护。 |
| [L30-L167](../../../src/media/grid-composer.js#L30-L167) | `composeGrids` | 1. **零遮挡几何布局（[L48-L52](../../../src/media/grid-composer.js#L48-L52)）**：单格总高 `totalCellHeight = 360 + 24 = 384px`；顶栏贴在 `(left, top)`，原视频画面完整贴在 `(left, top + 24)`，原图 `640×360` 零像素损失。<br>2. **网格间距与尾页留黑（[L71-L91](../../../src/media/grid-composer.js#L71-L91)）**：底板画布设为 `#1f1f1f`（自然露出 `2px` 格间分隔线），整图分辨率 `1924 × 1156`；末尾不足 9 帧的空槽位填充 `#000000` 纯黑块，对应 `matrix_sec[r][c]` 记为 `null`。<br>3. **矩阵与扁平双索引输出（[L112-L161](../../../src/media/grid-composer.js#L112-L161)）**：既提供从上到下、从左到右的 `3×3` 二维秒数数组 `matrix_sec`，也提供带 `row`、`col`、`label`、`trigger` 的详情数组，使用 `mozjpeg: true`（质量 `85`）兼顾文字边缘锐度与小体积。 |
