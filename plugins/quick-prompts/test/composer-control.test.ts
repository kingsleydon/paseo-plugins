import { describe, expect, it } from "vitest";
import { composerControlView, insertPrompt, searchPrompts } from "../client/composer-control";

const review = { id: "a1", label: "Review", text: "Review the uncommitted changes." };
const tests = { id: "b2", label: "Tests", text: "Run the tests\n\nand fix   failures." };
const ready = (prompts: (typeof review)[]) => ({ status: "ready" as const, values: { prompts } });

describe("composerControlView", () => {
  it("shows nothing until the prompts are read, or when they cannot be", () => {
    expect(composerControlView({ status: "loading" })).toEqual({ kind: "hidden" });
    expect(composerControlView({ status: "error" })).toEqual({ kind: "hidden" });
  });

  it("offers to add a prompt when none are saved or the saved settings are invalid", () => {
    expect(composerControlView(ready([]))).toEqual({ kind: "add" });
    expect(composerControlView({ status: "invalid" })).toEqual({ kind: "add" });
  });

  it("lists the saved prompts", () => {
    expect(composerControlView(ready([review, tests]))).toEqual({ kind: "prompts", prompts: [review, tests] });
  });
});

describe("searchPrompts", () => {
  it("lists every prompt in order when the list opens, with a one-line preview", () => {
    expect(searchPrompts([review, tests], "")).toEqual([
      { id: "a1", label: "Review", description: "Review the uncommitted changes.", text: review.text },
      { id: "b2", label: "Tests", description: "Run the tests and fix failures.", text: tests.text },
    ]);
  });

  it("matches the label or the prompt text in any case", () => {
    expect(searchPrompts([review, tests], "TESTS").map(({ id }) => id)).toEqual(["b2"]);
    expect(searchPrompts([review, tests], " uncommitted ").map(({ id }) => id)).toEqual(["a1"]);
    expect(searchPrompts([review, tests], "deploy")).toEqual([]);
  });

  it("shortens long previews", () => {
    const [item] = searchPrompts([{ id: "c3", label: "Long", text: "x".repeat(200) }], "");
    expect(item?.description).toHaveLength(80);
    expect(item?.description.endsWith("…")).toBe(true);
  });
});

describe("insertPrompt", () => {
  it("inserts the full prompt at the cursor, then focuses the composer", async () => {
    const calls: string[] = [];
    await insertPrompt(
      {
        insertText: (text) => void calls.push(`insert:${text}`),
        focus: async () => void calls.push("focus"),
      },
      tests.text,
    );
    expect(calls).toEqual([`insert:${tests.text}`, "focus"]);
  });

  it("rejects when the composer cannot take the text, without focusing", async () => {
    const calls: string[] = [];
    const locked = {
      insertText: () => {
        throw new Error("locked");
      },
      focus: async () => void calls.push("focus"),
    };
    await expect(insertPrompt(locked, review.text)).rejects.toThrow("locked");
    expect(calls).toEqual([]);
  });
});
