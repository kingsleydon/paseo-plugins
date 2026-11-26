import { spawnProcess, terminateProcess } from "@getpaseo/plugin/server";
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

function collectOutput(stream: NodeJS.ReadableStream): () => string {
  const chunks: Buffer[] = [];
  let bytes = 0;
  stream.on("data", (chunk: Buffer) => {
    const remaining = OUTPUT_LIMIT_BYTES - bytes;
    if (remaining === 0) return;
    const kept = chunk.subarray(0, remaining);
    chunks.push(kept);
    bytes += kept.length;
  });
  return () => Buffer.concat(chunks, bytes).toString("utf8");
}

export const runProcess: RunProcess = (command, args, options) =>
  new Promise((resolve, reject) => {
    if (options.signal.aborted) {
      reject(abortError());
      return;
    }
    const child = spawnProcess(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: "pipe",
      detached: process.platform !== "win32",
    });
    const stdout = collectOutput(child.stdout);
    const stderr = collectOutput(child.stderr);
    let settled = false;
    const kill = async () => {
      if (child.pid === undefined) return;
      if (process.platform !== "win32") {
        try {
          // On POSIX the SDK signals only the child, so signal its detached group first.
          process.kill(-child.pid, "SIGTERM");
          return;
        } catch {
          // The group can exit before the signal is sent.
        }
      }
      await terminateProcess(child, "SIGTERM");
    };
    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener("abort", onAbort);
      outcome();
    };
    const stop = (reason: Error) => {
      finish(() => {
        void kill().catch((error: unknown) => {
          console.error("[paseo-recap] failed to terminate CLI", error);
        }).finally(() => reject(reason));
      });
    };
    const onAbort = () => stop(abortError());
    const timer = setTimeout(() => {
      stop(new Error(`${command} timed out after ${options.timeoutMs} ms`));
    }, options.timeoutMs);
    options.signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish(() =>
        reject(
          error.code === "ENOENT"
            ? new GeneratorUnavailableError(`${command} not found`)
            : error,
        ),
      );
    });
    child.on("close", (code) => finish(() => resolve({ code, stdout: stdout(), stderr: stderr() })));
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.stdin);
  });
