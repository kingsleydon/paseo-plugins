import { describe, expect, it } from "vitest";
import { describeModelPlan, resolveCandidates, type GeneratorInputs } from "../server/models";

const model = (id: string, label = id, isDefault = false) => ({ id, label, isDefault });

/** Shaped like a real snapshot: Claude has Haiku, Codex has no model from Paseo's small list. */
const providers: GeneratorInputs["providers"] = [
  { provider: "claude", enabled: true, models: [model("claude-opus-5-5", "Opus 5.5", true), model("claude-haiku-4-5", "Haiku 4.5")] },
  { provider: "codex", enabled: true, models: [model("gpt-6.1-sol", "GPT-6.1-Sol", true), model("gpt-6-luna", "GPT-6-Luna")] },
  { provider: "opencode", enabled: true, models: [model("openrouter/minimax/minimax-m3", "MiniMax M3")] },
  { provider: "pi", enabled: false, models: [model("pi-mini")] },
];
const inputs = (config: GeneratorInputs["config"] = {}, list = providers): GeneratorInputs => ({ config, providers: list });
const refs = (candidates: ReturnType<typeof resolveCandidates>) => candidates.map((c) => [c.provider, c.model]);

describe("resolveCandidates", () => {
  it("follows Paseo's metadata order: configured models, then installed small models in Paseo's order", () => {
    const config = { metadataGeneration: { providers: [{ provider: "codex" }, { provider: "claude", model: "sonnet" }] } };
    expect(refs(resolveCandidates("metadata", inputs(config)))).toEqual([
      ["codex", "gpt-6.1-sol"],
      ["claude", "sonnet"],
      ["claude", "claude-haiku-4-5"],
      ["opencode", "openrouter/minimax/minimax-m3"],
    ]);
  });

  it("puts the agent's provider first only when it has a small model, never its large model", () => {
    expect(refs(resolveCandidates("auto", inputs(), "claude"))[0]).toEqual(["claude", "claude-haiku-4-5"]);
    expect(refs(resolveCandidates("auto", inputs(), "codex"))).toEqual(refs(resolveCandidates("metadata", inputs())));
  });

  it("skips disabled providers and ones it cannot run, and keeps configured CLI commands", () => {
    const config = {
      metadataGeneration: { providers: [{ provider: "pi" }, { provider: "omp" }] },
      providers: { claude: { command: ["/opt/claude", "--flag"] } },
    };
    expect(resolveCandidates("metadata", inputs(config))[0]).toEqual({
      provider: "claude",
      model: "claude-haiku-4-5",
      command: ["/opt/claude", "--flag"],
    });
  });

  it("uses an explicit provider's model, else its small model, else the CLI default", () => {
    expect(refs(resolveCandidates({ provider: "codex", model: "gpt-6-luna" }, inputs()))).toEqual([["codex", "gpt-6-luna"]]);
    expect(refs(resolveCandidates({ provider: "claude" }, inputs()))).toEqual([["claude", "claude-haiku-4-5"]]);
    expect(refs(resolveCandidates({ provider: "codex" }, inputs()))).toEqual([["codex", null]]);
  });
});

describe("describeModelPlan", () => {
  it("lists each provider's first choice and the shared fallback order", () => {
    expect(describeModelPlan("auto", inputs())).toEqual({
      perProvider: [
        { provider: "claude", model: "claude-haiku-4-5" },
        { provider: "opencode", model: "openrouter/minimax/minimax-m3" },
      ],
      fallback: [
        { provider: "claude", model: "claude-haiku-4-5" },
        { provider: "opencode", model: "openrouter/minimax/minimax-m3" },
      ],
    });
    expect(describeModelPlan({ provider: "claude", model: "sonnet" }, inputs())).toEqual({
      perProvider: [],
      fallback: [{ provider: "claude", model: "sonnet" }],
    });
  });
});
