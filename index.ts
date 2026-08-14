/**
 * Claude Code Hub provider extension for pi (v0.83.0+).
 *
 * A single named CCH provider can expose Anthropic Messages, OpenAI Responses,
 * and OpenAI Chat Completions models. Pi owns credentials through /login; this
 * extension stores only gateway URLs and optional model metadata overrides.
 */

import {
  type Api,
  type Model,
  type ModelThinkingLevel,
  type ModelsStoreEntry,
  type RefreshModelsContext,
  type ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import { getModels, getProviders, type BuiltinProvider } from "@earendil-works/pi-ai/compat";
import {
  getAgentDir,
  type ExtensionAPI,
  type ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const CONFIG_FILENAME = "provider-claude-code-hub.json";
const DEFAULT_PROVIDER_NAME = "cch";
const FETCH_TIMEOUT_MS = 10_000;
const ONBOARDING_WARN_MAX = 3;
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

export type CCHModelApi = "anthropic-messages" | "openai-responses" | "openai-completions";

interface EndpointDefinition {
  api: CCHModelApi;
  path: string;
  headers: Record<string, string>;
}

const CCH_ENDPOINTS: readonly EndpointDefinition[] = [
  {
    api: "anthropic-messages",
    path: "/v1/models",
    headers: { "anthropic-version": ANTHROPIC_VERSION },
  },
  { api: "openai-responses", path: "/v1/responses/models", headers: {} },
  {
    api: "openai-completions",
    path: "/v1/chat/completions/models",
    headers: {},
  },
];

const API_PREFERENCE: readonly CCHModelApi[] = [
  "anthropic-messages",
  "openai-responses",
  "openai-completions",
];

const ENRICHMENT_PROVIDERS = [
  "anthropic",
  "openai",
  "xai",
  "deepseek",
  "zai",
  "google",
  "minimax",
  "moonshotai",
  "xiaomi",
  "fireworks",
  "openrouter",
  "vercel-ai-gateway",
] as const;

export interface CCHModelEntry {
  id: string;
  api: CCHModelApi;
  displayName?: string;
  createdAt?: string;
}

export interface CCHDiscoveryResult {
  api: CCHModelApi;
  ok: boolean;
  models: CCHModelEntry[];
  error?: string;
}

interface CCHModelOverride {
  name?: string;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  contextWindow?: number;
  maxTokens?: number;
  thinkingLevelMap?: Partial<Record<ModelThinkingLevel, string | null>>;
  cost?: Partial<Model<Api>["cost"]>;
  compat?: Model<Api>["compat"];
}

interface ProviderEntry {
  baseUrl: string;
  modelOverrides: Record<string, CCHModelOverride>;
}

interface Settings {
  onboardingWarnCountdown?: number;
}

interface CCHConfig {
  providers: Record<string, ProviderEntry>;
  settings: Settings;
}

type CCHErrorCode = "aborted" | "timeout" | "auth" | "http" | "payload" | "network";

class CCHError extends Error {
  readonly code: CCHErrorCode;

  constructor(code: CCHErrorCode, message: string) {
    super(message);
    this.name = "CCHError";
    this.code = code;
  }
}

export function normalizeCCHBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Base URL cannot be empty");

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("Base URL must be a valid absolute URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Base URL must use http or https");
  }
  if (
    url.protocol === "http:" &&
    !["localhost", "127.0.0.1", "::1"].includes(url.hostname.toLowerCase())
  ) {
    throw new Error("Remote Claude Code Hub URLs must use HTTPS; HTTP is allowed only for localhost");
  }
  if (url.username || url.password) {
    throw new Error("Base URL must not contain credentials");
  }

  url.search = "";
  url.hash = "";

  let path = url.pathname.replace(/\/+$/, "");
  path = path.replace(/\/v1\/(?:messages|models|responses|chat\/completions)$/i, "");
  path = path.replace(/\/v1$/i, "");
  url.pathname = path || "/";
  return url.toString().replace(/\/$/, "");
}

