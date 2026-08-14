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
  getSelectListTheme,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
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

/**
 * A model-override key may be an exact model ID or a glob pattern.
 * Supported wildcards: `*` (any run of characters) and `?` (exactly one).
 * Keys are matched against raw model IDs (patterns are case-sensitive).
 */
export function matchModelPattern(pattern: string, id: string): boolean {
  if (!pattern) return false;
  if (pattern === "*") return true;
  if (!pattern.includes("*") && !pattern.includes("?")) return pattern === id;
  const expression = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${expression}$`).test(id);
}

/**
 * Override-key priority score: fewer wildcards first, then longer literal
 * prefix (more specific). Lower score wins. `*` alone scores highest of all
 * single-wildcard patterns, making it the global fallback.
 */
export function patternSpecificity(pattern: string): number {
  let wildcardCount = 0;
  let literalLength = 0;
  for (const char of pattern) {
    if (char === "*" || char === "?") wildcardCount++;
    else literalLength++;
  }
  return wildcardCount * 10_000 - literalLength;
}

/**
 * Resolve the override that applies to a model ID.
 * Priority: exact ID > pattern with fewer wildcards > global `*`.
 * Ties are broken by declaration order (earlier entry wins).
 */
export function resolveModelOverride(
  overrides: Record<string, CCHModelOverride> | undefined,
  id: string
): CCHModelOverride | undefined {
  if (!overrides) return undefined;
  const key = findAppliedOverrideKey(overrides, id);
  return key ? overrides[key] : undefined;
}

/**
 * The override key (exact ID or pattern) that wins for a model ID, using the
 * same priority rules as resolveModelOverride. Returns undefined when no rule
 * matches.
 */
export function findAppliedOverrideKey(
  overrides: Record<string, CCHModelOverride> | undefined,
  id: string
): string | undefined {
  if (!overrides) return undefined;
  let best: { key: string; specificity: number } | undefined;
  for (const key of Object.keys(overrides)) {
    if (!matchModelPattern(key, id)) continue;
    const specificity = patternSpecificity(key);
    if (!best || specificity < best.specificity) {
      best = { key, specificity };
    }
  }
  return best?.key;
}

/**
 * Fields that can be overridden, with per-field kind for form/table rendering.
 * Advanced fields are edited as validated JSON text.
 */
export const OVERRIDE_FIELDS = [
  "name",
  "contextWindow",
  "maxTokens",
  "reasoning",
  "input",
  "thinkingLevelMap",
  "cost",
  "compat",
] as const;

export type OverrideField = (typeof OVERRIDE_FIELDS)[number];

export const OVERRIDE_FIELD_LABELS: Record<OverrideField, string> = {
  name: "Name",
  contextWindow: "Context window",
  maxTokens: "Max tokens",
  reasoning: "Reasoning",
  input: "Input types",
  thinkingLevelMap: "Thinking level map",
  cost: "Cost",
  compat: "Compat",
};

/** Whether a field is part of the compact basic form vs the collapsed advanced JSON section. */
export function isBasicField(field: OverrideField): boolean {
  return field === "name" || field === "contextWindow" || field === "maxTokens" || field === "reasoning" || field === "input";
}

/** Human-readable current value of a field in an override. */
export function formatOverrideValue(field: OverrideField, override: CCHModelOverride): string {
  const value = override[field];
  if (value === undefined) return "(unset)";
  switch (field) {
    case "name":
      return String(value);
    case "contextWindow":
    case "maxTokens":
      return String(value);
    case "reasoning":
      return value ? "on" : "off";
    case "input":
      return (value as string[]).join(", ");
    case "thinkingLevelMap":
      return JSON.stringify(value);
    case "cost":
      return JSON.stringify(value);
    case "compat":
      return JSON.stringify(value);
  }
}

/**
 * Which layer contributed each effective field of a final model config.
 * Used by the overview table to annotate values that differ from the catalog.
 * When `catalog` is unavailable (registry models are already merged), only
 * override-applied fields are annotated.
 */
export function annotateModelSources(params: {
  model: ProviderModelConfig;
  catalog?: Model<Api>;
  override?: CCHModelOverride;
}): Partial<Record<OverrideField, "catalog" | "override" | "default">> {
  const { model, catalog, override } = params;
  const sources: Partial<Record<OverrideField, "catalog" | "override" | "default">> = {};

  if (!catalog) {
    for (const field of OVERRIDE_FIELDS) {
      if (override && override[field] !== undefined) sources[field] = "override";
    }
    return sources;
  }

  const annotate = (
    field: OverrideField,
    effective: unknown,
    catalogValue: unknown,
    defaultValue: unknown
  ) => {
    if (override && override[field] !== undefined) {
      sources[field] = "override";
    } else if (catalog && catalogValue !== undefined && !deepEqual(effective, catalogValue)) {
      sources[field] = "catalog";
    } else if (!deepEqual(effective, defaultValue)) {
      sources[field] = "default";
    }
  };

  annotate("name", model.name, catalog?.name, model.id);
  annotate("contextWindow", model.contextWindow, catalog?.contextWindow, 128_000);
  annotate("maxTokens", model.maxTokens, catalog?.maxTokens, 16_384);
  annotate("reasoning", model.reasoning, catalog?.reasoning, false);
  annotate("input", model.input, catalog?.input, ["text"]);
  annotate("thinkingLevelMap", model.thinkingLevelMap, catalog?.thinkingLevelMap, undefined);
  annotate("cost", model.cost, catalog?.cost, DEFAULT_COST);
  annotate("compat", model.compat, catalog?.compat, undefined);

  return sources;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== (b as unknown[]).length) return false;
    return a.every((item, index) => deepEqual(item, (b as unknown[])[index]));
  }
  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(
    (key) => deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])
  );
}

/** Build the effective ProviderModelConfig for one model with a given override + catalog. */
export function buildEffectiveModel(params: {
  baseUrl: string;
  entry: CCHModelEntry;
  override?: CCHModelOverride;
  catalog?: Model<Api>;
}): ProviderModelConfig {
  const { baseUrl, entry, override = {}, catalog } = params;
  const sourceCompat = catalog?.api === entry.api ? catalog.compat : undefined;
  const compat = sourceCompat || override.compat
    ? {
        ...(sourceCompat as Record<string, unknown> | undefined),
        ...(override.compat as Record<string, unknown> | undefined),
      }
    : undefined;
  return {
    id: entry.id,
    name: override.name ?? entry.displayName ?? catalog?.name ?? entry.id,
    api: entry.api,
    baseUrl: resolveApiBaseUrl(normalizeCCHBaseUrl(baseUrl), entry.api),
    reasoning: override.reasoning ?? catalog?.reasoning ?? false,
    thinkingLevelMap:
      override.thinkingLevelMap ?? (catalog?.thinkingLevelMap as ThinkingLevelMap | undefined),
    input: override.input ?? catalog?.input ?? ["text"],
    cost: mergeCost(catalog?.cost, override.cost),
    contextWindow: override.contextWindow ?? catalog?.contextWindow ?? 128_000,
    maxTokens: override.maxTokens ?? catalog?.maxTokens ?? 16_384,
    compat: compat as Model<Api>["compat"],
  };
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
    const override = resolveModelOverride(overrides, entry.id) ?? {};
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
      const override = resolveModelOverride(modelOverrides, model.id);
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

/* --------------------------------------------------------------------------
 * Layer C: interactive model override editing
 * -------------------------------------------------------------------------- */

/** Parse raw JSON text into a field value; returns error message on failure. */
export function parseOverrideJson(
  field: OverrideField,
  raw: string
): { value: unknown; error?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { value: undefined, error: `Invalid JSON for ${OVERRIDE_FIELD_LABELS[field]}.` };
  }
  switch (field) {
    case "reasoning":
      if (typeof parsed !== "boolean") {
        return { value: undefined, error: `${OVERRIDE_FIELD_LABELS[field]} must be true or false.` };
      }
      break;
    case "contextWindow":
    case "maxTokens":
      if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed <= 0) {
        return { value: undefined, error: `${OVERRIDE_FIELD_LABELS[field]} must be a positive number.` };
      }
      break;
    case "input": {
      const valid = Array.isArray(parsed) && parsed.every((v) => v === "text" || v === "image");
      if (!valid) {
        return { value: undefined, error: "Input types must be a JSON array of \"text\" and/or \"image\"." };
      }
      break;
    }
    default:
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {
          value: undefined,
          error: `${OVERRIDE_FIELD_LABELS[field]} must be a JSON object (or null to clear it).`,
        };
      }
  }
  return { value: parsed };
}

/** Serialize an override field for text editing. Empty string means "clear". */
export function serializeOverrideField(field: OverrideField, override: CCHModelOverride): string {
  const value = override[field];
  if (value === undefined) return "(unset)";
  switch (field) {
    case "name":
      return String(value);
    case "contextWindow":
    case "maxTokens":
      return String(value);
    case "reasoning":
      return value ? "true" : "false";
    case "input":
      return JSON.stringify(value);
    default:
      return JSON.stringify(value);
  }
}

/**
 * Apply a typed value to an override copy. Returns a new override object.
 * Passing undefined clears the field.
 */
export function setOverrideField(
  override: CCHModelOverride,
  field: OverrideField,
  value: unknown
): CCHModelOverride {
  const next = { ...override };
  if (value === undefined) {
    delete next[field];
    return next;
  }
  switch (field) {
    case "name":
      next.name = String(value);
      break;
    case "contextWindow":
      next.contextWindow = Number(value);
      break;
    case "maxTokens":
      next.maxTokens = Number(value);
      break;
    case "reasoning":
      next.reasoning = Boolean(value);
      break;
    case "input":
      next.input = value as ("text" | "image")[];
      break;
    case "thinkingLevelMap":
      next.thinkingLevelMap = value as CCHModelOverride["thinkingLevelMap"];
      break;
    case "cost":
      next.cost = value as CCHModelOverride["cost"];
      break;
    case "compat":
      next.compat = value as CCHModelOverride["compat"];
      break;
  }
  return next;
}

/** One row of the /cch-provider-models overview table. */
export interface ModelTableRow {
  id: string;
  api: CCHModelApi;
  /** Effective values. */
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: string[];
  /** Which layer produced each annotated field (only fields differing from catalog). */
  sources: Partial<Record<OverrideField, "catalog" | "override" | "default">>;
  /** The override key that applied (exact ID or pattern), if any. */
  appliedKey?: string;
}

/**
 * Build table rows for all currently known models of a provider.
 * `registryModels` are the live ProviderModelConfig[] from the model registry.
 */
export function buildModelTableRows(params: {
  registryModels: ProviderModelConfig[];
  modelOverrides: Record<string, CCHModelOverride>;
}): ModelTableRow[] {
  const { registryModels, modelOverrides } = params;

  const rows: ModelTableRow[] = registryModels.map((model) => {
    const override = resolveModelOverride(modelOverrides, model.id);
    const appliedKey = findAppliedOverrideKey(modelOverrides, model.id);
    return {
      id: model.id,
      api: (model.api as CCHModelApi) ?? "anthropic-messages",
      name: model.name,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      reasoning: model.reasoning,
      input: model.input as string[],
      sources: annotateModelSources({ model, override }),
      appliedKey,
    };
  });
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}

/** Render a table row's compact text line (used in the scrollable list). */
export function formatModelTableRow(
  row: ModelTableRow,
  showSources: boolean = true
): string {
  const overrideMark = row.appliedKey ? ` [${row.appliedKey}]` : "";
  const sourceMark =
    showSources && Object.keys(row.sources).length > 0
      ? ` (${Object.keys(row.sources).join(", ")})`
      : "";
  return (
    `${row.id}${overrideMark}${sourceMark} | ${row.api} | ctx ${row.contextWindow} | ` +
    `max ${row.maxTokens} | ${row.reasoning ? "reasoning" : "plain"} | ${row.input.join("+")} | ${row.name}`
  );
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

  pi.registerCommand("cch-provider-models", {
    description: "Show effective model parameters for a CCH provider (Enter: edit)",
    handler: async (args, ctx) => {
      const current = readConfig();
      const names = Object.keys(current.providers);
      if (names.length === 0) {
        ctx.ui.notify("No providers configured. Run /cch-provider-add.", "info");
        return;
      }

      let name = args.trim();
      if (!name) {
        const selected = await ctx.ui.select("Provider", names);
        if (selected === undefined) return;
        name = selected;
      }
      const entry = current.providers[name];
      if (!entry) {
        ctx.ui.notify(`Provider "${name}" is not configured.`, "error");
        return;
      }

      const provider = ctx.modelRegistry.getProvider(name);
      const registryModels = [...(provider?.getModels() ?? [])] as ProviderModelConfig[];
      if (registryModels.length === 0) {
        ctx.ui.notify(
          `Provider "${name}" has no models yet. Open /model or /login ${name} to refresh them first.`,
          "info"
        );
        return;
      }

      const rows = buildModelTableRows({
        registryModels,
        modelOverrides: entry.modelOverrides,
      });

      if (ctx.mode !== "tui" || !ctx.hasUI) {
        ctx.ui.notify(
          `CCH models for ${name} (${rows.length}):\n` +
            rows.map((row) => formatModelTableRow(row)).join("\n"),
          "info"
        );
        return;
      }

      const items: SelectItem[] = rows.map((row) => ({
        value: row.id,
        label: row.id,
        description: formatModelTableRow(row),
      }));

      const selectedId = await ctx.ui.custom<string | null>((_tui, theme, _kb, done) => {
        const container = new Container();
        container.addChild(
          new Text(theme.fg("accent", theme.bold(`CCH models for ${name} (${rows.length})`)), 1, 0)
        );
        const list = new SelectList(items, Math.min(items.length, 12), getSelectListTheme());
        list.onSelect = (item: SelectItem) => done(item.value);
        list.onCancel = () => done(null);
        container.addChild(list);
        container.addChild(
          new Text(theme.fg("dim", "type to filter • enter: edit model • esc: back"), 1, 0)
        );
        return {
          render: (w) => container.render(w),
          invalidate: () => container.invalidate(),
          handleInput: (data) => {
            list.handleInput(data);
          },
        };
      });

      if (selectedId !== null && selectedId !== undefined) {
        await runOverrideEditor(name, selectedId, ctx);
      }
    },
  });

  pi.registerCommand("cch-model-override", {
    description: "Edit model overrides for a CCH provider (model ID or pattern)",
    handler: async (args, ctx) => {
      const current = readConfig();
      const names = Object.keys(current.providers);
      if (names.length === 0) {
        ctx.ui.notify("No providers configured. Run /cch-provider-add.", "info");
        return;
      }

      const parts = args.trim().split(/\s+/).filter(Boolean);
      let name = parts[0] ?? "";
      let modelKey = parts.slice(1).join(" ") ?? "";
      if (!name) {
        const selected = await ctx.ui.select("Provider", names);
        if (selected === undefined) return;
        name = selected;
      }
      if (!current.providers[name]) {
        ctx.ui.notify(`Provider "${name}" is not configured.`, "error");
        return;
      }

      const provider = ctx.modelRegistry.getProvider(name);
      const registryModels = [...(provider?.getModels() ?? [])] as ProviderModelConfig[];
      if (!modelKey) {
        if (registryModels.length === 0) {
          ctx.ui.notify(
            `Provider "${name}" has no models yet; pass a model ID or pattern as the second argument.`,
            "info"
          );
          return;
        }
        const selected = await ctx.ui.select(
          "Model or pattern",
          registryModels.map((m) => m.id)
        );
        if (selected === undefined) return;
        modelKey = selected;
      }

      await runOverrideEditor(name, modelKey, ctx);
    },
  });
}

async function runOverrideEditor(
  providerName: string,
  modelKey: string,
  ctx: ExtensionCommandContext
): Promise<void> {
  const current = readConfig();
  const entry = current.providers[providerName];
  if (!entry) {
    ctx.ui.notify(`Provider "${providerName}" is not configured.`, "error");
    return;
  }

  const isPattern = modelKey.includes("*") || modelKey.includes("?");
  let override = { ...(entry.modelOverrides[modelKey] ?? {}) };

  if (ctx.mode !== "tui" || !ctx.hasUI) {
    // Fallback: prompt each basic field via input dialogs.
    const updated = await runOverrideEditorFallback(modelKey, override, ctx);
    if (updated === undefined) return;
    override = updated;
    await persistOverride(providerName, modelKey, override, ctx);
    return;
  }

  const result = await showOverrideForm({
    providerName,
    modelKey,
    isPattern,
    override,
    ctx,
  });
  if (!result) return;
  if (result.action === "clear") {
    await persistOverride(providerName, modelKey, {}, ctx);
    return;
  }
  await persistOverride(providerName, modelKey, result.override ?? {}, ctx);
}

async function runOverrideEditorFallback(
  modelKey: string,
  override: CCHModelOverride,
  ctx: ExtensionCommandContext
): Promise<CCHModelOverride | undefined> {
  for (const field of OVERRIDE_FIELDS) {
    if (!isBasicField(field)) continue;
    const currentValue = serializeOverrideField(field, override);
    const raw = await ctx.ui.input(
      `${OVERRIDE_FIELD_LABELS[field]} (${modelKey}) — empty to keep, "-" to clear`,
      currentValue
    );
    if (raw === undefined) return undefined;
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed === currentValue) continue;
    if (trimmed === "-") {
      override = setOverrideField(override, field, undefined);
      continue;
    }
    const parsed = parseOverrideFieldText(field, trimmed);
    if (parsed.error) {
      ctx.ui.notify(parsed.error, "error");
      return undefined;
    }
    override = setOverrideField(override, field, parsed.value);
  }
  return override;
}

function parseOverrideFieldText(
  field: OverrideField,
  text: string
): { value: unknown; error?: string } {
  switch (field) {
    case "name":
      return { value: text };
    case "contextWindow":
    case "maxTokens": {
      const number = Number(text);
      if (!Number.isFinite(number) || number <= 0) {
        return { value: undefined, error: `${OVERRIDE_FIELD_LABELS[field]} must be a positive number.` };
      }
      return { value: number };
    }
    case "reasoning":
      if (text === "true" || text === "on" || text === "1") return { value: true };
      if (text === "false" || text === "off" || text === "0") return { value: false };
      return { value: undefined, error: "Reasoning must be true, false, on or off." };
    case "input": {
      const values = text
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);
      if (!values.every((v) => v === "text" || v === "image")) {
        return { value: undefined, error: "Input types must be text and/or image (comma separated)." };
      }
      return { value: values };
    }
    default:
      return parseOverrideJson(field, text);
  }
}

async function persistOverride(
  providerName: string,
  modelKey: string,
  override: CCHModelOverride,
  ctx: ExtensionCommandContext
): Promise<void> {
  const isEmpty = Object.keys(override).length === 0;
  await updateConfig((next) => {
    const entry = next.providers[providerName];
    if (!entry) return false;
    if (isEmpty) {
      delete entry.modelOverrides[modelKey];
    } else {
      entry.modelOverrides[modelKey] = override;
    }
    return true;
  });
  ctx.ui.notify(
    isEmpty
      ? `Cleared override for ${modelKey} (${providerName}).`
      : `Saved override for ${modelKey} (${providerName}). Model list refreshes on next /model.`,
    "info"
  );
}

async function showOverrideForm(params: {
  providerName: string;
  modelKey: string;
  isPattern: boolean;
  override: CCHModelOverride;
  ctx: ExtensionCommandContext;
}): Promise<{ action: "save" | "clear" | "cancel"; override?: CCHModelOverride } | undefined> {
  const { providerName, modelKey, isPattern, ctx } = params;
  let override = { ...params.override };
  const basicFields = OVERRIDE_FIELDS.filter((field) => isBasicField(field));
  const advancedFields = OVERRIDE_FIELDS.filter((field) => !isBasicField(field));

  type FormResult =
    | { kind: "action"; action: "save" | "clear" | "cancel" }
    | { kind: "field"; field: OverrideField }
    | { kind: "advanced" };

  while (true) {
    const hasAdvancedValues = advancedFields.some((field) => override[field] !== undefined);
    const listItems: SelectItem[] = [
      ...basicFields.map((field) => ({
        value: `field:${field}`,
        label: OVERRIDE_FIELD_LABELS[field],
        description: serializeOverrideField(field, override),
      })),
      {
        value: "__advanced__",
        label: hasAdvancedValues ? "Advanced (edited)" : "Advanced",
        description: `cost, thinkingLevelMap, compat${hasAdvancedValues ? " — set" : ""}`,
      },
      { value: "__save__", label: "Save", description: "Write override to config" },
      { value: "__clear__", label: "Clear override", description: "Remove this entry" },
      { value: "__cancel__", label: "Cancel", description: "Discard changes" },
    ];

    const result = await ctx.ui.custom<FormResult | undefined>((_tui, theme, _kb, done) => {
      const container = new Container();
      container.addChild(
        new Text(
          theme.fg(
            "accent",
            theme.bold(
              `Override ${modelKey} (${providerName})${isPattern ? " [pattern]" : ""}`
            )
          ),
          1,
          0
        )
      );
      const list = new SelectList(
        listItems,
        Math.min(listItems.length, 14),
        getSelectListTheme()
      );
      list.onSelect = (item: SelectItem) => {
        if (item.value.startsWith("field:")) {
          done({ kind: "field", field: item.value.slice("field:".length) as OverrideField });
        } else if (item.value === "__advanced__") {
          done({ kind: "advanced" });
        } else if (item.value === "__save__") {
          done({ kind: "action", action: "save" });
        } else if (item.value === "__clear__") {
          done({ kind: "action", action: "clear" });
        } else {
          done({ kind: "action", action: "cancel" });
        }
      };
      list.onCancel = () => done({ kind: "action", action: "cancel" });
      container.addChild(list);
      container.addChild(
        new Text(theme.fg("dim", "↑↓ navigate • enter edit/save • esc cancel"), 1, 0)
      );
      return {
        render: (w) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (data) => {
          list.handleInput(data);
        },
      };
    });

    if (!result) return undefined; // cancelled at TUI level
    if (result.kind === "action") {
      if (result.action === "save") return { action: "save", override };
      if (result.action === "clear") return { action: "clear" };
      return { action: "cancel" };
    }

    // Pick the field to edit: advanced opens a sub-menu.
    let field: OverrideField;
    if (result.kind === "advanced") {
      const chosen = await ctx.ui.select(
        "Advanced field",
        advancedFields.map((f) => `${OVERRIDE_FIELD_LABELS[f]}: ${serializeOverrideField(f, override)}`)
      );
      if (chosen === undefined) continue;
      const index = advancedFields.findIndex((f) =>
        chosen.startsWith(OVERRIDE_FIELD_LABELS[f])
      );
      if (index === -1) continue;
      field = advancedFields[index];
    } else {
      field = result.field;
    }

    // Edit the field via a modal input/editor.
    const current = serializeOverrideField(field, override);
    const raw = isBasicField(field)
      ? await ctx.ui.input(`${OVERRIDE_FIELD_LABELS[field]} (${modelKey})`, current)
      : await ctx.ui.editor(
          `${OVERRIDE_FIELD_LABELS[field]} JSON (${modelKey}) — {} clears`,
          current === "(unset)" ? "{}" : current
        );
    if (raw === undefined) continue; // user escaped the edit
    const trimmed = raw.trim();
    if (trimmed === "" ) continue;
    if (trimmed === "-" || trimmed === "{}") {
      override = setOverrideField(override, field, undefined);
      continue;
    }
    const parsed = parseOverrideFieldText(field, trimmed);
    if (parsed.error) {
      ctx.ui.notify(parsed.error, "error");
      continue;
    }
    override = setOverrideField(override, field, parsed.value);
  }
}
