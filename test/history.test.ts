import { describe, expect, it } from "vitest";
import type { AgentTimelineItem } from "../server/paseo-types";
import {
  buildRecapHistory,
  byteLength,
  collectExchanges,
  countUserTurns,
  excerptBytes,
  formatHistory,
  HISTORY_EXCHANGES_LIMIT,
  isCompacting,
  latestActiveTask,
  trimForRecap,
} from "../server/history";

const user = (text: string): AgentTimelineItem => ({ type: "user_message", text });
const assistant = (text: string): AgentTimelineItem => ({ type: "assistant_message", text });

describe("collectExchanges", () => {
  it("joins split assistant text and ignores tools, reasoning, and leading output", () => {
    const timeline: AgentTimelineItem[] = [
      assistant("orphan preamble"),
      user("Fix the login bug"),
      { type: "reasoning", text: "thinking" },
      assistant("Found it. "),
      assistant("Fixed and tested."),
      { type: "error", message: "Rate limited" },
      { type: "notification", level: "info", message: "ignored" },
    ];
    expect(collectExchanges(timeline)).toEqual([
      { user: "Fix the login bug", assistant: "Found it. Fixed and tested.", errors: ["Rate limited"] },
    ]);
  });

  it("skips blank user messages", () => {
    expect(collectExchanges([user("  "), assistant("x")])).toEqual([]);
  });
});

describe("latestActiveTask", () => {
  it("prefers the in-progress item of the latest todo list", () => {
    const timeline: AgentTimelineItem[] = [
      { type: "todo", items: [{ text: "old", completed: false }] },
      {
        type: "todo",
        items: [
          { text: "done", completed: true, status: "completed" },
          { text: "write tests", completed: false, status: "pending" },
          { text: "ship", completed: false, status: "in_progress", activeForm: "Shipping" },
        ],
      },
    ];
    expect(latestActiveTask(timeline)).toBe("Shipping");
  });

  it("returns null when every task is complete", () => {
    expect(latestActiveTask([{ type: "todo", items: [{ text: "a", completed: true }] }])).toBeNull();
  });
});

describe("formatHistory", () => {
  it("returns labeled exchanges when they fit", () => {
    const text = formatHistory([{ user: "Hi", assistant: "Hello", errors: [] }], 1000);
    expect(text).toBe("User: Hi\n\nAssistant: Hello");
  });

  it("drops the oldest exchanges first", () => {
    const exchanges = [
      { user: "a".repeat(400), assistant: "b".repeat(400), errors: [] },
      { user: "latest", assistant: "answer", errors: [] },
    ];
    const text = formatHistory(exchanges, 200);
    expect(text.startsWith("[Earlier exchanges omitted]")).toBe(true);
    expect(text).toContain("User: latest");
    expect(text).not.toContain("aaaa");
  });

  it("keeps a newer unanswered request together with the latest answer", () => {
    const exchanges = [
      { user: "old", assistant: "x".repeat(500), errors: [] },
      { user: "do the thing", assistant: "done", errors: [] },
      { user: "actually, also update docs", assistant: "", errors: [] },
    ];
    const text = formatHistory(exchanges, 120);
    expect(text).toContain("do the thing");
    expect(text).toContain("actually, also update docs");
  });

  it("excerpts fields to respect the byte budget", () => {
    const exchanges = [{ user: "u".repeat(5000), assistant: "a".repeat(5000), errors: [] }];
    const text = formatHistory(exchanges, 1000);
    expect(byteLength(text)).toBeLessThanOrEqual(1000);
    expect(text).toContain("[... excerpted ...]");
  });
});

describe("excerptBytes", () => {
  it("never splits multi-byte characters", () => {
    const text = "你好世界".repeat(100);
    const excerpt = excerptBytes(text, 101);
    expect(byteLength(excerpt)).toBeLessThanOrEqual(101);
    expect(excerpt).not.toContain("�");
  });
});

describe("buildRecapHistory", () => {
  it("keeps the requested number of exchanges while user turns count the whole timeline", () => {
    const timeline = Array.from({ length: 10 }, (_, index) => [
      user(`request ${index}`),
      assistant(`reply ${index}`),
    ]).flat();
    const history = buildRecapHistory(timeline, 10_000, 8);
    expect(countUserTurns(timeline)).toBe(10);
    expect(history).not.toContain("request 1\n");
    expect(history).toContain("request 2");
    expect(history).toContain("reply 9");
    expect(buildRecapHistory(timeline, 10_000, 3)).not.toContain("request 6");
    expect(buildRecapHistory(timeline, 10_000, 20)).toContain("request 0");
  });
});

describe("trimForRecap", () => {
  it("keeps text items of the last exchanges and carries the latest todo forward", () => {
    const todo: AgentTimelineItem = { type: "todo", items: [{ text: "ship", completed: false }] };
    const timeline: AgentTimelineItem[] = [
      todo,
      ...Array.from({ length: HISTORY_EXCHANGES_LIMIT + 5 }, (_, index): AgentTimelineItem[] => [
        user(`q${index}`),
        { type: "reasoning", text: `thinking ${index}` },
        assistant(`a${index}`),
      ]).flat(),
    ];
    const trimmed = trimForRecap(timeline);
    expect(trimmed[0]).toBe(todo);
    expect(trimmed.filter((item) => item.type === "user_message")).toHaveLength(HISTORY_EXCHANGES_LIMIT);
    expect(trimmed.some((item) => item.type === "reasoning")).toBe(false);
    expect(buildRecapHistory(trimmed, 10_000, 8)).toBe(buildRecapHistory(timeline, 10_000, 8));
    expect(latestActiveTask(trimmed)).toBe("ship");
  });

  it("returns short timelines unchanged", () => {
    const timeline = [user("q"), assistant("a")];
    expect(trimForRecap(timeline)).toEqual(timeline);
  });
});

describe("isCompacting", () => {
  it("looks at the latest compaction marker only", () => {
    expect(isCompacting([user("q"), { type: "compaction", status: "loading" }])).toBe(true);
    expect(
      isCompacting([
        { type: "compaction", status: "loading" },
        { type: "compaction", status: "completed" },
      ]),
    ).toBe(false);
    expect(isCompacting([user("q")])).toBe(false);
  });
});
