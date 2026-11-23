# `src/mcp-server.js` 代码导读与注释

- **对应源码**：[mcp-server.js](../../src/mcp-server.js#L1-L251)
- **所属层级**：MCP 协议适配与 Schema 校验层

## 1. 模块职责
暴露精简聚焦的 **4 个 MCP 工具**，消除多层工具选择导致的额外推理轮次损耗。

## 2. 工具注册清单

| 行号范围 | 工具名 | 功能说明 |
| :--- | :--- | :--- |
| [L71-L120](../../src/mcp-server.js#L71-L120) | `video_extract` | **唯一核心提取工具**：一步产出元数据、去重字幕、官方进度条雪碧图、两道栅栏+上限精选的 `3×3` 零遮挡时间戳拼图与二维矩阵索引，仅回传本地文件路径。 |
| [L122-L134](../../src/mcp-server.js#L122-L134) | `video_auth_status` | 检查二进制依赖、当前生效配置与 B 站实时登录状态。 |
| [L136-L197](../../src/mcp-server.js#L136-L197) | `video_config` | 读取当前脱敏配置与环境变量映射，或将修改无损持久化写回 `config.yaml`。 |
| [L199-L239](../../src/mcp-server.js#L199-L239) | `video_read_image` | 单张图片 Base64 读取辅助工具（兼容无本地读图能力的客户端）。 |
