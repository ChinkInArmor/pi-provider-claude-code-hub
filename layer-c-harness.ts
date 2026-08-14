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
const pi = {
  registerProvider(name, config) {
    registeredProviders.push({ name, config });
  },
  unregisterProvider() {},
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

// Non-TUI fallback: mode "print", hasUI false.
const ctx = {
  mode: "print",
  hasUI: false,
  cwd: process.cwd(),
  signal: new AbortController().signal,
  modelRegistry: {
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
                contextWindow: 200_000,
                maxTokens: 64_000,
              },
              {
                id: "claude-opus-4",
                name: "Claude Opus 4",
                api: "anthropic-messages",
                baseUrl: "https://hub.example.com",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128_000,
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
if (override?.contextWindow !== 256000 || override?.reasoning !== true || override?.maxTokens !== undefined) {
  throw new Error("fallback editor did not persist expected override");
}
// pattern rule still intact
if (saved.providers.MyCCH.modelOverrides["claude-*"]?.maxTokens !== 32_000) {
  throw new Error("existing pattern override lost");
}
console.log("LAYER C HARNESS OK");

rmSync(agentDir, { recursive: true, force: true });
