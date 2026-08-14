import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { getModels } from "@earendil-works/pi-ai/compat";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import {
  buildCCHModels,
  discoverCCHCatalog,
  normalizeCCHBaseUrl,
  parseCCHModelsResponse,
  rebindCachedModels,
  resolveApiBaseUrl,
  resolveModelOverride,
  matchModelPattern,
} from "./index.ts";

test("normalizeCCHBaseUrl accepts roots and strips API suffixes", () => {
  assert.equal(normalizeCCHBaseUrl("https://hub.example.com/"), "https://hub.example.com");
  assert.equal(normalizeCCHBaseUrl("https://hub.example.com/v1"), "https://hub.example.com");
  assert.equal(
    normalizeCCHBaseUrl("https://hub.example.com/cch/v1/messages"),
    "https://hub.example.com/cch"
  );
  assert.equal(
    normalizeCCHBaseUrl("https://hub.example.com/cch/v1/chat/completions"),
    "https://hub.example.com/cch"
  );
});

test("normalizeCCHBaseUrl rejects invalid and remote cleartext URLs", () => {
  assert.throws(() => normalizeCCHBaseUrl(""));
  assert.throws(() => normalizeCCHBaseUrl("hub.example.com"));
  assert.throws(() => normalizeCCHBaseUrl("ftp://hub.example.com"));
  assert.throws(() => normalizeCCHBaseUrl("http://hub.example.com"));
  assert.throws(() => normalizeCCHBaseUrl("https://user:secret@hub.example.com"));
  assert.equal(normalizeCCHBaseUrl("http://127.0.0.1:23000"), "http://127.0.0.1:23000");
});

test("resolveApiBaseUrl routes each pi API correctly", () => {
  assert.equal(
    resolveApiBaseUrl("https://hub.example.com/v1", "anthropic-messages"),
    "https://hub.example.com"
  );
  assert.equal(
    resolveApiBaseUrl("https://hub.example.com", "openai-responses"),
    "https://hub.example.com/v1"
  );
  assert.equal(
    resolveApiBaseUrl("https://hub.example.com", "openai-completions"),
    "https://hub.example.com/v1"
  );
});

test("parseCCHModelsResponse parses Anthropic and OpenAI lists", () => {
  assert.deepEqual(
    parseCCHModelsResponse(
      {
        data: [
          {
            id: "claude-sonnet-5",
            display_name: "Claude Sonnet 5",
            created_at: "2026-01-01T00:00:00Z",
          },
        ],
      },
      "anthropic-messages"
    ),
    [
      {
        id: "claude-sonnet-5",
        api: "anthropic-messages",
        displayName: "Claude Sonnet 5",
        createdAt: "2026-01-01T00:00:00Z",
      },
    ]
  );

  const openai = parseCCHModelsResponse(
    { object: "list", data: [{ id: "gpt-5.6-sol", object: "model" }] },
    "openai-responses"
  );
  assert.deepEqual(openai, [
    {
      id: "gpt-5.6-sol",
      api: "openai-responses",
      displayName: undefined,
      createdAt: undefined,
    },
  ]);
});

test("parseCCHModelsResponse accepts a valid empty catalog", () => {
  assert.deepEqual(parseCCHModelsResponse({ data: [] }, "openai-completions"), []);
});

test("parseCCHModelsResponse rejects malformed payloads and deduplicates", () => {
  assert.throws(() => parseCCHModelsResponse(null, "anthropic-messages"));
  assert.throws(() => parseCCHModelsResponse({ data: {} }, "openai-responses"));
  const models = parseCCHModelsResponse(
    { data: [{ id: "same" }, { id: "same" }, null, { bad: true }] },
    "openai-completions"
  );
  assert.deepEqual(models.map((model) => model.id), ["same"]);
});

