import { describe, expect, it } from "vitest";
import { recapSettings } from "../shared/recap";

describe("recapSettings", () => {
  it("fills new settings with defaults for documents saved by older versions", () => {
    expect(recapSettings.schema.parse({ autoRecap: true, minTurns: 5 })).toMatchObject({
      minTurns: 5,
      turnsBetweenRecaps: 1,
      historyExchanges: 8,
      waitForSubagents: false,
    });
  });

  it("rejects model ids that the CLI could read as flags or extra arguments", () => {
    const parse = (model: string) =>
      recapSettings.schema.safeParse({ generator: { provider: "claude", model } }).success;
    expect(parse("haiku")).toBe(true);
    expect(parse("anthropic/claude-haiku-4.5")).toBe(true);
    expect(parse("--dangerously-skip-permissions")).toBe(false);
    expect(parse("haiku --tools all")).toBe(false);
  });
});
