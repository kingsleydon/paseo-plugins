import type { PluginClientContext } from "@getpaseo/plugin/client";
import { followAgents, followPrompts } from "./client/follow";
import { createPromptPills } from "./client/pills";
import { QuickPromptsSettingsScreen } from "./client/settings-screen";

const SETTINGS_SCREEN_ID = "quick-prompts";

export default function contribute(client: PluginClientContext) {
  const removeSettings = client.addSettingsScreen({
    id: SETTINGS_SCREEN_ID,
    title: "Quick prompts",
    icon: "Zap",
    Component: QuickPromptsSettingsScreen,
  });

  const pills = createPromptPills({
    addComposerPill: (contribution) => client.addComposerPill(contribution),
    send: (agentId, text) => client.paseo.agents.ref(agentId).send(text),
    openSettings: () => client.openSettings(SETTINGS_SCREEN_ID),
  });
  const lifetime = new AbortController();
  followAgents(client, pills, lifetime.signal);
  followPrompts(client, pills, lifetime.signal);

  return () => {
    lifetime.abort();
    pills.removeAll();
    removeSettings();
  };
}