test("discoverCCHCatalog queries all three CCH model endpoints", async () => {
  const requests: Array<{
    url: string;
    apiKey?: string;
    anthropicVersion?: string;
  }> = [];
  const server = createServer((request, response) => {
    requests.push({
      url: request.url ?? "",
      apiKey: request.headers["x-api-key"] as string | undefined,
      anthropicVersion: request.headers["anthropic-version"] as string | undefined,
    });

    const id = request.url?.endsWith("/v1/models")
      ? "claude-sonnet-5"
      : request.url?.endsWith("/v1/responses/models")
        ? "gpt-5.6-sol"
        : "deepseek-v4-pro";
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id }] }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const results = await discoverCCHCatalog({
      baseUrl: `http://127.0.0.1:${address.port}/gateway/v1`,
      apiKey: "cch-test-key",
    });

    assert.equal(results.length, 3);
    assert.ok(results.every((result) => result.ok));
    assert.deepEqual(
      results.flatMap((result) => result.models.map((model) => [model.id, model.api])),
      [
        ["claude-sonnet-5", "anthropic-messages"],
        ["gpt-5.6-sol", "openai-responses"],
        ["deepseek-v4-pro", "openai-completions"],
      ]
    );
    assert.deepEqual(
      requests.map((request) => request.url).sort(),
      [
        "/gateway/v1/chat/completions/models",
        "/gateway/v1/models",
        "/gateway/v1/responses/models",
      ]
    );
    assert.ok(requests.every((request) => request.apiKey === "cch-test-key"));
    assert.equal(
      requests.find((request) => request.url.endsWith("/v1/models"))?.anthropicVersion,
      "2023-06-01"
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});

