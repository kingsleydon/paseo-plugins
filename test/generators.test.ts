import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { GeneratorUnavailableError, NoGeneratorError } from "../server/errors";
import { MAX_CONCURRENT_GENERATIONS, RecapGenerator } from "../server/generators";
import { resolveCandidates } from "../server/models";
import type { RunProcess } from "../server/process";

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
