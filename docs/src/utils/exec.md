# `src/utils/exec.js` 代码导读与注释

- **对应源码**：[exec.js](../../../src/utils/exec.js#L1-L82)
- **所属层级**：底层工具层（安全子进程与并发池控制）

## 1. 模块职责
为全项目调用外部二进制命令（`yt-dlp`、`ffmpeg`、`ffprobe`）提供**防命令注入的安全执行封装**，并提供轻量级的有界并发控制器。

## 2. 核心函数说明

| 行号范围 | 函数名 | 关键实现与安全关注点 |
| :--- | :--- | :--- |
| [L7-L62](../../../src/utils/exec.js#L7-L62) | `runCommand(binary, args, options)` | 1. **安全防注入**：严格使用 `child_process.spawn(binary, args)` 参数数组传参，不开启 `shell: true`，彻底杜绝恶意 URL 参数引发的 Shell 命令注入。<br>2. **静默 stdin**：显式设置 `stdio: ['ignore', 'pipe', 'pipe']`，防止 `ffmpeg` 在后台等待键盘交互导致进程挂起。<br>3. **超时强杀**：支持 `timeoutMs`，超时直接发送 `SIGKILL` 并拒绝 Promise。<br>4. **错误诊断截断**：非零退出且未设 `allowNonZero` 时，截取末尾 1200 字符的 `stderr/stdout` 附在 Error 中，避免海量 FFmpeg 日志淹没调用栈。 |
| [L67-L82](../../../src/utils/exec.js#L67-L82) | `mapWithConcurrency(items, concurrency, mapper)` | 共享游标 `nextIndex` 的固定数量 Worker 协程池，既用于 FFmpeg 4 路并发抽帧，也用于 B 站 `4MB` HTTP Range 4 路并发分片拉流，保证结果数组严格按原输入下标对齐。 |
