import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GeneratorChoice, GeneratorMode, ModelPlan } from "../shared/recap";
import { parseRecapOutput, RECAP_JSON_SCHEMA, RECAP_SYSTEM_PROMPT, type ParsedRecap } from "./prompt";

export const GENERATE_TIMEOUT_MS = 60_000;
/** Many agents can finish at once; recaps queue instead of spawning a CLI per agent. */
export const MAX_CONCURRENT_GENERATIONS = 2;
const UNAVAILABLE_COOLDOWN_MS = 10 * 60_000;
const OUTPUT_LIMIT_BYTES = 1024 * 1024;
const CLEANUP_TIMEOUT_MS = 15_000;
const PROBE_TIMEOUT_MS = 15_000;

/**
 * Codex features that give a turn tools. A recap reads untrusted conversation text, so none may
 * run. Only names the installed Codex lists are passed: it rejects unknown feature flags.
 */
const CODEX_TOOL_FEATURES: ReadonlySet<string> = new Set([
  "apps",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "code_mode_host",
  "computer_use",
  "goals",
  "image_generation",
  "in_app_browser",
  "memories",
  "multi_agent",
  "multi_agent_v2",
  "plugins",
  "remote_plugin",
  "shell_tool",
  "skill_mcp_dependency_install",
  "sleep_tool",
  "standalone_web_search",
  "tool_suggest",
  "unified_exec",
  "view_image",
]);
const CODEX_MCP_NAME = /^[A-Za-z0-9_-]+$/;

const SUPPORTED_PROVIDERS = ["claude", "codex", "opencode"] as const;
type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

function isSupportedProvider(value: string): value is SupportedProvider {
  return (SUPPORTED_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Small, fast model per provider for recaps. OpenCode model ids depend on the user's providers,
 * so it uses its configured default.
 */
const RECAP_MODELS: Record<SupportedProvider, string | null> = {
  claude: "haiku",
  codex: "gpt-6-luna",
  opencode: null,
};

/** Tried after the user's metadata-generation order, as Paseo does for its own one-shot text. */
const DEFAULT_CANDIDATES: readonly GeneratorChoice[] = [
  { provider: "claude", model: "haiku" },
  { provider: "codex", model: "gpt-6-luna" },
];

export interface GeneratorCandidate {
  provider: SupportedProvider;
  model: string | null;
  /** Executable followed by fixed leading arguments. */
  command: readonly [string, ...string[]];
}

export interface GeneratedRecap extends ParsedRecap {
  provider: string;
  model: string | null;
}

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

/** Raised when a CLI cannot run at all (missing binary, not logged in, rate limited). */
export class GeneratorUnavailableError extends Error {}

/** No candidate could run: none configured, all cooling down, or all unavailable. */
export class NoGeneratorError extends Error {
  constructor() {
    super("No recap model is available");
    this.name = "NoGeneratorError";
  }
}

/** Every candidate was skipped on purpose (near its usage limit); not a failure. */
export class RecapSkippedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "RecapSkippedError";
  }
}

/** Subset of daemon config read here; validated loosely because provider entries are open-ended. */
export interface GeneratorConfig {
  metadataGeneration?: { providers?: ReadonlyArray<{ provider: string; model?: string }> };
  providers?: Record<string, unknown>;
}

/**
 * Orders recap generators. In `auto`, the agent's own provider goes first — Claude Code, Codex, and
 * OMP all recap with the session's provider, and it keeps the conversation with the vendor the user
 * already chose for that agent.
 */