test("discoverCCHCatalog isolates one endpoint failure", async () => {
  const server = createServer((request, response) => {
    if (request.url?.endsWith("/v1/responses/models")) {
      response.writeHead(503).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [] }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const results = await discoverCCHCatalog({
      baseUrl: `http://127.0.0.1:${address.port}`,
      apiKey: "test-key",
    });
    assert.equal(results.find((result) => result.api === "openai-responses")?.ok, false);
    assert.equal(results.filter((result) => result.ok).length, 2);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});

test("buildCCHModels enriches models and assigns per-model APIs", () => {
  const anthropic = getModels("anthropic").find((model) => model.id === "claude-sonnet-5");
  const openai = getModels("openai").find((model) => model.id === "gpt-5.6-sol");
  assert.ok(anthropic);
  assert.ok(openai);

  const models = buildCCHModels({
    baseUrl: "https://hub.example.com/v1",
    apiModels: [
      { id: anthropic.id, api: "anthropic-messages" },
      { id: openai.id, api: "openai-responses" },
      { id: "private-chat-alias", api: "openai-completions" },
    ],
  });

  const claude = models.find((model) => model.id === anthropic.id);
  const gpt = models.find((model) => model.id === openai.id);
  const alias = models.find((model) => model.id === "private-chat-alias");
  assert.equal(claude?.api, "anthropic-messages");
  assert.equal(claude?.baseUrl, "https://hub.example.com");
  assert.equal(claude?.contextWindow, anthropic.contextWindow);
  assert.equal(gpt?.api, "openai-responses");
  assert.equal(gpt?.baseUrl, "https://hub.example.com/v1");
  assert.equal(gpt?.reasoning, openai.reasoning);
  assert.equal(alias?.api, "openai-completions");
  assert.equal(alias?.reasoning, false);
  assert.deepEqual(alias?.input, ["text"]);
});

test("buildCCHModels prefers the protocol matching built-in metadata for duplicates", () => {
  const [model] = buildCCHModels({
    baseUrl: "https://hub.example.com",
    apiModels: [
      { id: "gpt-5.6-sol", api: "openai-completions" },
      { id: "gpt-5.6-sol", api: "openai-responses" },
    ],
  });
  assert.equal(model.api, "openai-responses");
});

test("buildCCHModels applies explicit alias overrides", () => {
  const [model] = buildCCHModels({
    baseUrl: "https://hub.example.com",
    apiModels: [{ id: "team-coding-model", api: "anthropic-messages" }],
    modelOverrides: {
      "team-coding-model": {
        name: "Team Claude",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 200_000,
        maxTokens: 64_000,
        cost: { input: 3, output: 15 },
        compat: { forceAdaptiveThinking: true },
      },
    },
  });
  assert.equal(model.name, "Team Claude");
  assert.equal(model.reasoning, true);
  assert.deepEqual(model.input, ["text", "image"]);
  assert.deepEqual(model.cost, { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 });
  assert.deepEqual(model.compat, { forceAdaptiveThinking: true });
});

test("matchModelPattern supports exact IDs, * and ? wildcards", () => {
  assert.equal(matchModelPattern("claude-sonnet-5", "claude-sonnet-5"), true);
  assert.equal(matchModelPattern("claude-sonnet-5", "claude-sonnet-4"), false);
  assert.equal(matchModelPattern("claude-*", "claude-sonnet-5"), true);
  assert.equal(matchModelPattern("claude-*", "gpt-5"), false);
  assert.equal(matchModelPattern("*", "anything-here"), true);
  assert.equal(matchModelPattern("claude-sonnet-?", "claude-sonnet-5"), true);
  assert.equal(matchModelPattern("claude-sonnet-?", "claude-sonnet-5-2025"), false);
  assert.equal(matchModelPattern("claude-*-latest", "claude-sonnet-5-latest"), true);
  assert.equal(matchModelPattern("a.b", "a.b"), true);
  assert.equal(matchModelPattern("a.b", "aXb"), false);
});

test("resolveModelOverride prefers exact ID, then more specific patterns, then *", () => {
  const overrides = {
    "claude-*": { maxTokens: 32_000 },
    "claude-sonnet-*": { contextWindow: 200_000 },
    "claude-sonnet-5": { reasoning: true },
    "*": { name: "catch-all" },
  };
  assert.equal(resolveModelOverride(overrides, "claude-sonnet-5")?.reasoning, true);
  // exact match wins wholesale: the claude-sonnet-* rule's contextWindow
  // and claude-*'s maxTokens do not leak through
  assert.equal(resolveModelOverride(overrides, "claude-sonnet-5")?.contextWindow, undefined);
  assert.equal(resolveModelOverride(overrides, "claude-sonnet-5")?.maxTokens, undefined);
  assert.equal(resolveModelOverride(overrides, "claude-sonnet-7")?.contextWindow, 200_000);
  // claude-sonnet-* is more specific than claude-*, so maxTokens stays unset;
  // the global * fallback only applies when no other pattern matches
  assert.equal(resolveModelOverride(overrides, "claude-sonnet-7")?.maxTokens, undefined);
  assert.equal(resolveModelOverride(overrides, "claude-sonnet-7")?.name, undefined);
  assert.equal(resolveModelOverride(overrides, "claude-opus-4")?.maxTokens, 32_000);
  assert.equal(resolveModelOverride(overrides, "claude-opus-4")?.name, undefined);
  assert.equal(resolveModelOverride(overrides, "gpt-5")?.name, "catch-all");
  assert.equal(resolveModelOverride(overrides, "gpt-5")?.maxTokens, undefined);
  assert.equal(resolveModelOverride(overrides, "nope")?.maxTokens, undefined);
});

test("resolveModelOverride uses literal prefix length as tie-breaker", () => {
  const overrides = {
    "claude-*": { name: "broad" },
    "claude-sonnet-*": { name: "narrow" },
  };
  assert.equal(resolveModelOverride(overrides, "claude-sonnet-9")?.name, "narrow");
  assert.equal(resolveModelOverride(overrides, "claude-opus-4")?.name, "broad");
});

test("resolveModelOverride handles ties by declaration order and empty inputs", () => {
  const overrides = {
    "a-*": { name: "first" },
    "*-a": { name: "second" },
  };
  assert.equal(resolveModelOverride(overrides, "a-a")?.name, "first");
  assert.equal(resolveModelOverride(undefined, "x"), undefined);
  assert.equal(resolveModelOverride({}, "x"), undefined);
});

test("buildCCHModels applies rule-based overrides and exact overrides", () => {
  const models = buildCCHModels({
    baseUrl: "https://hub.example.com",
    apiModels: [
      { id: "claude-sonnet-5", api: "anthropic-messages" },
      { id: "claude-opus-4", api: "anthropic-messages" },
      { id: "custom-model", api: "openai-responses" },
    ],
    modelOverrides: {
      "claude-*": { maxTokens: 64_000, contextWindow: 200_000 },
      "claude-sonnet-5": { reasoning: true },
      "*": { input: ["text", "image"] },
    },
  });
  const sonnet = models.find((model) => model.id === "claude-sonnet-5");
  const opus = models.find((model) => model.id === "claude-opus-4");
  const custom = models.find((model) => model.id === "custom-model");
  assert.equal(sonnet?.reasoning, true);
  // exact override wins wholesale: claude-* rule does not apply to sonnet-5,
  // and built-in catalog metadata still fills contextWindow
  assert.equal(sonnet?.maxTokens, 128_000);
  assert.equal(sonnet?.contextWindow, 1_000_000);
  assert.equal(opus?.maxTokens, 64_000);
  assert.equal(opus?.contextWindow, 200_000);
  assert.equal(custom?.maxTokens, 16_384);
  assert.deepEqual(custom?.input, ["text", "image"]);
});

test("rebindCachedModels applies rule-based overrides to cached models", () => {
  const cached: ProviderModelConfig[] = [
    {
      id: "claude-sonnet-5",
      name: "Claude",
      api: "anthropic-messages",
      baseUrl: "https://old.example.com",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 16_384,
    },
  ];
  const models = rebindCachedModels({
    models: cached,
    baseUrl: "https://new.example.com/v1",
    modelOverrides: { "claude-*": { maxTokens: 32_000 } },
  });
  assert.equal(models[0].maxTokens, 32_000);
  assert.equal(models[0].baseUrl, "https://new.example.com");
});

test("rebindCachedModels updates endpoint URLs according to each API", () => {
  const models = rebindCachedModels({
    models: [
      {
        id: "claude-model",
        name: "Claude",
        api: "anthropic-messages",
        baseUrl: "https://old.example.com",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 16_384,
      },
      {
        id: "gpt-model",
        name: "GPT",
        api: "openai-responses",
        baseUrl: "https://old.example.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 16_384,
      },
    ],
    baseUrl: "https://new.example.com/v1",
  });
  assert.equal(models.find((model) => model.id === "claude-model")?.baseUrl, "https://new.example.com");
  assert.equal(models.find((model) => model.id === "gpt-model")?.baseUrl, "https://new.example.com/v1");
});

async function loadRegisteredProvider() {
  const agentDir = join(tmpdir(), `cch-test-${process.pid}-${Date.now()}`);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "claude-sonnet-5" }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const { default: claudeCodeHubExtension } = await import("./index.ts");
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  writeFileSync(
    join(agentDir, "extensions", "provider-claude-code-hub.json"),
    JSON.stringify({
      providers: { MyCCH: { baseUrl: `http://127.0.0.1:${address.port}`, modelOverrides: {} } },
      settings: {},
    })
  );

  const registrations: Array<{
    name: string;
    config: { refreshModels?: (context: unknown) => Promise<unknown> };
  }> = [];
  await claudeCodeHubExtension({
    registerProvider(name: string, config: { refreshModels?: (context: unknown) => Promise<unknown> }) {
      registrations.push({ name, config });
    },
    registerCommand() {},
    unregisterProvider() {},
  } as never);

  const provider = registrations.find((entry) => entry.name === "MyCCH");
  assert.ok(provider?.config.refreshModels, "refreshModels should be registered");
  return {
    refreshModels: provider.config.refreshModels,
    cleanup: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(agentDir, { recursive: true, force: true });
    },
  };
}

