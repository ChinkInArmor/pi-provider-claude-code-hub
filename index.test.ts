import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

import { getModels } from "@earendil-works/pi-ai/compat";
import {
  buildCCHModels,
  discoverCCHCatalog,
  normalizeCCHBaseUrl,
  parseCCHModelsResponse,
  rebindCachedModels,
  resolveApiBaseUrl,
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
