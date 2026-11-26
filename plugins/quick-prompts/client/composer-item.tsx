import { useComposer, useSettings, type PluginComposerItemProps } from "@getpaseo/plugin/client";
import { Action, Combobox } from "@getpaseo/plugin/client/ui";
import type { ComponentType } from "react";
import { quickPromptsSettings } from "../shared/prompts";
import { composerControlView, insertPrompt, searchPrompts, type PromptItem } from "./composer-control";

/**
 * The "Quick prompts" composer control: a searchable list of the saved prompts that inserts the
 * chosen one at the cursor, or an "Add quick prompt" action when none are saved.
 */
export function createQuickPromptsControl(openSettings: () => void): ComponentType<PluginComposerItemProps> {
  return function QuickPromptsControl() {
    const composer = useComposer();
    const view = composerControlView(useSettings(quickPromptsSettings));
    if (view.kind === "hidden") return null;
    if (view.kind === "add") return <Action title="Add quick prompt" icon="Plus" onPress={openSettings} />;
    return (
      <Combobox<PromptItem>
        title="Quick prompts"
        icon="Zap"
        value={null}
        search={async ({ query }) => searchPrompts(view.prompts, query)}
        onSelect={({ item }) => insertPrompt(composer, item.text)}
      />
    );
  };
}
