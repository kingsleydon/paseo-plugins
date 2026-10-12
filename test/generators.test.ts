import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  claudeArgs,
  codexArgs,
  describeModelPlan,
  GeneratorUnavailableError,
  MAX_CONCURRENT_GENERATIONS,
  NoGeneratorError,
  opencodeArgs,
  parseClaudeResult,
  parseOpencodeEvents,
  RecapGenerator,
  resolveCandidates,
  runProcess,
  sanitizeEnv,
  type RunProcess,
} from "../server/generators";

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

describe("CLI arguments", () => {
  it("keeps Codex hooks and notifications out of background recaps", () => {
    const args = codexArgs("gpt-6-luna", "/s.json", "/o.json");
    expect(args).toEqual(expect.arrayContaining(["--ephemeral", "--disable", "hooks", "notify=[]"]));
    expect(args.at(-1)).toBe("-");
  });

  it("runs OpenCode with a read-only agent in the temp directory", () => {
    expect(opencodeArgs("p/m", "/tmp/x")).toEqual([
      "run", "--pure", "--format", "json", "--agent", "plan", "--dir", "/tmp/x", "--model", "p/m",
    ]);
  });

  it("disables Claude tools, persistence, settings, and thinking", () => {
    const args = claudeArgs("haiku");
    expect(args).toEqual(expect.arrayContaining(["--no-session-persistence", "--strict-mcp-config"]));
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(JSON.parse(args[args.indexOf("--settings") + 1] ?? "{}")).toEqual({ alwaysThinkingEnabled: false });
  });
});

describe("parseOpencodeEvents", () => {
  const line = (event: object) => JSON.stringify({ timestamp: 1, sessionID: "ses_1", ...event });

  it("joins final text parts and keeps the session id", () => {
    const stdout = [
      line({ type: "step_start", part: {} }),
      line({ type: "text", part: { text: '{"summary":"Done.",' } }),
      line({ type: "text", part: { text: '"next_action":null}' } }),
      "not json",
    ].join("\n");
    expect(parseOpencodeEvents({ code: 0, stdout, stderr: "" })).toEqual({
      sessionId: "ses_1",
      recap: { summary: "Done.", nextAction: null },
      error: null,
    });
  });

  it("reports error events but still returns the session id for cleanup", () => {
    const stdout = line({ type: "error", error: { name: "ProviderAuthError" } });
    const outcome = parseOpencodeEvents({ code: 0, stdout, stderr: "" });
    expect(outcome.sessionId).toBe("ses_1");
    expect(outcome.error).toBeInstanceOf(Error);
  });
});

describe("parseClaudeResult", () => {
  it("reads structured_output from the JSON envelope", () => {
    const stdout = JSON.stringify({
      is_error: false,
      result: "ignored",
      structured_output: { summary: "Fixed login.", next_action: null },
    });
    expect(parseClaudeResult({ code: 0, stdout, stderr: "" })).toEqual({
      summary: "Fixed login.",
      nextAction: null,
    });
  });

  it("classifies rate limits as unavailable so the next provider is tried", () => {
    const stdout = JSON.stringify({ is_error: true, result: "API Error: 429 rate_limit_error" });
    expect(() => parseClaudeResult({ code: 1, stdout, stderr: "" })).toThrow(GeneratorUnavailableError);
  });

  it("classifies auth failures as unavailable", () => {
    const stdout = JSON.stringify({ is_error: true, result: "Not logged in · Please run /login" });
    expect(() => parseClaudeResult({ code: 1, stdout, stderr: "" })).toThrow(GeneratorUnavailableError);
  });
});

describe("RecapGenerator", () => {
  it("falls back to the next candidate and cools down unavailable ones", async () => {
    const calls: string[] = [];
    const fake: RunProcess = async (command) => {
      calls.push(command);
      if (command === "claude") throw new GeneratorUnavailableError("claude not found");
      return { code: 0, stdout: "", stderr: "" };
    };
    const generator = new RecapGenerator({
      runProcess: fake,
      env: {},
      tempRoot: tmpdir(),
      now: () => 0,
      log: () => undefined,
    });
    const candidates = resolveCandidates({ provider: "claude" }, {});
    // Only unavailable CLIs ran: the user has to fix their setup.
    await expect(generator.generate("p", candidates, new AbortController().signal)).rejects.toBeInstanceOf(
      NoGeneratorError,
    );
    // The cooled-down CLI is not spawned again.
    await expect(generator.generate("p", candidates, new AbortController().signal)).rejects.toBeInstanceOf(
      NoGeneratorError,
    );
    expect(calls).toEqual(["claude"]);
  });
});

