import { describe, expect, it } from "vitest";
import { addPrompt, applyEdit, deletePrompt, movePrompt, setDisplay, setSendRightAway, updatePrompt } from "../client/edits";
import { MAX_PROMPTS, type QuickPromptsSettings } from "../shared/prompts";

const prompt = (id: string, label = `Label ${id}`, text = `Text ${id}`) => ({ id, label, text });
const values = (...ids: string[]): QuickPromptsSettings => ({ prompts: ids.map((id) => prompt(id)), display: "pills", sendRightAway: true });
const ids = (settings: QuickPromptsSettings | null) => settings?.prompts.map(({ id }) => id);

describe("edits", () => {
  it("update, move, and delete prompts by id", () => {
    expect(applyEdit(updatePrompt("b", "label", "New"), values("a", "b"))?.prompts[1]).toEqual(prompt("b", "New"));
    expect(ids(applyEdit(movePrompt("b", -1), values("a", "b", "c")))).toEqual(["b", "a", "c"]);
    expect(ids(applyEdit(movePrompt("b", 1), values("a", "b", "c")))).toEqual(["a", "c", "b"]);
    expect(ids(applyEdit(deletePrompt("a"), values("a", "b")))).toEqual(["b"]);
    expect(applyEdit(setDisplay("menu"), values("a"))?.display).toBe("menu");
    expect(applyEdit(setSendRightAway(false), values("a"))?.sendRightAway).toBe(false);
  });

  it("do not apply to a missing prompt, past either end, or over the maximum", () => {
    expect(applyEdit(updatePrompt("x", "text", "New"), values("a"))).toBeNull();
    expect(applyEdit(deletePrompt("x"), values("a"))).toBeNull();
    expect(applyEdit(movePrompt("a", -1), values("a", "b"))).toBeNull();
    expect(applyEdit(movePrompt("b", 1), values("a", "b"))).toBeNull();
    const full = values(...Array.from({ length: MAX_PROMPTS }, (_, index) => `p${index}`));
    expect(applyEdit(addPrompt(prompt("new")), full)).toBeNull();
  });

  it("do not apply when the result would not save", () => {
    expect(applyEdit(updatePrompt("a", "label", "  "), values("a"))).toBeNull();
    expect(applyEdit(addPrompt(prompt("a")), values("a"))).toBeNull();
  });
});
