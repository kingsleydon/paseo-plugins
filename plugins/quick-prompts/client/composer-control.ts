import type { PluginComposer } from "@getpaseo/plugin/client";
import type { QuickPrompt } from "../shared/prompts";

/** What the composer control shows for a settings read. */
export type ComposerControlView =
  /** Nothing yet, or the prompts could not be read: render nothing rather than a wrong state. */
  | { kind: "hidden" }
  | { kind: "add" }
  | { kind: "prompts"; prompts: readonly QuickPrompt[] };

/** Saved settings that fail validation count as no prompts, as they do for the pills. */
export function composerControlView(
  settings: { status: "loading" | "error" | "invalid" } | { status: "ready"; values: { prompts: readonly QuickPrompt[] } },
): ComposerControlView {
  if (settings.status === "loading" || settings.status === "error") return { kind: "hidden" };
  const prompts = settings.status === "ready" ? settings.values.prompts : [];
  return prompts.length === 0 ? { kind: "add" } : { kind: "prompts", prompts };
}

/** One row of the control's list; `text` rides along to `onSelect`. */
export interface PromptItem {
  id: string;
  label: string;
  description: string;
  text: string;
}

const DESCRIPTION_LENGTH = 80;

function preview(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > DESCRIPTION_LENGTH ? `${line.slice(0, DESCRIPTION_LENGTH - 1)}…` : line;
}

/** The saved prompts, in order, whose label or text contains the query (any case). */
export function searchPrompts(prompts: readonly QuickPrompt[], query: string): PromptItem[] {
  const needle = query.trim().toLowerCase();
  return prompts
    .filter(({ label, text }) => needle === "" || `${label}\n${text}`.toLowerCase().includes(needle))
    .map(({ id, label, text }) => ({ id, label, description: preview(text), text }));
}

/** Puts the prompt at the cursor without sending it, then hands the cursor back to the user. */
export async function insertPrompt(composer: Pick<PluginComposer, "insertText" | "focus">, text: string): Promise<void> {
  composer.insertText(text);
  await composer.focus();
}
