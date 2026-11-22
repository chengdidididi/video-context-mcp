# `src/media/ffmpeg.js` 代码导读与注释

- **对应源码**：[ffmpeg.js](../../../src/media/ffmpeg.js#L1-L199)
- **所属层级**：媒体处理层（FFmpeg 探测、场景检测与高精度抽帧）
- **下游依赖**：[config.js](../../../src/config.js)、[exec.js](../../../src/utils/exec.js)

## 1. 模块职责
封装所有底层 `ffprobe` 与 `ffmpeg` 视频解码操作，包括视频流几何属性探测、全片高速视觉突变扫描、Lanczos 超采样等比缩放抽帧，以及原画质无损单帧提取。

## 2. 核心函数与边界防护详解

| 行号范围 | 函数名 | 关键参数与 Code Review 关注点 |
| :--- | :--- | :--- |
| [L10-L35](../../../src/media/ffmpeg.js#L10-L35) | `probeVideo(videoPath)` | 调用 `ffprobe -select_streams v:0 -of json` 读取首条视频轨的真实像素宽高 `width/height`、编码器 `codec_name` 与容器总时长 `durationSec`。 |
| [L40-L75](../../../src/media/ffmpeg.js#L40-L75) | `detectSceneChanges(videoPath, threshold)` | 使用 `-vf "select='gt(scene,threshold)',showinfo" -fps_mode vfr -an -f null -` 空输出高速扫描全片（注意使用新版 FFmpeg 7/8/9 标准的 `-fps_mode vfr` 替代已废弃的 `-vsync vfr`），从 `stderr` 正则提取所有 `pts_time` 突变秒数。 |
| [L81-L141](../../../src/media/ffmpeg.js#L81-L141) | `extractLanczosFrames` | 1. **快寻址 + 超采样防变形滤镜**：将 `-ss <seekSec>` 置于 `-i` 之前利用关键帧索引极速跳转，配合 `scale=640:360:flags=lanczos:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2:black`——横屏 16:9 满铺超采样抗锯齿，竖屏 9:16 或 4:3 自动等比居中补黑边，绝不拉伸变形。<br>2. **片尾 EOF 越界回退重试（[L121-L130](../../../src/media/ffmpeg.js#L121-L130)）**：部分 VFR 视频容器标注时长略大于最后一帧 PTS，导致片尾 `-ss` 截出空文件；此处检测文件大小，若未生成则自动回退 `0.3s` 重试，杜绝片尾崩溃。 |
| [L147-L199](../../../src/media/ffmpeg.js#L147-L199) | `extractRawCleanFrames` | 供 Tier 3 `output_mode="raw_frames"` 使用：不加任何缩放与黑边，按原视频分辨率直出 `-q:v 2` 高质量纯净单帧，便于直接嵌入笔记或文档。 |
