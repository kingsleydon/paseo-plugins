import { MAX_PROMPTS, newPromptId, QuickPromptSchema, type QuickPrompt, type QuickPromptsSettings } from "../shared/prompts";
import type { Edit } from "./edits";

/** Names the exported text so it is recognizable when pasted elsewhere. */
const EXPORT_FORMAT = "paseo-quick-prompts";

const ImportedPromptSchema = QuickPromptSchema.omit({ id: true });

type ImportedPrompt = Omit<QuickPrompt, "id">;

/** The prompts as JSON text, without ids, for importing on another host. */
export function exportPrompts(values: QuickPromptsSettings): string {
  const prompts = values.prompts.map(({ label, text }) => ({ label, text }));
  return JSON.stringify({ format: EXPORT_FORMAT, version: 1, prompts }, null, 2);
}

/** The prompts in exported text, or the first problem with it. */
export function parseImport(text: string): { prompts: ImportedPrompt[] } | { error: string } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { error: "Paste the text copied with Export." };
  }
  const list = typeof data === "object" && data !== null && "prompts" in data ? data.prompts : undefined;
  if (!Array.isArray(list)) return { error: "Paste the text copied with Export." };
  if (list.length === 0) return { error: "There are no prompts to import." };
  if (list.length > MAX_PROMPTS) return { error: `Import at most ${MAX_PROMPTS} quick prompts.` };
  const prompts: ImportedPrompt[] = [];
  for (const [index, item] of list.entries()) {
    const parsed = ImportedPromptSchema.safeParse(item);
    if (!parsed.success) {
      return { error: `Prompt ${index + 1}: ${parsed.error.issues[0]?.message ?? "Invalid prompt"}` };
    }
    prompts.push(parsed.data);
  }
  return { prompts };
}

/**
 * Replaces the saved prompts with `imported`, or adds the ones not saved yet (same label and
 * prompt) after them. Adding does not apply when the result would be over the maximum.
 */
export function importPrompts(imported: ImportedPrompt[], replace: boolean): Edit {
  // Ids are made once so a retried save sends the same prompts. The index keeps them unique.
  const withIds = imported.map((prompt, index) => ({ id: newPromptId() + index.toString(36), ...prompt }));
  return (values) => {
    if (replace) return { ...values, prompts: withIds };
    const saved = new Set(values.prompts.map(({ label, text }) => JSON.stringify([label, text])));
    const added = withIds.filter(({ label, text }) => !saved.has(JSON.stringify([label, text])));
    return values.prompts.length + added.length <= MAX_PROMPTS ? { ...values, prompts: [...values.prompts, ...added] } : null;
  };
}
