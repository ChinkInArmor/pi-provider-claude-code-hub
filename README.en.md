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

pi Coding Agent 0.83.0 or newer is required.

## Install and configure

```powershell
pi install ./pi-provider-claude-code-hub
```

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

## Discovery

The extension queries these user-scoped endpoints in parallel:

| CCH endpoint | pi API |
|---|---|
| `GET /v1/models` with `anthropic-version` | `anthropic-messages` |
| `GET /v1/responses/models` | `openai-responses` |
| `GET /v1/chat/completions/models` | `openai-completions` |

All requests use the same user key in `x-api-key`. CCH's management API and admin token are not used.

Configuration is stored in `<agentDir>/extensions/provider-claude-code-hub.json`; credentials remain in pi's CredentialStore. See [README.md](README.md) for model override and cache behavior details.

## Project relationship

This is an independently maintained community extension, not an official Claude Code Hub or pi component.

- [ding113/claude-code-hub](https://github.com/ding113/claude-code-hub) provides the gateway and API contract targeted by this extension.
- [ttimasdf/pi-provider-newapi](https://github.com/ttimasdf/pi-provider-newapi) informed the dynamic provider registration, credential ownership, and model caching design.

This repository does not fork or copy either project's Git history. Each project remains subject to its own license.
