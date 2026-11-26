import { describe, expect, it } from "vitest";
import { MAX_PROMPTS, quickPromptsSettings, settingsFromRead } from "../shared/prompts";

const parse = (prompts: unknown) => quickPromptsSettings.schema.safeParse({ prompts });
const prompt = (id: string, label = "Review", text = "Review the changes.") => ({ id, label, text });

describe("quickPromptsSettings", () => {
  it("starts empty and trims saved labels and prompts", () => {
    expect(quickPromptsSettings.schema.parse({})).toEqual({ prompts: [], display: "pills", sendRightAway: true });
    expect(parse([prompt("a1", "  Review ", " Look again.\n")]).data?.prompts).toEqual([
      prompt("a1", "Review", "Look again."),
    ]);
  });

  it("rejects blank or long labels, blank prompts, and ids a pill id cannot carry", () => {
    expect(parse([prompt("a1", "   ")]).success).toBe(false);
    expect(parse([prompt("a1", "x".repeat(41))]).success).toBe(false);
    expect(parse([prompt("a1", "x".repeat(40))]).success).toBe(true);
    expect(parse([prompt("a1", "Review", " \n ")]).success).toBe(false);
    expect(parse([prompt("A-1")]).success).toBe(false);
  });

  it("rejects duplicate ids and more than the maximum count", () => {
    expect(parse([prompt("a1"), prompt("a1")]).success).toBe(false);
    const many = Array.from({ length: MAX_PROMPTS + 1 }, (_, index) => prompt(`p${index}`));
    expect(parse(many.slice(0, MAX_PROMPTS)).success).toBe(true);
    expect(parse(many).success).toBe(false);
  });

  it("keeps separate pills that send, and the prompts, when settings predate those fields", () => {
    expect(settingsFromRead({ status: "ready", values: { prompts: [prompt("a1")] } })).toEqual({
      prompts: [prompt("a1")],
      display: "pills",
      sendRightAway: true,
    });
    expect(
      settingsFromRead({ status: "ready", values: { prompts: [prompt("a1")], display: "menu", sendRightAway: false } }),
    ).toEqual({ prompts: [prompt("a1")], display: "menu", sendRightAway: false });
    expect(quickPromptsSettings.schema.safeParse({ display: "menu" }).data?.display).toBe("menu");
    expect(
      settingsFromRead({ status: "ready", values: { prompts: [prompt("a1")], display: "grid", sendRightAway: "yes" } }),
    ).toEqual({ prompts: [prompt("a1")], display: "pills", sendRightAway: true });
  });

  it("treats invalid stored data as the defaults", () => {
    const defaults = { prompts: [], display: "pills", sendRightAway: true };
    expect(settingsFromRead({ status: "ready", values: { prompts: [prompt("a1", "")] } })).toEqual(defaults);
    expect(settingsFromRead({ status: "invalid" })).toEqual(defaults);
  });
});
