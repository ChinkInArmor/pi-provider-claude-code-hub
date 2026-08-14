# pi-provider-claude-code-hub

A dynamic [pi](https://github.com/earendil-works/pi) provider extension for self-hosted [Claude Code Hub](https://github.com/ding113/claude-code-hub) gateways.

It discovers the models currently available to a CCH user API key and assigns each model to its actual pi protocol. Enabling or disabling CCH upstreams no longer requires editing `~/.pi/agent/models.json`.

## Features

- One named provider for Anthropic Messages, OpenAI Responses, and OpenAI Chat Completions models.
- Standard pi `/login` credential management.
- Dynamic refresh after login and when opening `/model`.
- Provider-scoped offline model cache.
- Per-protocol failure isolation: a failed endpoint retains only its cached subset.
- A successful empty catalog removes stale models for that protocol.
- Metadata enrichment from pi's built-in model catalogs.
- Optional metadata overrides for private model aliases.
- Glob-rule overrides (`claude-*`, `*` fallback, `?`) — one rule covers a whole model class.
- Interactive `/cch-provider-models` and `/cch-model-override` commands.

pi Coding Agent 0.83.0 or newer is required (compatible with both the 0.83 provider store cache protocol and the `stored`/`publish` model repository protocol introduced in 0.84).

## Install

From npm:

```bash
pi install npm:pi-provider-claude-code-hub
```

Pin a specific version for production installs:

```bash
pi install npm:pi-provider-claude-code-hub@0.1.1
```

Install from GitHub:

```bash
pi install git:github.com/ChinkInArmor/pi-provider-claude-code-hub
```

Try it without adding it to pi's package configuration:

```bash
pi -e git:github.com/ChinkInArmor/pi-provider-claude-code-hub
```

For local development:

```bash
git clone https://github.com/ChinkInArmor/pi-provider-claude-code-hub.git
cd pi-provider-claude-code-hub
npm install
pi install .
```

## Updating

Unpinned npm installs are updated automatically:

```bash
pi update --extensions
```

Pinned installs (`npm:pi-provider-claude-code-hub@0.1.1`) are skipped by package updates; install the new version explicitly:

```bash
pi install npm:pi-provider-claude-code-hub@<new-version>
```

Git installs:

```bash
pi update --extension git:github.com/ChinkInArmor/pi-provider-claude-code-hub
```

Remove:

```bash
pi remove npm:pi-provider-claude-code-hub
pi remove git:github.com/ChinkInArmor/pi-provider-claude-code-hub
```

## Configure

Add a named CCH provider and store its user API key with pi:

```text
/cch-provider-add cch
/login cch
```

Then open the model selector to refresh and choose a model:

```text
/model
```

The extension accepts a CCH root URL or a URL ending in `/v1`, `/v1/models`, `/v1/messages`, `/v1/responses`, or `/v1/chat/completions`. Remote gateways must use HTTPS; HTTP is accepted only for loopback hosts.

## Commands

| Command | Purpose |
|---|---|
| `/cch-provider-add [name]` | Add and register a CCH provider. |
| `/cch-provider-remove [name]` | Remove its configuration; `/logout` is required first when a credential exists. |
| `/cch-provider-list` | Show configured providers and authentication status. |
| `/cch-provider-models [provider]` | Effective parameters per model with rule/source annotations; Enter edits a model. |
| `/cch-model-override [provider] [model|pattern]` | Interactively edit a model override (glob patterns supported). |

## Discovery

The extension queries these user-scoped endpoints in parallel:

| CCH endpoint | pi API |
|---|---|
| `GET /v1/models` with `anthropic-version` | `anthropic-messages` |
| `GET /v1/responses/models` | `openai-responses` |
| `GET /v1/chat/completions/models` | `openai-completions` |

All requests use the same user key in `x-api-key`. CCH's management API and admin token are not used.

Configuration is stored in `<agentDir>/extensions/provider-claude-code-hub.json`; credentials remain in pi's CredentialStore.

### Override rules

`modelOverrides` keys can be exact model IDs or glob patterns (`*`, `?`):

```json
{
  "modelOverrides": {
    "claude-*": { "maxTokens": 64000, "contextWindow": 200000 },
    "claude-sonnet-*": { "reasoning": true },
    "*": { "input": ["text", "image"] }
  }
}
```

Priority: **exact ID > fewer wildcards > longer literal prefix > `*` fallback**. Only the single most specific matching rule applies (rules do not stack). Prefer the interactive editors over hand-editing:

```text
/cch-provider-models cch          # overview table; Enter edits a model
/cch-model-override cch claude-*  # edit a rule
```

See [README.md](README.md) for cache behavior details.

## Project relationship

This is an independently maintained community extension, not an official Claude Code Hub or pi component.

- [ding113/claude-code-hub](https://github.com/ding113/claude-code-hub) provides the gateway and API contract targeted by this extension.
- [ttimasdf/pi-provider-newapi](https://github.com/ttimasdf/pi-provider-newapi) informed the dynamic provider registration, credential ownership, and model caching design.

This repository does not fork or copy either project's Git history. Each project remains subject to its own license.
