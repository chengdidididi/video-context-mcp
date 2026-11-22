# `src/platforms/auth.js` 代码导读与注释

- **对应源码**：[auth.js](../../../src/platforms/auth.js#L1-L149)
- **所属层级**：平台适配层（B 站登录态校验与依赖环境检测）

## 1. 模块职责
已移除常规公开视频工作流无需用到的 YouTube Cookie 检查冗余逻辑，专注于：
1. 读取 `config.yaml`（`auth.bilibili_cookie`）或 `BILIBILI_COOKIE` 环境变量并通过 B 站 `/x/web-interface/nav` 在线校验真实登录态（防静默降级为 360p 无 AI 字幕），同时顺带提取当日 WBI 密钥；
2. 检测 `yt-dlp`、`ffmpeg`、`ffprobe` 可用性与版本。

## 2. 核心类与函数拆解

| 行号范围 | 类 / 函数名 | 关键逻辑与 Code Review 关注点 |
| :--- | :--- | :--- |
| [L9-L16](../../../src/platforms/auth.js#L9-L16) | `AuthRequiredError` | 结构化鉴权异常，区分 `'AUTH_REQUIRED'`（未配置）与 `'COOKIE_EXPIRED'`（已配置但 `isLogin === false`）。 |
| [L18-L28](../../../src/platforms/auth.js#L18-L28) | `buildBilibiliCookieGuide` | 提示用户通过环境变量 `BILIBILI_COOKIE` 或 `config.yaml`（及 `video_config` 工具）填入浏览器复制的 Cookie 字符串。 |
| [L33-L77](../../../src/platforms/auth.js#L33-L77) | `checkBilibiliAuth` | 请求 `/x/web-interface/nav` 校验 `isLogin`、标注凭证来源 `cookie_source`（`env:BILIBILI_COOKIE` 或 `yaml:...`），并提取 32 位 `imgKey` 与 `subKey`。 |
| [L82-L99](../../../src/platforms/auth.js#L82-L99) | `ensureBilibiliAuth` | 结合单次调用覆盖值与 `config.yaml` 的 `auth.allow_guest_degraded` 拦截未登录请求，且在对外抛出的异常详情中自动剔除敏感明文 `cookie_header`。 |
| [L101-L143](../../../src/platforms/auth.js#L101-L143) | `checkSystemBinaries` | 探测三大外部工具路径与版本号。 |
