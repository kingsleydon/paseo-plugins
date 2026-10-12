import { describe, expect, it } from "vitest";
import { describePlan, pillPresentation, relativeTime } from "../client/format";
import type { RecapView } from "../shared/recap";
import { makeRecap } from "./fixtures";

const NOW = Date.parse("2026-10-07T12:00:00.000Z");
const base: RecapView = { agentId: "a", state: "idle", recap: null, previous: [], error: null };

describe("relativeTime", () => {
  it("formats minutes, hours, and days", () => {
    expect(relativeTime("2026-10-07T11:59:30.000Z", NOW)).toBe("now");
    expect(relativeTime("2026-10-07T11:57:00.000Z", NOW)).toBe("3m");
    expect(relativeTime("2026-10-07T09:00:00.000Z", NOW)).toBe("3h");
    expect(relativeTime("2026-10-03T12:00:00.000Z", NOW)).toBe("4d");
  });
});

describe("pillPresentation", () => {
  it("shows the pill before the first recap so one can be generated", () => {
    expect(pillPresentation(undefined, NOW)).toMatchObject({ visible: true, label: "Recap", busy: false });
  });

  it("shows progress and age", () => {
    expect(pillPresentation({ ...base, state: "generating" }, NOW)).toMatchObject({ label: "Recap…", busy: true });
    const recap = makeRecap({ generatedAt: "2026-10-07T11:57:00.000Z", stale: true });
    expect(pillPresentation({ ...base, recap }, NOW)).toEqual({
      visible: true,
      label: "Recap · 3m",
      icon: "History",
      busy: false,
    });
  });
});

describe("describePlan", () => {
  it("names the exact models in plain words", () => {
    expect(
      describePlan({
        perProvider: [
          { provider: "claude", model: "haiku" },
          { provider: "opencode", model: null },
        ],
        fallback: [
          { provider: "claude", model: "haiku" },
          { provider: "codex", model: "gpt-6-luna" },
        ],
      }),
    ).toBe(
      "Claude agents: Claude haiku. OpenCode agents: OpenCode default model. Other agents, or if that fails: Claude haiku, then Codex gpt-6-luna.",
    );
    expect(describePlan({ perProvider: [], fallback: [{ provider: "claude", model: "sonnet" }] })).toBe("Claude sonnet.");
    expect(describePlan({ perProvider: [], fallback: [] })).toMatch(/No supported model/);
  });
});
