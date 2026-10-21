import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { GeneratorUnavailableError, NoGeneratorError } from "../server/errors";
import { MAX_CONCURRENT_GENERATIONS, RecapGenerator } from "../server/generators";
import { resolveCandidates, type GeneratorCandidate } from "../server/models";
import type { RunProcess } from "../server/process";

const NO_PROVIDERS = { config: {}, providers: [] };

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
    const candidates = resolveCandidates({ provider: "claude" }, NO_PROVIDERS);
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
    const candidates = resolveCandidates({ provider: "claude" }, NO_PROVIDERS);
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
    const candidates = resolveCandidates({ provider: "claude" }, NO_PROVIDERS);
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

  it.each([null, 1, 2])("deletes the OpenCode %s session even when the output is invalid", async (major) => {
    const calls: string[][] = [];
    const fake: RunProcess = async (_command, args) => {
      calls.push([...args]);
      if (args[0] === "--version") return { code: 0, stdout: major === null ? "unknown" : `${major}.0.0`, stderr: "" };
      if (args[0] === "session") return { code: 0, stdout: "", stderr: "" };
      const stdout = JSON.stringify({ type: "text", sessionID: "ses_9", part: { text: "not json" } });
      return { code: 0, stdout, stderr: "" };
    };
    const generator = new RecapGenerator(deps(fake));
    await expect(
      generator.generate("p", resolveCandidates({ provider: "opencode" }, NO_PROVIDERS), new AbortController().signal),
    ).rejects.toThrow("invalid recap");
    expect(calls.at(-1)).toEqual(["session", "delete", ...(major === 2 ? ["--standalone"] : []), "ses_9"]);
  });

  it.each([1, 2])("detects the opencode %i.x CLI once and uses its run and cleanup flags", async (major) => {
    const calls: string[][] = [];
    const recap = JSON.stringify({ summary: "S.", next_action: null });
    const fake: RunProcess = async (_command, args) => {
      calls.push([...args]);
      if (args[0] === "--version") return { code: 0, stdout: `opencode v${major}.0.32`, stderr: "" };
      if (args[0] === "session") return { code: 0, stdout: "", stderr: "" };
      const stdout = JSON.stringify({ type: "text", sessionID: "ses_2", part: { text: recap } });
      return { code: 0, stdout, stderr: "" };
    };
    const generator = new RecapGenerator(deps(fake));
    const candidates = resolveCandidates({ provider: "opencode" }, NO_PROVIDERS);
    for (let run = 0; run < 2; run++) {
      const generated = await generator.generate("p", candidates, new AbortController().signal);
      expect(generated).toMatchObject({ summary: "S.", nextAction: null, provider: "opencode" });
    }
    const runArgs = [
      "run", major === 1 ? "--pure" : "--standalone", "--format", "json", "--agent", "plan",
      ...(major === 1 ? ["--dir", expect.any(String)] : []),
    ];
    const deleteArgs = ["session", "delete", ...(major === 2 ? ["--standalone"] : []), "ses_2"];
    expect(calls).toEqual([["--version"], runArgs, deleteArgs, runArgs, deleteArgs]);
  });

  it.each([
    { code: 1, stdout: "opencode v2.0.32", stderr: "version failed" },
    { code: 0, stdout: "unknown", stderr: "" },
  ])("retries an unsuccessful opencode version probe: %j", async (failedVersion) => {
    let probes = 0;
    const calls: string[][] = [];
    const recap = JSON.stringify({ summary: "S.", next_action: null });
    const fake: RunProcess = async (_command, args) => {
      calls.push([...args]);
      if (args[0] === "--version") {
        probes++;
        return probes === 1 ? failedVersion : { code: 0, stdout: "opencode v2.0.32", stderr: "" };
      }
      if (args[0] === "session") return { code: 0, stdout: "", stderr: "" };
      const stdout = JSON.stringify({ type: "text", sessionID: "ses_2", part: { text: recap } });
      return { code: 0, stdout, stderr: "" };
    };
    const generator = new RecapGenerator(deps(fake));
    const candidates = resolveCandidates({ provider: "opencode" }, NO_PROVIDERS);
    for (let run = 0; run < 3; run++) {
      await generator.generate("p", candidates, new AbortController().signal);
    }
    expect(probes).toBe(2);
    expect(calls.filter((args) => args[0] === "run")).toEqual([
      ["run", "--pure", "--format", "json", "--agent", "plan", "--dir", expect.any(String)],
      ["run", "--standalone", "--format", "json", "--agent", "plan"],
      ["run", "--standalone", "--format", "json", "--agent", "plan"],
    ]);
    expect(calls.filter((args) => args[0] === "session")).toEqual([
      ["session", "delete", "ses_2"],
      ["session", "delete", "--standalone", "ses_2"],
      ["session", "delete", "--standalone", "ses_2"],
    ]);
  });

  it("caches opencode versions separately for commands with different leading arguments", async () => {
    const calls: string[][] = [];
    const recap = JSON.stringify({ summary: "S.", next_action: null });
    const fake: RunProcess = async (_command, args) => {
      calls.push([...args]);
      if (args[1] === "--version") {
        return { code: 0, stdout: args[0] === "opencode-1" ? "1.19.3" : "2.1.1", stderr: "" };
      }
      if (args[1] === "session") return { code: 0, stdout: "", stderr: "" };
      const stdout = JSON.stringify({ type: "text", sessionID: "ses_2", part: { text: recap } });
      return { code: 0, stdout, stderr: "" };
    };
    const generator = new RecapGenerator(deps(fake));
    const candidates: GeneratorCandidate[] = [
      { provider: "opencode", model: null, command: ["launcher", "opencode-1"] },
      { provider: "opencode", model: null, command: ["launcher", "opencode-2"] },
    ];
    for (const candidate of [...candidates, ...candidates]) {
      await generator.generate("p", [candidate], new AbortController().signal);
    }
    expect(calls.filter((args) => args[1] === "--version")).toEqual([
      ["opencode-1", "--version"],
      ["opencode-2", "--version"],
    ]);
    const runArgs = [
      ["opencode-1", "run", "--pure", "--format", "json", "--agent", "plan", "--dir", expect.any(String)],
      ["opencode-2", "run", "--standalone", "--format", "json", "--agent", "plan"],
    ];
    expect(calls.filter((args) => args[1] === "run")).toEqual([...runArgs, ...runArgs]);
    const deleteArgs = [
      ["opencode-1", "session", "delete", "ses_2"],
      ["opencode-2", "session", "delete", "--standalone", "ses_2"],
    ];
    expect(calls.filter((args) => args[1] === "session")).toEqual([...deleteArgs, ...deleteArgs]);
  });
});
