import { spawn } from "node:child_process";
import { abortError, GeneratorUnavailableError } from "./errors";

const OUTPUT_LIMIT_BYTES = 1024 * 1024;

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface RunProcessOptions {
  stdin: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  timeoutMs: number;
}

export type RunProcess = (
  command: string,
  args: readonly string[],
  options: RunProcessOptions,
) => Promise<ProcessResult>;

/** Drops variables that make a nested CLI believe it runs inside another agent session. */
export function sanitizeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { ...env };
  for (const key of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT"]) {
    delete clean[key];
  }
  return clean;
}

export const runProcess: RunProcess = (command, args, options) =>
  new Promise((resolve, reject) => {
    if (options.signal.aborted) {
      reject(abortError());
      return;
    }
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const kill = () => {
      if (child.pid === undefined || child.exitCode !== null) return;
      try {
        // Negative pid targets the process group so CLI helpers die too.
        process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    };
    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener("abort", onAbort);
      outcome();
    };
    const onAbort = () => {
      kill();
      finish(() => reject(abortError()));
    };
    const timer = setTimeout(() => {
      kill();
      finish(() => reject(new Error(`${command} timed out after ${options.timeoutMs} ms`)));
    }, options.timeoutMs);
    options.signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < OUTPUT_LIMIT_BYTES) stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < OUTPUT_LIMIT_BYTES) stderr += chunk;
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish(() =>
        reject(
          error.code === "ENOENT"
            ? new GeneratorUnavailableError(`${command} not found`)
            : error,
        ),
      );
    });
    child.on("close", (code) => finish(() => resolve({ code, stdout, stderr })));
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.stdin);
  });
