// Layer C harness: load extension against the pi-coding-agent 0.83.0 API,
// verify the new commands are registered and the non-TUI fallback editor works.
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const agentDir = join(process.cwd(), "agentdir3");
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(join(agentDir, "extensions"), { recursive: true });
writeFileSync(
  join(agentDir, "extensions", "provider-claude-code-hub.json"),
  JSON.stringify({
    providers: {
      MyCCH: {
        baseUrl: "https://hub.example.com",
        modelOverrides: { "claude-*": { maxTokens: 32_000 } },
      },
    },
    settings: {},
  })
);

const { default: claudeCodeHubExtension } = await import("./index.ts");

const commands = new Map();
const registeredProviders = [];
const setModelCalls = [];
const pi = {
  registerProvider(name, config) {
    registeredProviders.push({ name, config });
  },
  unregisterProvider() {},
  setModel(model) {
    setModelCalls.push(model);
    return Promise.resolve(true);
  },
  registerCommand(name, def) {
    commands.set(name, def);
  },
};

await claudeCodeHubExtension(pi);

const expected = ["cch-provider-add", "cch-provider-remove", "cch-provider-list", "cch-provider-models", "cch-model-override"];
for (const name of expected) {
  if (!commands.has(name)) throw new Error(`missing command: ${name}`);
}
console.log("commands registered:", [...commands.keys()].join(", "));
console.log("provider registrations:", registeredProviders.length);

const refreshLog: string[] = [];
// Non-TUI fallback: mode "print", hasUI false.
const ctx = {
  mode: "print",
  hasUI: false,
  cwd: process.cwd(),
  signal: new AbortController().signal,
  // The active session model (what the user is currently chatting with).
  model: {
    id: "claude-opus-4",
    provider: "MyCCH",
    name: "Claude Opus 4",
    api: "anthropic-messages",
    baseUrl: "https://hub.example.com",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  },
  modelRegistry: {
    refresh: (options) => {
      refreshLog.push(`refresh:${options?.providers?.join(",") ?? "all"}:${options?.allowNetwork ? "net" : "nostore"}`);
      return Promise.resolve({ aborted: false, errors: new Map() });
    },
    getProvider(name) {
      if (name === "MyCCH") {
        return {
          getModels: function () {
            return [
              {
                id: "claude-sonnet-5",
                name: "Claude Sonnet 5",
                api: "anthropic-messages",
                baseUrl: "https://hub.example.com",
                reasoning: true,
                input: ["text", "image"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 256_000,
                maxTokens: 64_000,
              },
              {
                id: "claude-opus-4",
                name: "Claude Opus 4",
                api: "anthropic-messages",
                baseUrl: "https://hub.example.com",
                provider: "MyCCH",
                reasoning: true,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 256_000,
                maxTokens: 16_384,
              },
            ];
          },
          getProviderAuthStatus: () => ({ configured: true }),
        };
      }
      return undefined;
    },
  },
  ui: {
    input: async (title, placeholder) => {
      if (title.startsWith("Name")) return ""; // keep: empty means skip
      if (title.startsWith("Context window")) return "256000";
      if (title.startsWith("Max tokens")) return "";
      if (title.startsWith("Reasoning")) return "true";
      if (title.startsWith("Input")) return ""; // keep
      return "";
    },
    select: async () => "claude-opus-4",
    editor: async () => "{}",
    confirm: async () => true,
    notify: (msg, type) => console.log(`  [${type}] ${msg}`),
  },
};

// cch-provider-models in print mode -> notify fallback
await commands.get("cch-provider-models").handler("MyCCH", ctx);
console.log("provider-models fallback OK");

// cch-model-override in print mode -> sequential input fallback, saves config
await commands.get("cch-model-override").handler("MyCCH claude-opus-4", ctx);

const saved = JSON.parse(
  (await import("node:fs")).readFileSync(
    join(agentDir, "extensions", "provider-claude-code-hub.json"),
    "utf8"
  )
);
const override = saved.providers.MyCCH.modelOverrides["claude-opus-4"];
console.log("saved override:", JSON.stringify(override));
console.log("refresh calls:", JSON.stringify(refreshLog));
console.log("setModel calls:", setModelCalls.map((m) => `${m.id} ctx=${m.contextWindow} r=${m.reasoning}`).join(" | "));
if (!refreshLog.some((r) => r.startsWith("refresh"))) throw new Error("persistOverride did not trigger modelRegistry.refresh");
if (override?.contextWindow !== 256000 || override?.reasoning !== true || override?.maxTokens !== undefined) {
  throw new Error("fallback editor did not persist expected override");
}
// pattern rule still intact
if (saved.providers.MyCCH.modelOverrides["claude-*"]?.maxTokens !== 32_000) {
  throw new Error("existing pattern override lost");
}
// The active session model must be re-asserted via pi.setModel so the
// current session picks up the new parameters immediately.
if (setModelCalls.length !== 1) {
  throw new Error(`expected 1 setModel call for active session model, got ${setModelCalls.length}`);
}
const reModel = setModelCalls[0];
if (reModel.id !== "claude-opus-4" || reModel.provider !== "MyCCH") {
  throw new Error("setModel got the wrong model");
}
if (reModel.contextWindow !== 256000 || reModel.reasoning !== true) {
  throw new Error("setModel model does not carry the refreshed parameters");
}
console.log("LAYER C HARNESS OK");

rmSync(agentDir, { recursive: true, force: true });

