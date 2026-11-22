# `bin/video-context-mcp.js` 代码导读与注释

- **对应源码**：[video-context-mcp.js](../../bin/video-context-mcp.js#L1-L20)
- **所属层级**：入口层（MCP Stdio Server 启动入口）
- **上游调用方**：MCP 宿主客户端（如 Antigravity、Claude Desktop、Cursor 等通过 `mcp_config.json` 拉起进程）
- **下游依赖**：[config.js](../../src/config.js)、[mcp-server.js](../../src/mcp-server.js)

## 1. 模块职责
作为 MCP 标准输入输出（Stdio）协议服务的唯一可执行入口，负责在服务启动阶段解析可选的命令行启动参数 `--output-dir`（或 `-o`），将用户指定的全局 `output` 根目录注入配置模块，然后启动 MCP Server 监听 `stdin/stdout`。

## 2. 逐段逻辑说明

| 行号范围 | 关键逻辑 | 设计细节与 Code Review 关注点 |
| :--- | :--- | :--- |
| [L1-L4](../../bin/video-context-mcp.js#L1-L4) | Shebang 与模块导入 | 使用 Node.js 原生 `node:util` 的 `parseArgs`，零额外 CLI 解析库依赖。 |
| [L6-L15](../../bin/video-context-mcp.js#L6-L15) | 解析 `--output-dir` / `-o` | 开启 `strict: false`，即使宿主客户端附带其他未知启动参数也不会导致进程崩溃；若传入了 `--output-dir`，调用 `setRuntimeOutputDir` 设置全局会话级输出目录。 |
| [L17-L20](../../bin/video-context-mcp.js#L17-L20) | 启动 Stdio 服务与异常兜底 | 启动失败时**仅向 `console.error`（即 `stderr`）输出错误**并以非零码退出，严格保证 `stdout` 不被非 JSON-RPC 文本污染。 |
