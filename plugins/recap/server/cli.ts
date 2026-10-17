import { readFile } from "node:fs/promises";
import { GeneratorUnavailableError } from "./errors";
import { asRecord, parseJson } from "./json";
import type { ProcessResult } from "./process";
import { parseRecapOutput, RECAP_JSON_SCHEMA, RECAP_SYSTEM_PROMPT, type ParsedRecap } from "./prompt";

// Arguments and output parsing for each recap CLI. Each run is as isolated as the CLI allows without
// changing the user's own configuration, leaves no session behind, and returns RECAP_JSON_SCHEMA JSON.

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

export function codexArgs(model: string | null, schemaPath: string, outputPath: string): string[] {
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
    ...(model ? ["--model", model] : []),
    "-",
  ];
}

export function opencodeArgs(model: string | null, workdir: string, major: number | null): string[] {
  // The 2.x CLI (@opencode/cli) dropped `run --pure` and `--dir`; 1.x (opencode-ai) still needs
  // them. An unknown generation keeps the 1.x flags, which is the behavior this always had.
  const legacy = major === null || major < 2;
  return [
    "run",
    ...(legacy ? ["--pure"] : []),
    "--format",
    "json",
    // Read-only agent; without --auto, any permission request is rejected.
    "--agent",
    "plan",
    ...(legacy ? ["--dir", workdir] : []),
    ...(model ? ["--model", model] : []),
  ];
}

/** Parses `opencode --version` output into the CLI generation, or null when it cannot be read. */
export function parseOpencodeMajor(stdout: string, code: number | null): number | null {
  const major = code === 0 ? Number(/v?(\d+)\./.exec(stdout.trim())?.[1] ?? NaN) : NaN;
  return Number.isFinite(major) ? major : null;
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

export async function parseCodexResult(result: ProcessResult, outputPath: string): Promise<ParsedRecap> {
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