export function resolveCandidates(
  choice: GeneratorMode | GeneratorChoice,
  config: GeneratorConfig,
  agentProvider: string | null = null,
): GeneratorCandidate[] {
  const paseoOrder = [...(config.metadataGeneration?.providers ?? []), ...DEFAULT_CANDIDATES];
  let ordered: GeneratorChoice[];
  if (choice === "auto") {
    const own =
      agentProvider && isSupportedProvider(agentProvider)
        ? [{ provider: agentProvider, model: RECAP_MODELS[agentProvider] ?? undefined }]
        : [];
    ordered = [...own, ...paseoOrder];
  } else if (choice === "metadata") {
    ordered = paseoOrder;
  } else {
    ordered = [choice];
  }
  const seen = new Set<string>();
  const candidates: GeneratorCandidate[] = [];
  for (const entry of ordered) {
    if (!isSupportedProvider(entry.provider)) continue;
    const providerConfig = asRecord(config.providers?.[entry.provider]);
    if (providerConfig?.enabled === false) continue;
    const model = entry.model ?? null;
    const key = `${entry.provider}\u0000${model ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      provider: entry.provider,
      model,
      command: configuredCommand(providerConfig?.command) ?? [entry.provider],
    });
  }
  return candidates;
}

/** Which models a setting resolves to, for the settings screen. Availability is checked at run time. */
export function describeModelPlan(choice: GeneratorMode | GeneratorChoice, config: GeneratorConfig): ModelPlan {
  const summarize = (candidates: readonly GeneratorCandidate[]) =>
    candidates.map(({ provider, model }) => ({ provider, model }));
  const fallback = summarize(resolveCandidates(choice === "auto" ? "metadata" : choice, config));
  if (choice !== "auto") return { perProvider: [], fallback };
  const perProvider = SUPPORTED_PROVIDERS.flatMap((provider) =>
    summarize(resolveCandidates("auto", config, provider).slice(0, 1)).filter(
      (candidate) => candidate.provider === provider,
    ),
  );
  return { perProvider, fallback };
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
          const isolation = await this.#codexIsolation(candidate, workdir, env, signal);
          const result = await run(codexArgs(candidate.model, schemaPath, outputPath, isolation));
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

  /**
   * Arguments that switch off every MCP server and tool feature of the user's Codex while keeping
   * the rest of its config (auth, model providers). Config overrides merge rather than replace, so
   * each server is disabled by name. Fails closed: if Codex cannot be inspected, it is not used.
   */
  async #codexIsolation(
    candidate: GeneratorCandidate,
    workdir: string,
    env: NodeJS.ProcessEnv,
    signal: AbortSignal,
  ): Promise<string[]> {
    const [executable, ...leading] = candidate.command;
    const probe = (args: readonly string[]) =>
      this.#deps.runProcess(executable, [...leading, ...args], {
        stdin: "",
        cwd: workdir,
        env,
        signal,
        timeoutMs: PROBE_TIMEOUT_MS,
      });
    const [servers, features] = await Promise.all([probe(["mcp", "list", "--json"]), probe(["features", "list"])]);
    if (servers.code !== 0 || features.code !== 0) {
      throw new GeneratorUnavailableError("could not inspect codex MCP servers and features");
    }
    return codexIsolationArgs(parseCodexMcpNames(servers.stdout), parseCodexFeatures(features.stdout));
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

export function claudeArgs(model: string | null): string[] {
  return [
    "-p",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(RECAP_JSON_SCHEMA),
    "--system-prompt",
    RECAP_SYSTEM_PROMPT,
    "--tools",
    "",
    "--no-session-persistence",
    // No user/project settings: no hooks, plugins, or CLAUDE.md run for a recap.
    "--setting-sources",
    "",
    "--strict-mcp-config",
    // Extended thinking makes small models deliberate for a minute over a 60-word recap.
    "--settings",
    JSON.stringify({ alwaysThinkingEnabled: false }),
    ...(model ? ["--model", model] : []),
  ];
}

/** Server names from `codex mcp list --json`. Throws on anything it cannot safely disable. */
export function parseCodexMcpNames(stdout: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new GeneratorUnavailableError("unexpected codex mcp list output");
  }
  if (!Array.isArray(parsed)) throw new GeneratorUnavailableError("unexpected codex mcp list output");
  return parsed.map((server: unknown) => {
    const name = asRecord(server)?.name;
    if (typeof name !== "string" || !CODEX_MCP_NAME.test(name)) {
      throw new GeneratorUnavailableError("codex MCP server name cannot be disabled safely");
    }
    return name;
  });
}

/** Feature names from `codex features list` (name, stage, state columns), skipping removed ones. */
export function parseCodexFeatures(stdout: string): Set<string> {
  const names = new Set<string>();
  for (const line of stdout.split("\n")) {
    const [name, stage] = line.trim().split(/\s+/);
    if (name && stage && stage !== "removed") names.add(name);
  }
  return names;
}

export function codexIsolationArgs(mcpServers: readonly string[], features: ReadonlySet<string>): string[] {
  return [
    ...mcpServers.flatMap((name) => ["--config", `mcp_servers.${name}.enabled=false`]),
    ...[...CODEX_TOOL_FEATURES].filter((feature) => features.has(feature)).flatMap((feature) => ["--disable", feature]),
    "--config",
    'web_search="disabled"',
  ];
}

export function codexArgs(
  model: string | null,
  schemaPath: string,
  outputPath: string,
  isolation: readonly string[],
): string[] {
  return [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--output-schema",
    schemaPath,
    "--output-last-message",
    outputPath,
    // User config stays loaded (it carries auth and model gateways), but its hooks and turn
    // notifications must not fire for a background recap.
    "--disable",
    "hooks",
    "--config",
    "notify=[]",
    "--config",
    'model_reasoning_effort="low"',
    ...isolation,
    ...(model ? ["--model", model] : []),
    "-",
  ];
}

export function opencodeArgs(model: string | null, workdir: string): string[] {
  return [
    "run",
    "--pure",
    "--format",
    "json",
    // Read-only agent; without --auto, any permission request is rejected.
    "--agent",
    "plan",
    "--dir",
    workdir,
    ...(model ? ["--model", model] : []),
  ];
}

export interface OpencodeOutcome {
  sessionId: string | null;
  recap: ParsedRecap;
  error: Error | null;
}

/** Reads `opencode run --format json` JSONL: final text parts, session id, and errors. */
export function parseOpencodeEvents(result: ProcessResult): OpencodeOutcome {
  let sessionId: string | null = null;
  const texts: string[] = [];
  let failure: string | null = null;
  for (const line of result.stdout.split("\n")) {
    const event = asRecord(parseJson(line.trim()));
    if (!event) continue;
    if (typeof event.sessionID === "string") sessionId = event.sessionID;
    const part = asRecord(event.part);
    if (event.type === "text" && typeof part?.text === "string") texts.push(part.text);
    if (event.type === "error") failure = JSON.stringify(event.error ?? "error").slice(0, 300);
  }
  const empty: ParsedRecap = { summary: "", nextAction: null };
  if (failure !== null || result.code !== 0) {
    const error = classifyFailure("opencode", { ...result, stderr: `${result.stderr}\n${failure ?? ""}` });
    return { sessionId, recap: empty, error };
  }
  const recap = parseRecapOutput(texts.join("").trim());
  return recap
    ? { sessionId, recap, error: null }
    : { sessionId, recap: empty, error: new Error("opencode returned an invalid recap") };
}

export function parseClaudeResult(result: ProcessResult): ParsedRecap {
  const envelope = asRecord(parseJson(result.stdout.trim()));
  if (!envelope) {
    throw classifyFailure("claude", result);
  }
  if (envelope.is_error === true) {
    throw classifyFailure("claude", { ...result, stderr: `${result.stderr}\n${String(envelope.result ?? "")}` });
  }
  const recap = parseRecapOutput(envelope.structured_output ?? envelope.result);
  if (!recap) throw new Error("claude returned an invalid recap");
  return recap;
}

async function parseCodexResult(result: ProcessResult, outputPath: string): Promise<ParsedRecap> {
  if (result.code !== 0) throw classifyFailure("codex", result);
  const text = await readFile(outputPath, "utf8").catch(() => "");
  const recap = parseRecapOutput(text);
  if (!recap) throw new Error("codex returned an invalid recap");
  return recap;
}

const UNAVAILABLE_PATTERN =
  /not logged in|please run \/login|login required|unauthori[sz]ed|invalid api key|ENOENT|rate.?limit|usage limit|quota|\b429\b/i;

function classifyFailure(provider: string, result: ProcessResult): Error {
  const detail = `${result.stderr}\n${result.stdout}`.trim().slice(-500);
  const message = `${provider} exited with code ${String(result.code)}`;
  return UNAVAILABLE_PATTERN.test(detail)
    ? new GeneratorUnavailableError(`${message}: unavailable`)
    : new Error(`${message}: ${detail.split("\n").at(-1) ?? ""}`);
}

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

function configuredCommand(value: unknown): readonly [string, ...string[]] | null {
  if (typeof value === "string" && value.trim() !== "") return [value];
  if (!Array.isArray(value)) return null;
  const parts = value.filter((part): part is string => typeof part === "string");
  const [first, ...rest] = parts;
  return parts.length === value.length && first ? [first, ...rest] : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Typed abort error; RN's global AbortSignal typing lacks `reason`. */
export function abortError(): Error {
  const error = new Error("Recap generation aborted");
  error.name = "AbortError";
  return error;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
