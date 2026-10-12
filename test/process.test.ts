import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GeneratorUnavailableError } from "../server/errors";
import { runProcess, sanitizeEnv } from "../server/process";

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