export function resolveApiBaseUrl(baseUrl: string, api: CCHModelApi): string {
  const root = normalizeCCHBaseUrl(baseUrl);
  return api === "anthropic-messages" ? root : `${root}/v1`;
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit & { timeoutMs?: number; signal?: AbortSignal | null } = {}
): Promise<Response> {
  const { timeoutMs = FETCH_TIMEOUT_MS, signal: upstream, ...fetchOptions } = options;
  if (upstream?.aborted) throw new CCHError("aborted", "Model refresh cancelled");

  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
  const signals = upstream ? [timeoutController.signal, upstream] : [timeoutController.signal];
  const signal =
    typeof AbortSignal.any === "function" ? AbortSignal.any(signals) : timeoutController.signal;

  let bridge: (() => void) | undefined;
  if (typeof AbortSignal.any !== "function" && upstream) {
    bridge = () => timeoutController.abort();
    upstream.addEventListener("abort", bridge, { once: true });
  }

  try {
    return await fetch(url, { ...fetchOptions, signal });
  } catch (error) {
    if (upstream?.aborted) throw new CCHError("aborted", "Model refresh cancelled");
    if (timeoutController.signal.aborted) {
      throw new CCHError("timeout", `Request timed out after ${timeoutMs / 1000}s`);
    }
    throw new CCHError(
      "network",
      `Request failed: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    clearTimeout(timer);
    if (bridge && upstream) upstream.removeEventListener("abort", bridge);
  }
}

export function parseCCHModelsResponse(
  payload: unknown,
  api: CCHModelApi
): CCHModelEntry[] {
  if (!payload || typeof payload !== "object") {
    throw new CCHError("payload", "Model endpoint returned a non-object payload");
  }

  const data = (payload as Record<string, unknown>).data;
  if (!Array.isArray(data)) {
    throw new CCHError("payload", "Model endpoint payload has no data array");
  }

  const models: CCHModelEntry[] = [];
  const seen = new Set<string>();
  for (const value of data) {
    if (!value || typeof value !== "object") continue;
    const item = value as Record<string, unknown>;
    if (typeof item.id !== "string" || !item.id.trim()) continue;

    const id = item.id.trim();
    if (seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      api,
      displayName:
        typeof item.display_name === "string" && item.display_name.trim()
          ? item.display_name.trim()
          : undefined,
      createdAt:
        typeof item.created_at === "string" && item.created_at.trim()
          ? item.created_at.trim()
          : undefined,
    });
  }
  return models;
}

async function fetchEndpointModels(params: {
  baseUrl: string;
  apiKey: string;
  endpoint: EndpointDefinition;
  signal?: AbortSignal;
}): Promise<CCHModelEntry[]> {
  const root = normalizeCCHBaseUrl(params.baseUrl);
  const response = await fetchWithTimeout(`${root}${params.endpoint.path}`, {
    method: "GET",
    headers: {
      "x-api-key": params.apiKey,
      accept: "application/json",
      ...params.endpoint.headers,
    },
    signal: params.signal,
  });

  if (response.status === 401 || response.status === 403) {
    throw new CCHError(
      "auth",
      `GET ${params.endpoint.path} returned ${response.status}; check the API key`
    );
  }
  if (!response.ok) {
    throw new CCHError(
      "http",
      `GET ${params.endpoint.path} returned ${response.status} ${response.statusText}`
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new CCHError("payload", `GET ${params.endpoint.path} returned invalid JSON`);
  }
  return parseCCHModelsResponse(payload, params.endpoint.api);
}

export async function discoverCCHCatalog(params: {
  baseUrl: string;
  apiKey: string;
  signal?: AbortSignal;
}): Promise<CCHDiscoveryResult[]> {
  return Promise.all(
    CCH_ENDPOINTS.map(async (endpoint): Promise<CCHDiscoveryResult> => {
      try {
        return {
          api: endpoint.api,
          ok: true,
          models: await fetchEndpointModels({ ...params, endpoint }),
        };
      } catch (error) {
        if (error instanceof CCHError && error.code === "aborted") throw error;
        return {
          api: endpoint.api,
          ok: false,
          models: [],
          error: error instanceof Error ? error.message : String(error),
        };
      }
    })
  );
}

function normalizedModelId(id: string): string {
  return id
    .toLowerCase()
    .replace(/^(?:anthropic|openai|xai|deepseek|zai|google|moonshotai)\//, "")
    .replace(/[._]/g, "-");
}

interface EnrichmentItem {
  model: Model<Api>;
  source: string;
}

let enrichmentLookup: Map<string, EnrichmentItem[]> | undefined;

function getEnrichmentLookup(): Map<string, EnrichmentItem[]> {
  if (enrichmentLookup) return enrichmentLookup;

  const lookup = new Map<string, EnrichmentItem[]>();
  for (const provider of ENRICHMENT_PROVIDERS) {
    let models: Model<Api>[];
    try {
      models = getModels(provider as BuiltinProvider) as Model<Api>[];
    } catch {
      continue;
    }

    for (const model of models) {
      if (!API_PREFERENCE.includes(model.api as CCHModelApi)) continue;
      const key = normalizedModelId(model.id);
      const items = lookup.get(key) ?? [];
      items.push({ model, source: provider });
      lookup.set(key, items);
    }
  }

  enrichmentLookup = lookup;
  return lookup;
}

function findEnrichment(entry: CCHModelEntry): EnrichmentItem | undefined {
  const candidates = getEnrichmentLookup().get(normalizedModelId(entry.id)) ?? [];
  return candidates.find((item) => item.model.api === entry.api) ?? candidates[0];
}

function mergeCost(
  base: Model<Api>["cost"] | undefined,
  override: CCHModelOverride["cost"]
): Model<Api>["cost"] {
  return {
    input: override?.input ?? base?.input ?? DEFAULT_COST.input,
    output: override?.output ?? base?.output ?? DEFAULT_COST.output,
    cacheRead: override?.cacheRead ?? base?.cacheRead ?? DEFAULT_COST.cacheRead,
    cacheWrite: override?.cacheWrite ?? base?.cacheWrite ?? DEFAULT_COST.cacheWrite,
    ...(base?.tiers ? { tiers: base.tiers } : {}),
    ...(override?.tiers ? { tiers: override.tiers } : {}),
  };
}

function enrichmentSourceRank(source: string): number {
  const rank = ENRICHMENT_PROVIDERS.indexOf(source as (typeof ENRICHMENT_PROVIDERS)[number]);
  return rank === -1 ? Number.MAX_SAFE_INTEGER : rank;
}

function selectUniqueEntries(entries: CCHModelEntry[]): CCHModelEntry[] {
  const grouped = new Map<string, CCHModelEntry[]>();
  for (const entry of entries) {
    const items = grouped.get(entry.id) ?? [];
    items.push(entry);
    grouped.set(entry.id, items);
  }

  return [...grouped.values()].map((items) => {
    if (items.length === 1) return items[0];
    const matching = items
      .map((entry) => ({ entry, enrichment: findEnrichment(entry) }))
      .filter(
        (item): item is { entry: CCHModelEntry; enrichment: EnrichmentItem } =>
          item.enrichment?.model.api === item.entry.api
      )
      .sort((a, b) => {
        const sourceDifference =
          enrichmentSourceRank(a.enrichment.source) - enrichmentSourceRank(b.enrichment.source);
        return sourceDifference !== 0
          ? sourceDifference
          : API_PREFERENCE.indexOf(a.entry.api) - API_PREFERENCE.indexOf(b.entry.api);
      });
    if (matching.length > 0) return matching[0].entry;
    return [...items].sort(
      (a, b) => API_PREFERENCE.indexOf(a.api) - API_PREFERENCE.indexOf(b.api)
    )[0];
  });
}

export function buildCCHModels(params: {
  baseUrl: string;
  apiModels: CCHModelEntry[];
  modelOverrides?: Record<string, CCHModelOverride>;
}): ProviderModelConfig[] {
  const root = normalizeCCHBaseUrl(params.baseUrl);
  const overrides = params.modelOverrides ?? {};

  return selectUniqueEntries(params.apiModels).map((entry) => {
    const enriched = findEnrichment(entry);
    const override = overrides[entry.id] ?? {};
    const source = enriched?.model;
    const sourceCompat = source?.api === entry.api ? source.compat : undefined;
    const compat =
      sourceCompat || override.compat
        ? {
            ...(sourceCompat as Record<string, unknown> | undefined),
            ...(override.compat as Record<string, unknown> | undefined),
          }
        : undefined;

    return {
      id: entry.id,
      name: override.name ?? entry.displayName ?? source?.name ?? entry.id,
      api: entry.api,
      baseUrl: resolveApiBaseUrl(root, entry.api),
      reasoning: override.reasoning ?? source?.reasoning ?? false,
      thinkingLevelMap:
        override.thinkingLevelMap ?? (source?.thinkingLevelMap as ThinkingLevelMap | undefined),
      input: override.input ?? source?.input ?? ["text"],
      cost: mergeCost(source?.cost, override.cost),
      contextWindow: override.contextWindow ?? source?.contextWindow ?? 128_000,
      maxTokens: override.maxTokens ?? source?.maxTokens ?? 16_384,
      compat: compat as Model<Api>["compat"],
    };
  });
}

function emptyConfig(): CCHConfig {
  return { providers: {}, settings: {} };
}

function configPath(): string {
  return join(getAgentDir(), "extensions", CONFIG_FILENAME);
}

function writeConfigAtomic(config: CCHConfig): void {
  const path = configPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const temporary = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(temporary, JSON.stringify(config, null, 2), "utf8");
  renameSync(temporary, path);
}

function invalidateConfig(path: string, raw: string): void {
  const backup = `${path}.bak`;
  console.warn(`Claude Code Hub: invalid config; backing it up to ${backup}`);
  try {
    writeFileSync(backup, raw, "utf8");
  } catch (error) {
    console.warn(
      `Claude Code Hub: failed to write config backup: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  try {
    writeConfigAtomic(emptyConfig());
  } catch (error) {
    console.warn(
      `Claude Code Hub: failed to reset config: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function parseProviderEntry(value: unknown): ProviderEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.baseUrl !== "string") return undefined;

  let baseUrl: string;
  try {
    baseUrl = normalizeCCHBaseUrl(record.baseUrl);
  } catch {
    return undefined;
  }

  const modelOverrides: Record<string, CCHModelOverride> = {};
  if (record.modelOverrides && typeof record.modelOverrides === "object") {
    for (const [id, raw] of Object.entries(record.modelOverrides as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as Record<string, unknown>;
      const override: CCHModelOverride = {};
      if (typeof item.name === "string") override.name = item.name;
      if (typeof item.reasoning === "boolean") override.reasoning = item.reasoning;
      if (isStringArray(item.input) && item.input.every((v) => v === "text" || v === "image")) {
        override.input = item.input as ("text" | "image")[];
      }
      if (typeof item.contextWindow === "number" && item.contextWindow > 0) {
        override.contextWindow = item.contextWindow;
      }
      if (typeof item.maxTokens === "number" && item.maxTokens > 0) {
        override.maxTokens = item.maxTokens;
      }
      if (item.thinkingLevelMap && typeof item.thinkingLevelMap === "object") {
        override.thinkingLevelMap = item.thinkingLevelMap as CCHModelOverride["thinkingLevelMap"];
      }
      if (item.cost && typeof item.cost === "object") {
        override.cost = item.cost as CCHModelOverride["cost"];
      }
      if (item.compat && typeof item.compat === "object") {
        override.compat = item.compat as CCHModelOverride["compat"];
      }
      modelOverrides[id] = override;
    }
  }

  return { baseUrl, modelOverrides };
}

function readConfig(): CCHConfig {
  const path = configPath();
  if (!existsSync(path)) return emptyConfig();

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    console.warn(
      `Claude Code Hub: failed to read config: ${error instanceof Error ? error.message : String(error)}`
    );
    return emptyConfig();
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    invalidateConfig(path, raw);
    return emptyConfig();
  }

  if (!value || typeof value !== "object") {
    invalidateConfig(path, raw);
    return emptyConfig();
  }

  const record = value as Record<string, unknown>;
  if (!record.providers || typeof record.providers !== "object") {
    invalidateConfig(path, raw);
    return emptyConfig();
  }

  const providers: Record<string, ProviderEntry> = {};
  for (const [name, rawEntry] of Object.entries(record.providers as Record<string, unknown>)) {
    const entry = parseProviderEntry(rawEntry);
    if (entry) providers[name] = entry;
  }

  const settings: Settings = {};
  if (record.settings && typeof record.settings === "object") {
    const countdown = (record.settings as Record<string, unknown>).onboardingWarnCountdown;
    if (typeof countdown === "number" && Number.isInteger(countdown)) {
      settings.onboardingWarnCountdown = countdown;
    }
  }
  return { providers, settings };
}

let configWriteQueue: Promise<void> = Promise.resolve();

function updateConfig(mutator: (config: CCHConfig) => boolean): Promise<void> {
  const run = configWriteQueue.then(() => {
    const config = readConfig();
    if (mutator(config)) writeConfigAtomic(config);
  });
  configWriteQueue = run.catch(() => {});
  return run;
}

export function rebindCachedModels(params: {
  models: ProviderModelConfig[];
  baseUrl: string;
  modelOverrides?: Record<string, CCHModelOverride>;
}): ProviderModelConfig[] {
  const modelOverrides = params.modelOverrides ?? {};
  return params.models
    .filter(
      (model) =>
        typeof model.id === "string" && API_PREFERENCE.includes(model.api as CCHModelApi)
    )
    .map((model) => {
      const api = model.api as CCHModelApi;
      const override = modelOverrides[model.id];
      const rebound: ProviderModelConfig = {
        ...model,
        api,
        baseUrl: resolveApiBaseUrl(params.baseUrl, api),
      };
      if (!override) return rebound;

      return {
        ...rebound,
        name: override.name ?? model.name ?? model.id,
        reasoning: override.reasoning ?? model.reasoning,
        input: override.input ?? model.input,
        contextWindow: override.contextWindow ?? model.contextWindow,
        maxTokens: override.maxTokens ?? model.maxTokens,
        thinkingLevelMap: override.thinkingLevelMap ?? model.thinkingLevelMap,
        cost: mergeCost(model.cost, override.cost),
        compat: override.compat
          ? ({
              ...(model.compat as Record<string, unknown> | undefined),
              ...(override.compat as Record<string, unknown>),
            } as Model<Api>["compat"])
          : model.compat,
      };
    });
}

function mergeDiscoveryWithCache(params: {
  results: CCHDiscoveryResult[];
  cachedModels: ProviderModelConfig[];
  baseUrl: string;
  modelOverrides: Record<string, CCHModelOverride>;
}): ProviderModelConfig[] {
  const entries = params.results.flatMap((result) => (result.ok ? result.models : []));
  const fresh = buildCCHModels({
    baseUrl: params.baseUrl,
    apiModels: entries,
    modelOverrides: params.modelOverrides,
  });
  const freshIds = new Set(fresh.map((model) => model.id));
  const failedApis = new Set(
    params.results.filter((result) => !result.ok).map((result) => result.api)
  );
  const retained = params.cachedModels.filter(
    (model) => failedApis.has(model.api as CCHModelApi) && !freshIds.has(model.id)
  );
  return [...fresh, ...retained].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * RefreshModelsContext changed between pi-ai 0.83 and 0.84:
 * - 0.83: async `store: ProviderModelsStore` (read()/write())
 * - 0.84: synchronous `stored` snapshot plus generation-checked `publish()`
 * The provider-scoped store field was removed in 0.84, so detect at runtime.
 */
interface RefreshContextCompat {
  credential?: { type: string; key?: string };
  store?: {
    read(): Promise<ModelsStoreEntry | undefined>;
    write(entry: ModelsStoreEntry): Promise<void>;
  };
  stored?: Readonly<ModelsStoreEntry>;
  publish?: (publication: {
    persist?: ModelsStoreEntry | null;
    update?: () => void;
  }) => Promise<boolean>;
  allowNetwork: boolean;
  signal?: AbortSignal;
}

async function refreshProviderModels(
  providerName: string,
  context: RefreshModelsContext
): Promise<ProviderModelConfig[]> {
  const entry = readConfig().providers[providerName];
  if (!entry) return [];

  const compat = context as unknown as RefreshContextCompat;
  const cached = compat.store ? await compat.store.read() : compat.stored;
  const cachedModels = rebindCachedModels({
    models: (cached?.models ?? []) as unknown as ProviderModelConfig[],
    baseUrl: entry.baseUrl,
    modelOverrides: entry.modelOverrides,
  });
  if (!context.allowNetwork || context.signal?.aborted) return cachedModels;

  const credential = context.credential;
  const apiKey = credential?.type === "api_key" ? credential.key : undefined;
  if (!apiKey) return cachedModels;

  try {
    const results = await discoverCCHCatalog({
      baseUrl: entry.baseUrl,
      apiKey,
      signal: context.signal,
    });
    for (const result of results) {
      if (!result.ok) {
        console.warn(`Claude Code Hub [${providerName}] ${result.api}: ${result.error}`);
      }
    }
    if (results.every((result) => !result.ok)) return cachedModels;

    const models = mergeDiscoveryWithCache({
      results,
      cachedModels,
      baseUrl: entry.baseUrl,
      modelOverrides: entry.modelOverrides,
    });
    const entry_ = {
      models: models as unknown as Model<Api>[],
      checkedAt: Date.now(),
    } satisfies ModelsStoreEntry;
    if (compat.store) {
      await compat.store.write(entry_);
    } else if (compat.publish) {
      await compat.publish({ persist: entry_ });
    }
    return models;
  } catch (error) {
    if (error instanceof CCHError && error.code === "aborted") return cachedModels;
    console.warn(
      `Claude Code Hub [${providerName}]: model refresh failed: ${error instanceof Error ? error.message : String(error)}` +
        (cachedModels.length ? " (using cached catalog)" : "")
    );
    return cachedModels;
  }
}

function registerCCHProvider(pi: ExtensionAPI, name: string, entry: ProviderEntry): void {
  pi.registerProvider(name, {
    name: `Claude Code Hub (${name})`,
    baseUrl: entry.baseUrl,
    api: "anthropic-messages",
    models: [],
    async refreshModels(context) {
      return refreshProviderModels(name, context);
    },
  });
}

function validProviderName(name: string): boolean {
  return name.length > 0 && !/[\s/\\]/.test(name);
}

export default async function claudeCodeHubExtension(pi: ExtensionAPI): Promise<void> {
  const config = readConfig();
  const builtinProviderIds = new Set(getProviders() as unknown as string[]);
  const registered = new Set<string>();

  for (const [name, entry] of Object.entries(config.providers)) {
    if (builtinProviderIds.has(name)) {
      console.warn(`Claude Code Hub: skipping "${name}" because it is a built-in provider ID`);
      continue;
    }
    registerCCHProvider(pi, name, entry);
    registered.add(name);
  }

  if (registered.size === 0) {
    const countdown = config.settings.onboardingWarnCountdown ?? ONBOARDING_WARN_MAX;
    if (countdown > 0) {
      console.warn("Claude Code Hub: no providers configured. Run /cch-provider-add to add one.");
      void updateConfig((current) => {
        current.settings.onboardingWarnCountdown = countdown - 1;
        return true;
      });
    }
  }

  pi.registerCommand("cch-provider-add", {
    description: "Add a Claude Code Hub provider, then authenticate it with /login",
    handler: async (args, ctx) => {
      let name = args.trim();
      if (!name) {
        const input = await ctx.ui.input("Provider name", DEFAULT_PROVIDER_NAME);
        if (input === undefined) return;
        name = input.trim();
      }

      if (!validProviderName(name)) {
        ctx.ui.notify("Provider name cannot be empty or contain spaces or slashes.", "error");
        return;
      }
      if (builtinProviderIds.has(name)) {
        ctx.ui.notify(`Provider name "${name}" collides with a built-in provider.`, "error");
        return;
      }

      const current = readConfig();
      if (current.providers[name]) {
        ctx.ui.notify(`Provider "${name}" already exists.`, "error");
        return;
      }
      if (ctx.modelRegistry.getProvider(name)) {
        ctx.ui.notify(
          `Provider name "${name}" is already registered by another extension or pi.`,
          "error"
        );
        return;
      }
      const existingAuth = ctx.modelRegistry.getProviderAuthStatus(name);
      if (existingAuth.configured) {
        ctx.ui.notify(
          `Credential "${name}" already exists. Run /logout ${name} before reusing this provider name.`,
          "error"
        );
        return;
      }

      const rawBaseUrl = await ctx.ui.input("Claude Code Hub URL", "http://localhost:23000");
      if (rawBaseUrl === undefined) return;

      let baseUrl: string;
      try {
        baseUrl = normalizeCCHBaseUrl(rawBaseUrl);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return;
      }

      try {
        const response = await fetchWithTimeout(`${baseUrl}/v1/models`, {
          headers: { "anthropic-version": ANTHROPIC_VERSION },
          signal: ctx.signal,
        });
        if (!response.ok && response.status !== 401 && response.status !== 403) {
          ctx.ui.notify(
            `Warning: ${baseUrl} returned ${response.status} ${response.statusText}; saving anyway.`,
            "warning"
          );
        }
      } catch (error) {
        ctx.ui.notify(
          `Warning: could not reach ${baseUrl} (${error instanceof Error ? error.message : String(error)}); saving anyway.`,
          "warning"
        );
      }

      const entry: ProviderEntry = { baseUrl, modelOverrides: {} };
      await updateConfig((next) => {
        next.providers[name] = entry;
        return true;
      });
      registerCCHProvider(pi, name, entry);
      registered.add(name);
      ctx.ui.notify(
        `Provider "${name}" added. Run /login ${name}; Pi will discover all active CCH models.`,
        "info"
      );
    },
  });

  pi.registerCommand("cch-provider-remove", {
    description: "Remove a Claude Code Hub provider (run /logout first)",
    handler: async (args, ctx) => {
      const current = readConfig();
      const names = Object.keys(current.providers);
      if (names.length === 0) {
        ctx.ui.notify("No Claude Code Hub providers are configured.", "info");
        return;
      }

      let name = args.trim();
      if (!name) {
        const selected = await ctx.ui.select("Provider to remove", names);
        if (selected === undefined) return;
        name = selected;
      }
      if (!current.providers[name]) {
        ctx.ui.notify(`Provider "${name}" is not configured.`, "error");
        return;
      }

      const auth = ctx.modelRegistry.getProviderAuthStatus(name);
      if (auth.configured) {
        ctx.ui.notify(
          `Run /logout ${name} before removing the provider so its credential cannot be reused accidentally.`,
          "error"
        );
        return;
      }
      const confirmed = await ctx.ui.confirm(
        `Remove provider "${name}"?`,
        "Its provider configuration will be deleted."
      );
      if (!confirmed) return;

      pi.unregisterProvider(name);
      await updateConfig((next) => {
        if (!next.providers[name]) return false;
        delete next.providers[name];
        return true;
      });
      registered.delete(name);
      ctx.ui.notify(`Provider "${name}" removed.`, "info");
    },
  });

  pi.registerCommand("cch-provider-list", {
    description: "List configured Claude Code Hub providers",
    handler: async (_args, ctx) => {
      const current = readConfig();
      const names = Object.keys(current.providers);
      if (names.length === 0) {
        ctx.ui.notify("No providers configured. Run /cch-provider-add.", "info");
        return;
      }

      const lines = names.map((name) => {
        const entry = current.providers[name];
        const auth = ctx.modelRegistry.getProviderAuthStatus(name);
        const overrideCount = Object.keys(entry.modelOverrides).length;
        return (
          `${name} | ${entry.baseUrl} | auth: ${auth.configured ? "yes" : "no"} | ` +
          `overrides: ${overrideCount} | ${registered.has(name) ? "active" : "inactive"}`
        );
      });
      ctx.ui.notify(`Claude Code Hub providers (${names.length}):\n${lines.join("\n")}`, "info");
    },
  });
}
