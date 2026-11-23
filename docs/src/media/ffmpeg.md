# `src/media/ffmpeg.js` 代码导读与注释

- **对应源码**：[ffmpeg.js](../../src/media/ffmpeg.js#L1-L187)
- **所属层级**：媒体处理层（视频流探测、内存灰度探针流与高清 Lanczos 抽帧）

## 1. 模块职责
封装底层 `ffprobe` 与 `ffmpeg` 调用：通过零磁盘 I/O 的内存灰度裸流（`rawvideo`）高速驱动两道栅栏状态扫描，并仅对最终入选的时间戳并发截取 `640×360` Lanczos 高清彩色帧。

## 2. 核心函数详解

| 行号范围 | 函数名 | 关键实现与 Code Review 关注点 |
| :--- | :--- | :--- |
| [L11-L36](../../src/media/ffmpeg.js#L11-L36) | `probeVideo(videoPath)` | 读取首条视频轨的真实像素宽高、编码格式与容器总时长。 |
| [L45-L170](../../src/media/ffmpeg.js#L45-L170) | `scanSinglePassVideoStream` & `encodeRgbCandidateToJpeg` | **单进程多线程一步式流管线**：仅启动 **1 个** `ffmpeg -threads 0` 进程按 `2.5 fps` 输出 `640×360` RGB24 裸流至内存管道；利用预计算对角双采样偏移表在 `0.04ms/帧` 内生成 `160×90` 抗锯齿灰度图喂给两道栅栏，且**仅对栅栏放行的候选帧**调用 `sharp` 编码为 `~35KB` 内存 JPEG Buffer，彻底省去 180 次 `ffmpeg -ss` 子进程创建与临时帧磁盘读写。 |
| [L176-L321](../../src/media/ffmpeg.js#L176-L321) | `scanGrayscaleProbeStream` & `extractLanczosFrames` | 保留的兜底抽帧与纯灰度扫描辅助函数。 |
