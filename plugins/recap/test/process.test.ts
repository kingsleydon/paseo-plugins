import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { GeneratorUnavailableError } from "../server/errors";
import { runProcess, sanitizeEnv } from "../server/process";

describe("runProcess", () => {
  it("pipes stdin and collects stdout", async () => {
    const result = await runProcess(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], {
      stdin: "hello",
      cwd: tmpdir(),
      env: process.env,
      signal: new AbortController().signal,
      timeoutMs: 5_000,
    });
    expect(result).toEqual({ code: 0, stdout: "hello", stderr: "" });
  });

  it("kills the process on abort", async () => {
    const abort = new AbortController();
    const pending = runProcess(process.execPath, ["-e", "setTimeout(() => {}, 3000)"], {
      stdin: "",
      cwd: tmpdir(),
      env: process.env,
      signal: abort.signal,
      timeoutMs: 5_000,
    });
    setTimeout(() => abort.abort(), 50);
    await expect(pending).rejects.toThrow("aborted");
  });

  it("caps stdout and stderr independently in bytes", async () => {
    const limit = 1024 * 1024;
    const script = `const text = "é".repeat(${limit}); process.stdout.write(text); process.stderr.write(text);`;
    const result = await runProcess(process.execPath, ["-e", script], {
      stdin: "",
      cwd: tmpdir(),
      env: process.env,
      signal: new AbortController().signal,
      timeoutMs: 5_000,
    });
    expect(Buffer.byteLength(result.stdout)).toBe(limit);
    expect(Buffer.byteLength(result.stderr)).toBe(limit);
  });

  it.skipIf(process.platform === "win32")("terminates CLI descendants on timeout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "recap-process-"));
    try {
      const child = [
        'const { writeFileSync } = require("node:fs");',
        'process.on("SIGTERM", () => { writeFileSync("child-stopped", "yes"); process.exit(0); });',
        "setTimeout(() => process.exit(1), 2000);",
      ].join("\n");
      const parent = [
        'const { spawn } = require("node:child_process");',
        'spawn(process.execPath, ["-e", process.argv[1]], { stdio: "ignore" });',
        "setTimeout(() => {}, 3000);",
      ].join("\n");
      await expect(runProcess(process.execPath, ["-e", parent, child], {
        stdin: "",
        cwd: dir,
        env: process.env,
        signal: new AbortController().signal,
        timeoutMs: 500,
      })).rejects.toThrow("timed out");
      await vi.waitFor(async () => expect(await readFile(join(dir, "child-stopped"), "utf8")).toBe("yes"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "win32")("runs Windows command shims with piped input", async () => {
    const dir = await mkdtemp(join(tmpdir(), "recap-process-"));
    try {
      const script = join(dir, "recap test.cmd");
      await writeFile(script, '@echo off\r\n"%~1" -e "process.stdin.pipe(process.stdout)"\r\n');
      const result = await runProcess(script, [process.execPath], {
        stdin: "hello",
        cwd: dir,
        env: process.env,
        signal: new AbortController().signal,
        timeoutMs: 5_000,
      });
      expect(result).toEqual({ code: 0, stdout: "hello", stderr: "" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
