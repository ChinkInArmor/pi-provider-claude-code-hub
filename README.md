# pi-provider-claude-code-hub

用于自托管 [Claude Code Hub](https://github.com/ding113/claude-code-hub) 网关的 [pi](https://github.com/earendil-works/pi) Provider 扩展。

扩展直接读取 CCH 当前用户 API Key 的实时模型目录，并根据模型所在端点自动选择 pi API。关闭、启用或调整 CCH 上游后，不需要再手工修改 `~/.pi/agent/models.json`。

## 功能

- 一个命名 Provider 同时承载 Anthropic Messages、OpenAI Responses 和 OpenAI Chat Completions 模型。
- 使用 pi 标准 `/login` 和 CredentialStore 管理 API Key。
- 登录后以及打开 `/model` 时刷新实时目录。
- 使用 pi provider model store 缓存最近一次成功结果。
- 某个模型端点失败时只保留该协议的旧缓存，其他协议继续刷新。
- 端点成功返回空目录时立即移除该协议的旧模型，准确反映已关闭上游。
- 使用 pi 内置模型目录补全 reasoning、上下文窗口、图像、thinking、兼容参数和价格。
- 同一模型出现在多个协议时，优先使用其原生 Provider/API 元数据。
- 支持无法识别的自定义模型别名及可选元数据覆盖。
- 模型覆盖支持 glob 规则（`claude-*`、`*` 兜底、`?`），一条规则覆盖整类模型。
- 交互式命令 `/cch-provider-models` 与 `/cch-model-override`，无需手改 JSON。
- 不读取或修改 `auth.json`，不把 API Key 写入扩展配置。

## 要求

- pi Coding Agent `0.83.0` 或更高版本（同时兼容 0.83 的 provider store 缓存协议，以及 0.84 起引入的 `stored`/`publish` 模型仓库协议）。
- Claude Code Hub 提供用户 API Key 可访问的模型与推理端点。

## 安装

从 npm 安装：

```bash
pi install npm:pi-provider-claude-code-hub
```

推荐钉住具体版本（生产环境更可控）：

```bash
pi install npm:pi-provider-claude-code-hub@0.1.1
```

从 GitHub 安装：

```bash
pi install git:github.com/ChinkInArmor/pi-provider-claude-code-hub
```

临时试用，不写入 pi 的包配置：

```bash
pi -e git:github.com/ChinkInArmor/pi-provider-claude-code-hub
```

本地开发安装：

```bash
git clone https://github.com/ChinkInArmor/pi-provider-claude-code-hub.git
cd pi-provider-claude-code-hub
npm install
pi install .
```

## 更新

不带版本号的 npm 安装会跟随 `pi update --extensions` 自动更新：

```bash
pi update --extensions
```

钉住版本号的安装（`npm:pi-provider-claude-code-hub@0.1.1`）会被包更新跳过，需要显式安装新版本：

```bash
pi install npm:pi-provider-claude-code-hub@<新版本>
```

git 安装的更新：

```bash
pi update --extension git:github.com/ChinkInArmor/pi-provider-claude-code-hub
```

卸载：

```bash
pi remove npm:pi-provider-claude-code-hub
pi remove git:github.com/ChinkInArmor/pi-provider-claude-code-hub
```

## 使用

添加 CCH 实例：

```text
/cch-provider-add cch
```

输入 CCH 根地址，例如：

```text
https://hub.example.com
```

扩展也接受以 `/v1`、`/v1/models`、`/v1/messages`、`/v1/responses` 或 `/v1/chat/completions` 结尾的地址，并自动归一化。远程地址必须使用 HTTPS；HTTP 仅允许 localhost、`127.0.0.1` 和 `::1`。

然后保存用户 API Key：

```text
/login cch
```

登录后打开模型选择器以刷新并选择模型：

```text
/model
```

模型统一显示在同一个 Provider 下，例如：

```text
cch/claude-sonnet-5
cch/gpt-5.6-sol
cch/deepseek-v4-pro
```

每个模型仍使用其正确协议和请求端点。

## 命令

| 命令 | 说明 |
|---|---|
| `/cch-provider-add [name]` | 添加并立即注册一个 CCH Provider。 |
| `/cch-provider-remove [name]` | 删除 Provider 配置；如果仍有凭据，必须先运行 `/logout`。 |
| `/cch-provider-list` | 查看地址、认证状态、覆盖数量和运行状态。 |
| `/cch-provider-models [provider]` | 查看模型表格：有效参数、生效规则与来源标注；Enter 直接进入编辑。 |
| `/cch-model-override [provider] [model|pattern]` | 交互式编辑模型覆盖（支持 glob 规则），保存后自动生效。 |

## 模型发现

扩展并行调用三个 CCH 用户级端点：

| CCH 端点 | pi API | 模型级 Base URL |
|---|---|---|
| `GET /v1/models`，带 `anthropic-version` | `anthropic-messages` | CCH 根地址 |
| `GET /v1/responses/models` | `openai-responses` | `{root}/v1` |
| `GET /v1/chat/completions/models` | `openai-completions` | `{root}/v1` |

所有请求使用同一个用户 API Key：

```http
x-api-key: <key>
```

CCH 根据当前用户、API Key 分组、启用状态和上游配置返回实际目录。管理 API `/api/v1/*`、管理员 Token 和 CCH 数据库均不参与发现。

## 缓存语义

- 请求成功：该协议目录以 CCH 最新结果为准。
- 请求成功且结果为空：清除该协议旧模型。
- 请求超时、网络错误或 5xx：仅保留该协议上次缓存。
- 三个端点全部失败：整个 Provider 使用上次缓存。
- 修改 CCH 地址后，离线缓存也会重新绑定到新地址，不会继续向旧网关请求。

## 配置

配置位于：

```text
<agentDir>/extensions/provider-claude-code-hub.json
```

默认 `<agentDir>` 为 `~/.pi/agent`，Windows 下通常是 `%USERPROFILE%\.pi\agent`。

```json
{
  "providers": {
    "cch": {
      "baseUrl": "https://hub.example.com",
      "modelOverrides": {}
    }
  },
  "settings": {}
}
```

API Key 不在此文件中，由 pi CredentialStore 管理。

## 自定义模型别名

标准模型 ID 会自动继承 pi 内置元数据。只有 CCH 返回无法识别的自定义别名时，才需要覆盖：

```json
{
  "providers": {
    "cch": {
      "baseUrl": "https://hub.example.com",
      "modelOverrides": {
        "team-coding-model": {
          "name": "Team Model",
          "reasoning": true,
          "input": ["text", "image"],
          "contextWindow": 200000,
          "maxTokens": 64000,
          "compat": {
            "forceAdaptiveThinking": true
          }
        }
      }
    }
  },
  "settings": {}
}
```

未知别名仍可使用，默认按文本输入、非 reasoning、128K 上下文、16K 最大输出和零成本注册。

### 规则匹配

`modelOverrides` 的键可以是精确模型 ID，也可以是 glob 规则：

```json
{
  "modelOverrides": {
    "claude-*": { "maxTokens": 64000, "contextWindow": 200000 },
    "claude-sonnet-*": { "reasoning": true },
    "*": { "input": ["text", "image"] }
  }
}
```

优先级：**精确 ID > 通配符更少的规则 > 字面前缀更长的规则 > `*` 兜底**。多条规则同时匹配时，只有最具体的一条生效（不会叠加）。未知模型匹配不到任何规则时使用默认值。

### 交互式编辑（推荐）

```text
/cch-provider-models cch        # 表格总览，Enter 跳到编辑
/cch-model-override cch         # 选择模型或输入 pattern
/cch-model-override cch claude-*  # 直接编辑一个规则
```

编辑界面提供常用字段（名称、上下文窗口、最大输出、reasoning、输入类型）与折叠的高级字段（cost、thinkingLevelMap、compat，以校验 JSON 编辑）。保存后写入配置并提示下次刷新生效。

## 安全说明

- 配置文件只保存 Provider 名称、网关地址和非敏感模型覆盖。
- API Key 由 pi 的 `/login`、`/logout` 和 CredentialStore 管理。
- 删除 Provider 前必须先 `/logout`，防止同名凭据意外绑定到另一个地址。
- 模型缓存不包含 API Key。
- Base URL 拒绝嵌入用户名、密码和远程明文 HTTP。

## 项目关系

这是社区维护的独立扩展，并非 Claude Code Hub 或 pi 的官方组件。

- [ding113/claude-code-hub](https://github.com/ding113/claude-code-hub)：扩展所连接的网关及 API 契约来源。
- [ttimasdf/pi-provider-newapi](https://github.com/ttimasdf/pi-provider-newapi)：动态 Provider 注册、凭据归属和模型缓存设计的参考项目。

本仓库没有 fork 或复制上述项目的 Git 历史；各项目继续遵循各自的许可证。
