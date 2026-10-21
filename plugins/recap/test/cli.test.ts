import { describe, expect, it } from "vitest";
import {
  claudeArgs,
  codexArgs,
  opencodeArgs,
  parseClaudeResult,
  parseOpencodeEvents,
  parseOpencodeMajor,
} from "../server/cli";
import { GeneratorUnavailableError } from "../server/errors";

describe("CLI arguments", () => {
  it("keeps Codex hooks and notifications out of background recaps", () => {
    const args = codexArgs("gpt-6-luna", "/s.json", "/o.json");
    expect(args).toEqual(expect.arrayContaining(["--ephemeral", "--disable", "hooks", "notify=[]"]));
    expect(args.at(-1)).toBe("-");
  });

  it("runs OpenCode 1.x with a read-only agent in the temp directory", () => {
    expect(opencodeArgs("p/m", "/tmp/x", 1)).toEqual([
      "run", "--pure", "--format", "json", "--agent", "plan", "--dir", "/tmp/x", "--model", "p/m",
    ]);
  });

  it("runs the opencode 2.x CLI standalone without the 1.x-only flags", () => {
    expect(opencodeArgs("p/m", "/tmp/x", 2)).toEqual([
      "run", "--standalone", "--format", "json", "--agent", "plan", "--model", "p/m",
    ]);
  });

  it("keeps the 1.x flags while the opencode generation is unknown", () => {
    expect(opencodeArgs("p/m", "/tmp/x", null)).toEqual([
      "run", "--pure", "--format", "json", "--agent", "plan", "--dir", "/tmp/x", "--model", "p/m",
    ]);
  });

  it("reads the opencode generation from --version output", () => {
    expect(parseOpencodeMajor("opencode v2.0.32", 0)).toBe(2);
    expect(parseOpencodeMajor("1.19.3", 0)).toBe(1);
    expect(parseOpencodeMajor("something else", 0)).toBeNull();
    expect(parseOpencodeMajor("opencode v2.0.32", 1)).toBeNull();
    expect(parseOpencodeMajor("opencode v2.0.32", null)).toBeNull();
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
