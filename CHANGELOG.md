# Changelog

本文件记录 pi-provider-claude-code-hub 的每个版本变更。

## [0.1.4] - 2026-08-14

### 修复

- 保存或清除模型覆盖后立即触发模型刷新，无需重启 pi agent。此前 `persistOverride` 只写配置文件，变更要到下次重启或 `/model` 刷新才生效。
  - pi-ai 0.84+：通过 `modelRegistry.refresh({ providers, allowNetwork })` 精准刷新单个 provider（以 `getRegisteredNativeProvider` 存在性做运行时特征检测）。
  - pi-ai 0.83：调用无参的 `modelRegistry.refresh()` 全量重载（pi 会以正确的 store context 重跑各 provider 的 `refreshModels`）。
  - 网关不可达或未登录时安全降级：回落到重新绑定过新覆盖的缓存模型。

## [0.1.3] - 2026-08-14

### 新增

- **规则式模型覆盖（Layer B）**：`modelOverrides` 键支持 glob 规则（`*`、`?`），一条规则覆盖整类模型（如 `claude-*`、`*` 兜底）。
  - 优先级：精确 ID > 通配符更少 > 字面前缀更长 > `*` 兜底；仅最具体的单条规则生效，规则不叠加。
  - `buildCCHModels` 与 `rebindCachedModels` 均通过统一的 `resolveModelOverride` 解析。
- **交互式命令（Layer C）**：
  - `/cch-provider-models [provider]`：只读模型总览表——有效参数、生效规则与来源标注，支持关键字过滤与滚动，Enter 直接进入编辑。
  - `/cch-model-override [provider] [model|pattern]`：交互式表单编辑覆盖（常用字段 + 折叠的高级字段：cost、thinkingLevelMap、compat 以校验 JSON 编辑），支持 Save / Clear / Cancel；非 TUI 模式降级为顺序输入对话框。
- 开发依赖 `@earendil-works/pi-tui`（仅类型解析用；运行时由 pi 环境提供）。

### 文档

- README（中/英）：命令表新增两个命令；新增"规则匹配"与"交互式编辑"章节。

## [0.1.2] - 2026-08-14

### 文档

- README（中/英）：新增 npm 安装方式（推荐）与"更新"章节，说明钉住版本（`npm:pi-provider-claude-code-hub@<版本>`）会被 `pi update --extensions` 跳过、需显式 `pi install` 升级；要求部分补充 0.83/0.84 双协议兼容说明。

## [0.1.1] - 2026-08-13

### 修复

- **兼容 pi-ai 0.84+**：0.84 移除了 `RefreshModelsContext.store`（异步 `read()`/`write()`），改为同步 `stored` 快照 + `publish({ persist })`。旧版插件在 0.84 上 `refreshModels` 直接抛 `TypeError`，模型列表无法加载。现在运行时检测两种 context 形状：
  - 0.83：走 `store.read()` / `store.write()`。
  - 0.84+：走 `stored` 快照 / `publish({ persist })`。
- 新增两个回归测试覆盖两种缓存协议的持久化路径。

## [0.1.0] - 2026-08-10

### 新增

- 首个版本：为自托管 Claude Code Hub 网关提供动态 pi Provider 扩展。
- 一个命名 Provider 同时承载 Anthropic Messages、OpenAI Responses 和 OpenAI Chat Completions 模型。
- 使用 pi 标准 `/login` 与 CredentialStore 管理 API Key；登录后及打开 `/model` 时刷新实时目录。
- Provider-scoped 离线模型缓存；单协议失败隔离（仅保留该协议缓存）；成功空目录清除旧模型。
- 使用 pi 内置模型目录补全 reasoning、上下文窗口、图像、thinking、兼容参数与价格；同模型多协议时优先原生 Provider/API 元数据。
- 命令：`/cch-provider-add`、`/cch-provider-remove`、`/cch-provider-list`。
- 不读取或修改 `auth.json`，不把 API Key 写入扩展配置。
