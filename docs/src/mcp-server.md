# `src/mcp-server.js` 代码导读与注释

- **对应源码**：[mcp-server.js](../../src/mcp-server.js#L1-L251)
- **所属层级**：MCP 协议适配与 Schema 校验层

## 1. 模块职责
暴露精简聚焦的 **4 个 MCP 工具**，消除多层工具选择导致的额外推理轮次损耗。

## 2. 工具注册清单

| 行号范围 | 工具名 | 功能说明 |
| :--- | :--- | :--- |
| [L70-L100](../../src/mcp-server.js#L70-L100) | `video_extract` | **唯一核心提取工具（零低层阈值负担）**：仅向模型暴露 `url_or_id`、`part`、`output_dir`、`force` 4 个必要参数，所有采样阈值、选流规格与缓存清理均由服务端自动采用最优默认策略，防止模型误设参数拖慢性能。 |
| [L102-L115](../../src/mcp-server.js#L102-L115) | `video_auth_status` | 检查二进制依赖、当前生效配置与 B 站实时登录状态。 |
| [L117-L154](../../src/mcp-server.js#L117-L154) | `video_config` | 读取当前脱敏配置与环境变量映射，或将常用配置（`output_dir`、`keep_video_cache`、`bilibili_cookie`、`allow_guest_degraded`、`max_frames`）无损写回 `config.yaml`。 |
| [L156-L190](../../src/mcp-server.js#L156-L190) | `video_read_image` | 单张图片 Base64 读取辅助工具（兼容无本地读图能力的客户端）。 |
