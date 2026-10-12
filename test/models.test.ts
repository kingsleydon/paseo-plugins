import { describe, expect, it } from "vitest";
import { describeModelPlan, resolveCandidates } from "../server/models";

describe("resolveCandidates", () => {
  const config = {
    metadataGeneration: {
      providers: [
        { provider: "pi" },
        { provider: "codex", model: "gpt-5.5" },
        { provider: "claude", model: "haiku" },
      ],
    },
    providers: { claude: { command: ["/opt/claude", "--flag"] } },
  };
  const summarize = (candidates: ReturnType<typeof resolveCandidates>) =>
    candidates.map((c) => [c.provider, c.model, c.command]);

  it("puts the agent's own provider first, then metadata order and defaults", () => {
    expect(summarize(resolveCandidates("auto", config, "codex"))).toEqual([
      ["codex", "gpt-6-luna", ["codex"]],
      ["codex", "gpt-5.5", ["codex"]],
      ["claude", "haiku", ["/opt/claude", "--flag"]],
    ]);
    expect(summarize(resolveCandidates("auto", {}, "opencode"))[0]).toEqual(["opencode", null, ["opencode"]]);
  });

  it("describes the models each setting resolves to", () => {
    expect(describeModelPlan("auto", config)).toEqual({
      perProvider: [
        { provider: "claude", model: "haiku" },
        { provider: "codex", model: "gpt-6-luna" },
        { provider: "opencode", model: null },
      ],
      fallback: [
        { provider: "codex", model: "gpt-5.5" },
        { provider: "claude", model: "haiku" },
        { provider: "codex", model: "gpt-6-luna" },
      ],
    });
    expect(describeModelPlan({ provider: "claude", model: "sonnet" }, config)).toEqual({
      perProvider: [],
      fallback: [{ provider: "claude", model: "sonnet" }],
    });
  });

  it("falls back to metadata order for unsupported agent providers", () => {
    expect(summarize(resolveCandidates("auto", config, "omp"))).toEqual(
      summarize(resolveCandidates("metadata", config)),
    );
  });

  it("uses metadata order only in metadata mode, skipping unsupported providers", () => {
    expect(summarize(resolveCandidates("metadata", config, "codex"))).toEqual([
      ["codex", "gpt-5.5", ["codex"]],
      ["claude", "haiku", ["/opt/claude", "--flag"]],
      ["codex", "gpt-6-luna", ["codex"]],
    ]);
  });

  it("drops disabled providers and honors an explicit choice", () => {
    expect(resolveCandidates("auto", { providers: { claude: { enabled: false } } })).toEqual([
      { provider: "codex", model: "gpt-6-luna", command: ["codex"] },
    ]);
    expect(resolveCandidates({ provider: "claude" }, {}, "codex")).toEqual([
      { provider: "claude", model: null, command: ["claude"] },
    ]);
  });
});
