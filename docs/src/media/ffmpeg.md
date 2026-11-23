# `src/media/ffmpeg.js` 代码导读与注释

- **对应源码**：[ffmpeg.js](../../src/media/ffmpeg.js#L1-L187)
- **所属层级**：媒体处理层（视频流探测、内存灰度探针流与高清 Lanczos 抽帧）

## 1. 模块职责
封装底层 `ffprobe` 与 `ffmpeg` 调用：通过零磁盘 I/O 的内存灰度裸流（`rawvideo`）高速驱动两道栅栏状态扫描，并仅对最终入选的时间戳并发截取 `640×360` Lanczos 高清彩色帧。

## 2. 核心函数详解

| 行号范围 | 函数名 | 关键实现与 Code Review 关注点 |
| :--- | :--- | :--- |
| [L10-L35](../../src/media/ffmpeg.js#L10-L35) | `probeVideo(videoPath)` | 读取首条视频轨的真实像素宽高、编码格式与容器总时长。 |
| [L41-L119](../../src/media/ffmpeg.js#L41-L119) | `scanGrayscaleProbeStream` | 启动 `ffmpeg -vf "fps=2.5,scale=160:90:flags=area" -pix_fmt gray -f rawvideo pipe:1`，每 `14,400` 字节切出一帧回调 `onFrame`，不写任何临时文件、不做图片编解码，内存占用恒定为 `O(1)`。 |
| [L125-L187](../../src/media/ffmpeg.js#L125-L187) | `extractLanczosFrames` | 对精选出的时间戳并发执行 `-ss` 快速寻址 + `scale=640:360:flags=lanczos` 等比居中补黑边抽帧，并保留片尾 EOF `-0.3s` 自动回退重试保护。 |