describe("RecapGenerator queue and cleanup", () => {
  const deps = (runProcess: RunProcess) => ({
    runProcess,
    env: {},
    tempRoot: tmpdir(),
    now: () => 0,
    log: () => undefined,
  });
  const ok = JSON.stringify({ structured_output: { summary: "S", next_action: null } });

  it("runs at most MAX_CONCURRENT_GENERATIONS CLIs at once", async () => {
    let running = 0;
    let peak = 0;
    const fake: RunProcess = async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 20));
      running--;
      return { code: 0, stdout: ok, stderr: "" };
    };
    const generator = new RecapGenerator(deps(fake));
    const candidates = resolveCandidates({ provider: "claude" }, {});
    await Promise.all(
      Array.from({ length: 5 }, () => generator.generate("p", candidates, new AbortController().signal)),
    );
    expect(peak).toBe(MAX_CONCURRENT_GENERATIONS);
  });

  it("leaves the queue when aborted while waiting", async () => {
    const releases: Array<() => void> = [];
    const fake: RunProcess = () =>
      new Promise((resolve) => {
        releases.push(() => resolve({ code: 0, stdout: ok, stderr: "" }));
      });
    const generator = new RecapGenerator(deps(fake));
    const candidates = resolveCandidates({ provider: "claude" }, {});
    const busy = Array.from({ length: MAX_CONCURRENT_GENERATIONS }, () =>
      generator.generate("p", candidates, new AbortController().signal),
    );
    const abort = new AbortController();
    const queued = generator.generate("p", candidates, abort.signal);
    abort.abort();
    await expect(queued).rejects.toThrow("aborted");
    await new Promise((resolve) => setTimeout(resolve, 10));
    for (const release of releases) release();
    await Promise.all(busy);
    // Only the slot holders ever ran; the aborted waiter never reached the CLI.
    expect(releases).toHaveLength(MAX_CONCURRENT_GENERATIONS);
  });

  it("deletes the OpenCode session after a run, even when the output is invalid", async () => {
    const calls: string[][] = [];
    const fake: RunProcess = async (_command, args) => {
      calls.push([...args]);
      if (args[0] === "session") return { code: 0, stdout: "", stderr: "" };
      const stdout = JSON.stringify({ type: "text", sessionID: "ses_9", part: { text: "not json" } });
      return { code: 0, stdout, stderr: "" };
    };
    const generator = new RecapGenerator(deps(fake));
    await expect(
      generator.generate("p", resolveCandidates({ provider: "opencode" }, {}), new AbortController().signal),
    ).rejects.toThrow("invalid recap");
    expect(calls.at(-1)).toEqual(["session", "delete", "ses_9"]);
  });
});

describe("runProcess", () => {
  it("pipes stdin and collects stdout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "recap-test-"));
    const script = join(dir, "echo.sh");
    await writeFile(script, "#!/bin/sh\ncat\n");
    await chmod(script, 0o755);
    const result = await runProcess(script, [], {
      stdin: "hello",
      cwd: dir,
      env: process.env,
      signal: new AbortController().signal,
      timeoutMs: 5_000,
    });
    expect(result).toEqual({ code: 0, stdout: "hello", stderr: "" });
  });

  it("kills the process on abort", async () => {
    const dir = await mkdtemp(join(tmpdir(), "recap-test-"));
    const script = join(dir, "sleep.sh");
    await writeFile(script, "#!/bin/sh\nsleep 30\n");
    await chmod(script, 0o755);
    const abort = new AbortController();
    const pending = runProcess(script, [], {
      stdin: "",
      cwd: dir,
      env: process.env,
      signal: abort.signal,
      timeoutMs: 5_000,
    });
    setTimeout(() => abort.abort(), 50);
    await expect(pending).rejects.toThrow("aborted");
  });

  it("reports a missing executable as unavailable", async () => {
    await expect(
      runProcess("/nonexistent/recap-cli", [], {
        stdin: "",
        cwd: tmpdir(),
        env: process.env,
        signal: new AbortController().signal,
        timeoutMs: 5_000,
      }),
    ).rejects.toBeInstanceOf(GeneratorUnavailableError);
  });
});

describe("sanitizeEnv", () => {
  it("removes nested-session markers only", () => {
    expect(sanitizeEnv({ CLAUDECODE: "1", PATH: "/bin", ANTHROPIC_API_KEY: "k" })).toEqual({
      PATH: "/bin",
      ANTHROPIC_API_KEY: "k",
    });
  });
});
