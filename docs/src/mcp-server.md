# `src/mcp-server.js` 代码导读与注释

- **对应源码**：[mcp-server.js](../../src/mcp-server.js#L1-L346)
- **所属层级**：MCP 协议适配与 Schema 校验层

## 1. 模块职责
基于 `@modelcontextprotocol/sdk` 与 `zod` 注册 MCP Server 实例与全局渐进式 SOP 指令，暴露 6 个强类型 MCP 工具接口（其中 `video_config` 支持一键查询/修改并持久化保存全部 `config.yaml` 参数）。

## 2. 工具注册清单与行号映射

| 行号范围 | 工具名 | 功能说明与 Code Review 关注点 |
| :--- | :--- | :--- |
| [L74-L86](../../src/mcp-server.js#L74-L86) | `video_auth_status` | 检查外部依赖二进制版本、`config.yaml` 路径、当前生效的 `active_output_dir`、生效中的环境变量覆盖项以及实时 B 站登录状态。 |
| [L88-L144](../../src/mcp-server.js#L88-L144) | `video_config` | **统一配置读写工具**：无参调用时返回脱敏后的完整生效配置与环境变量映射表；传入任一参数（`output_dir`、`bilibili_cookie`、抽帧阈值、网格尺寸等）时校验并直接持久化写回 `config.yaml`。 |
| [L146-L176](../../src/mcp-server.js#L146-L176) | `video_inspect` | Tier 1 极速探针（元数据 + 清洗后时间轴字幕 + 官方进度条雪碧图）。 |
| [L178-L231](../../src/mcp-server.js#L178-L231) | `video_extract_grids` | Tier 2 全局拼图（未显式传参的阈值均自动继承 `config.yaml` / 环境变量设定）。 |
| [L233-L283](../../src/mcp-server.js#L233-L283) | `video_extract_clip` | Tier 3 局部显微镜（支持 `grid` 与 `raw_frames` 无水印高清原图模式）。 |
| [L285-L325](../../src/mcp-server.js#L285-L325) | `video_read_image` | 按需单张返回 MCP `ImageContent`，兼容无本地读图能力的纯聊天宿主客户端。 |
