import { describe, expect, it } from "vitest";
import { pillPresentation, relativeTime } from "../client/format";
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
  it("hides the pill until a recap exists", () => {
    expect(pillPresentation(undefined, NOW).visible).toBe(false);
    expect(pillPresentation(base, NOW).visible).toBe(false);
  });

  it("shows progress and age", () => {
    expect(pillPresentation({ ...base, state: "generating" }, NOW).label).toBe("Recap…");
    const recap = makeRecap({ generatedAt: "2026-10-07T11:57:00.000Z", stale: true });
    expect(pillPresentation({ ...base, recap }, NOW)).toEqual({
      visible: true,
      label: "Recap · 3m",
      icon: "History",
    });
  });
});
