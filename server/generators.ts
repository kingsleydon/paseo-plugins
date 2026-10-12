import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { claudeArgs, codexArgs, opencodeArgs, parseClaudeResult, parseCodexResult, parseOpencodeEvents } from "./cli";
import { abortError, errorMessage, GeneratorUnavailableError, NoGeneratorError } from "./errors";
import type { GeneratorCandidate } from "./models";
import { sanitizeEnv, type RunProcess } from "./process";
import { RECAP_JSON_SCHEMA, type ParsedRecap } from "./prompt";

const GENERATE_TIMEOUT_MS = 60_000;
/** Many agents can finish at once; recaps queue instead of spawning a CLI per agent. */
export const MAX_CONCURRENT_GENERATIONS = 2;
const UNAVAILABLE_COOLDOWN_MS = 10 * 60_000;
const CLEANUP_TIMEOUT_MS = 15_000;

export interface GeneratedRecap extends ParsedRecap {
  provider: string;
  model: string | null;
}

export interface GeneratorDeps {
  runProcess: RunProcess;
  env: NodeJS.ProcessEnv;
  tempRoot: string;
  now: () => number;
  log: (message: string, detail?: unknown) => void;
}

/**
 * Tries candidates in order, limits concurrent CLI processes, and remembers CLIs that cannot run
 * so they are skipped for a while.
 */
export class RecapGenerator {
  readonly #deps: GeneratorDeps;
  readonly #unavailableUntil = new Map<string, number>();
  readonly #waiting: Array<() => void> = [];
  #active = 0;

  constructor(deps: GeneratorDeps) {
    this.#deps = deps;
  }

  async generate(
    prompt: string,
    candidates: readonly GeneratorCandidate[],
    signal: AbortSignal,
  ): Promise<GeneratedRecap> {
    if (candidates.length === 0) throw new NoGeneratorError();
    await this.#acquire(signal);
    try {
      return await this.#generate(prompt, candidates, signal);
    } finally {
      this.#release();
    }
  }

  async #generate(
    prompt: string,
    candidates: readonly GeneratorCandidate[],
    signal: AbortSignal,
  ): Promise<GeneratedRecap> {
    let lastError: unknown = null;
    let onlyUnavailable = true;
    for (const candidate of candidates) {
      if (signal.aborted) throw abortError();
      const key = candidate.command.join(" ");
      const until = this.#unavailableUntil.get(key);
      if (until !== undefined && until > this.#deps.now()) continue;
      try {
        const recap = await this.#runCandidate(candidate, prompt, signal);
        return { ...recap, provider: candidate.provider, model: candidate.model };
      } catch (error) {
        if (signal.aborted) throw error;
        lastError = error;
        if (error instanceof GeneratorUnavailableError) {
          this.#unavailableUntil.set(key, this.#deps.now() + UNAVAILABLE_COOLDOWN_MS);
        } else {
          onlyUnavailable = false;
        }
        this.#deps.log(`recap generator ${candidate.provider} failed`, errorMessage(error));
      }
    }
    // Nothing ran, or nothing could run: the user needs to install, log in, or pick a model.
    if (lastError === null || onlyUnavailable) throw new NoGeneratorError();
    throw lastError;
  }

  /** Waits for a free slot; leaves the queue if aborted while waiting. */
  #acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(abortError());
    if (this.#active < MAX_CONCURRENT_GENERATIONS) {
      this.#active++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const grant = () => {
        signal.removeEventListener("abort", onAbort);
        this.#active++;
        resolve();
      };
      const onAbort = () => {
        const index = this.#waiting.indexOf(grant);
        if (index >= 0) this.#waiting.splice(index, 1);
        reject(abortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.#waiting.push(grant);
    });
  }

  #release(): void {
    this.#active--;
    this.#waiting.shift()?.();
  }

  async #runCandidate(
    candidate: GeneratorCandidate,
    prompt: string,
    signal: AbortSignal,
  ): Promise<ParsedRecap> {
    const workdir = await mkdtemp(join(this.#deps.tempRoot, "run-"));
    const [executable, ...leading] = candidate.command;
    const env = sanitizeEnv(this.#deps.env);
    const run = (args: readonly string[]) =>
      this.#deps.runProcess(executable, [...leading, ...args], {
        stdin: prompt,
        cwd: workdir,
        env,
        signal,
        timeoutMs: GENERATE_TIMEOUT_MS,
      });
    try {
      switch (candidate.provider) {
        case "claude":
          return parseClaudeResult(await run(claudeArgs(candidate.model)));
        case "codex": {
          const schemaPath = join(workdir, "schema.json");
          const outputPath = join(workdir, "last-message.json");
          await writeFile(schemaPath, JSON.stringify(RECAP_JSON_SCHEMA));
          const result = await run(codexArgs(candidate.model, schemaPath, outputPath));
          return await parseCodexResult(result, outputPath);
        }
        case "opencode": {
          const parsed = parseOpencodeEvents(await run(opencodeArgs(candidate.model, workdir)));
          // `opencode run` always persists a session; remove it so recaps leave no trace.
          if (parsed.sessionId) await this.#deleteOpencodeSession(candidate, parsed.sessionId, workdir, env);
          if (parsed.error) throw parsed.error;
          return parsed.recap;
        }
      }
    } finally {
      await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async #deleteOpencodeSession(
    candidate: GeneratorCandidate,
    sessionId: string,
    workdir: string,
    env: NodeJS.ProcessEnv,
  ): Promise<void> {
    const [executable, ...leading] = candidate.command;
    try {
      const result = await this.#deps.runProcess(
        executable,
        [...leading, "session", "delete", sessionId],
        { stdin: "", cwd: workdir, env, signal: new AbortController().signal, timeoutMs: CLEANUP_TIMEOUT_MS },
      );
      if (result.code !== 0) this.#deps.log("could not delete opencode recap session", sessionId);
    } catch (error) {
      this.#deps.log("could not delete opencode recap session", errorMessage(error));
    }
  }
}
