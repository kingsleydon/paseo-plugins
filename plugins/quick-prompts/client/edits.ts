import { settingsRpc } from "@getpaseo/plugin";
import { MAX_PROMPTS, quickPromptsSettings, type PromptDisplay, type QuickPrompt, type QuickPromptsSettings } from "../shared/prompts";

export const settingsContract = settingsRpc(quickPromptsSettings.id);

/** Saved values with the revision they were read or written at. */
export interface SettingsDoc {
  values: QuickPromptsSettings;
  revision: string;
}

/** One change, applied to whichever values are latest. `null` means it no longer applies. */
export type Edit = (values: QuickPromptsSettings) => QuickPromptsSettings | null;

export function updatePrompt(id: string, field: "label" | "text", value: string): Edit {
  return (values) =>
    values.prompts.some((prompt) => prompt.id === id)
      ? { ...values, prompts: values.prompts.map((prompt) => (prompt.id === id ? { ...prompt, [field]: value } : prompt)) }
      : null;
}

export function movePrompt(id: string, offset: -1 | 1): Edit {
  return (values) => {
    const index = values.prompts.findIndex((prompt) => prompt.id === id);
    const target = index + offset;
    if (index < 0 || target < 0 || target >= values.prompts.length) return null;
    const prompts = [...values.prompts];
    const [moved] = prompts.splice(index, 1);
    if (moved) prompts.splice(target, 0, moved);
    return { ...values, prompts };
  };
}

export function deletePrompt(id: string): Edit {
  return (values) =>
    values.prompts.some((prompt) => prompt.id === id)
      ? { ...values, prompts: values.prompts.filter((prompt) => prompt.id !== id) }
      : null;
}

export function addPrompt(prompt: QuickPrompt): Edit {
  return (values) => (values.prompts.length < MAX_PROMPTS ? { ...values, prompts: [...values.prompts, prompt] } : null);
}

export function setDisplay(display: PromptDisplay): Edit {
  return (values) => ({ ...values, display });
}

export function setSendRightAway(sendRightAway: boolean): Edit {
  return (values) => ({ ...values, sendRightAway });
}

/** The edit applied to `values`, or `null` when it no longer applies or the result would not save. */
export function applyEdit(edit: Edit, values: QuickPromptsSettings): QuickPromptsSettings | null {
  const next = edit(values);
  return next ? (quickPromptsSettings.schema.safeParse(next).data ?? null) : null;
}
