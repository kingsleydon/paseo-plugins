import { describe, expect, it } from "vitest";
import { applyEdit } from "../client/edits";
import { exportPrompts, importPrompts, parseImport } from "../client/transfer";
import { MAX_PROMPTS, type QuickPromptsSettings } from "../shared/prompts";

const prompt = (id: string, label = `Label ${id}`, text = `Text ${id}`) => ({ id, label, text });
const values = (...ids: string[]): QuickPromptsSettings => ({ prompts: ids.map((id) => prompt(id)), display: "menu" });
const contents = (settings: QuickPromptsSettings | null) => settings?.prompts.map(({ label, text }) => [label, text]);

describe("transfer", () => {
  it("imports exported prompts on another host with new ids", () => {
    const parsed = parseImport(exportPrompts(values("a", "b")));
    if ("error" in parsed) throw new Error(parsed.error);
    const imported = applyEdit(importPrompts(parsed.prompts, true), values("x"));
    expect(contents(imported)).toEqual(contents(values("a", "b")));
    expect(imported?.display).toBe("menu");
    expect(new Set(imported?.prompts.map(({ id }) => id)).size).toBe(2);
  });

  it("adds only prompts not saved yet, and not over the maximum", () => {
    const incoming = [
      { label: "Label a", text: "Text a" },
      { label: "New", text: "New text" },
    ];
    expect(contents(applyEdit(importPrompts(incoming, false), values("a")))).toEqual([
      ["Label a", "Text a"],
      ["New", "New text"],
    ]);
    const full = values(...Array.from({ length: MAX_PROMPTS }, (_, index) => `p${index}`));
    expect(applyEdit(importPrompts(incoming, false), full)).toBeNull();
    expect(contents(applyEdit(importPrompts(incoming, true), full))).toEqual(incoming.map(({ label, text }) => [label, text]));
  });

  it("explains text that cannot be imported", () => {
    expect(parseImport("not json")).toEqual({ error: "Paste the text copied with Export." });
    expect(parseImport('{"prompts": []}')).toEqual({ error: "There are no prompts to import." });
    expect(parseImport('{"prompts": [{"label": "Ok", "text": "Fine"}, {"label": " ", "text": "x"}]}')).toEqual({
      error: "Prompt 2: Enter a label",
    });
  });
});