test("refreshModels persists via publish on the pi-ai 0.84+ context", async () => {
  const { refreshModels, cleanup } = await loadRegisteredProvider();
  try {
    let published: unknown;
    const models = (await refreshModels({
      credential: { type: "api_key", key: "cch-test-key" },
      stored: undefined,
      publish: async (publication: unknown) => {
        published = publication;
        return true;
      },
      allowNetwork: true,
      signal: new AbortController().signal,
    })) as Array<{ id: string }> | undefined;
    assert.deepEqual(models?.map((model) => (model as { id: string }).id), ["claude-sonnet-5"]);
    const persist = (published as { persist?: { models?: unknown[]; checkedAt?: number } }).persist;
    assert.equal(persist?.models?.length, 1);
    assert.equal(typeof persist?.checkedAt, "number");
  } finally {
    await cleanup();
  }
});

test("refreshModels persists via store on the pi-ai 0.83 context", async () => {
  const { refreshModels, cleanup } = await loadRegisteredProvider();
  try {
    let written: unknown;
    const models = (await refreshModels({
      credential: { type: "api_key", key: "cch-test-key" },
      store: {
        read: async () => undefined,
        write: async (entry: unknown) => {
          written = entry;
        },
      },
      allowNetwork: true,
      signal: new AbortController().signal,
    })) as Array<{ id: string }> | undefined;
    assert.deepEqual(models?.map((model) => (model as { id: string }).id), ["claude-sonnet-5"]);
    const entry = written as { models?: unknown[]; checkedAt?: number };
    assert.equal(entry?.models?.length, 1);
    assert.equal(typeof entry?.checkedAt, "number");
  } finally {
    await cleanup();
  }
});
