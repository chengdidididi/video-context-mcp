# `src/config.js` 代码导读与注释

- **对应源码**：[config.js](../../src/config.js#L1-L297)
- **配置文件模板**：[config.example.yaml](../../config.example.yaml)
- **所属层级**：统一配置与环境变量映射层

## 1. 模块职责
将全项目所有可调控、可持久化的参数（`output` 路径、B 站 Cookie、抽帧阈值/帧数上限、网格几何规格、二进制路径）**100% 收口至单一 `config.yaml` 文件**，并建立与**外部环境变量（`ENV_VAR_MAP`）的一一双向对接机制**，同时支持保留原 YAML 注释的无损写回。

## 2. 配置优先级与核心结构

全局遵循四级覆盖链：**单次工具入参 > 启动参数 (`--output-dir`) > 外部环境变量 (`process.env`) > `config.yaml` > `DEFAULT_CONFIG`**。

| 行号范围 | 导出项 | 关键实现与 Code Review 关注点 |
| :--- | :--- | :--- |
| [L23-L57](../../src/config.js#L23-L57) | `DEFAULT_CONFIG` | 定义 `output`（默认 `keep_video_cache: false` 临时视频流用完即焚）、`runtime`（默认 `timeout_sec: 300` 统一 5 分钟超时）、`auth`、`sampling`、`grid`、`binaries` 六大配置分组默认值。 |
| [L62-L84](../../src/config.js#L62-L84) | `ENV_VAR_MAP` | **环境变量对接总表**：将全部 21 个点路径（含 `VIDEO_CONTEXT_TIMEOUT_SEC`、`VIDEO_CONTEXT_KEEP_VIDEO_CACHE`、`VIDEO_CONTEXT_OUTPUT_DIR`、`BILIBILI_COOKIE` 等）一一映射到外部环境变量并声明强类型。 |
| [L100-L136](../../src/config.js#L100-L136) | `loadEffectiveConfig()` | 按 `DEFAULT_CONFIG` → `config.yaml` → `process.env`（通过 `coerceValue` 自动完成字符串向布尔/数值转型）→ `runtimeOutputDir` 顺序合并，并记录当前生效的环境变量覆盖项 `activeEnvOverrides` 供状态诊断。 |
| [L141-L169](../../src/config.js#L141-L169) | `saveConfigUpdates(updates)` | 使用 `YAML.parseDocument` AST 级修改节点（`doc.setIn`），在持久化更新 `config.yaml` 时**完整保留文件中的中文注释与排版**；若 `config.yaml` 尚未创建，自动基于 `config.example.yaml` 初始化。 |
| [L182-L212](../../src/config.js#L182-L212) | `resolveOutputDir` / `getBilibiliCookieConfig` / `getGridSpec` | 封装具体领域的配置读取器，相对路径统一基于 `PROJECT_ROOT` 归一化，且明确标注 Cookie 来源（`env:BILIBILI_COOKIE` 或 `yaml:...`）。 |
| [L226-L257](../../src/config.js#L226-L257) | `resolveBinary` & `getEnhancedEnv` | 优先使用 `binaries.*`（或 `YTDLP_PATH` / `FFMPEG_PATH` 环境变量），未指定时自动扫描 `PATH` 与 `/opt/homebrew/bin` 等目录。 |
