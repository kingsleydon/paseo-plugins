import type { PluginClientContext } from "@getpaseo/plugin/client";
import { RecapLine } from "./client/recap-line";
import { createRecapPills } from "./client/pills";
import { RecapSettingsScreen } from "./client/settings-screen";
import { RECAP_TIMELINE_KIND, RecapTimelineDataSchema, recapRegenerateRpc } from "./shared/recap";

export default function contribute(client: PluginClientContext) {
  const pills = createRecapPills(client);
  pills.start();

  const removeTimelineRenderer = client.addTimelineRenderer({
    kind: RECAP_TIMELINE_KIND,
    version: 1,
    schema: RecapTimelineDataSchema,
    Component: RecapLine,
  });

  const removeSettings = client.addSettingsScreen({
    id: "recap",
    title: "Recap",
    icon: "ScrollText",
    Component: RecapSettingsScreen,
  });

  const removeCommand = client.addSlashCommand({
    // Not "recap": plugin commands take precedence over provider commands, and Claude Code agents
    // already offer their own /recap.
    name: "paseo-recap",
    description: "Summarize where this agent stands",
    argumentHint: "",
    context: "agent",
    async onSubmit({ agent, rpc }) {
      // The pill shows progress; the RPC resolves once the recap is written.
      const view = await pills.track(agent.id, rpc(recapRegenerateRpc, { agentId: agent.id }));
      if (view.error) throw new Error(view.error);
    },
  });

  return () => {
    removeTimelineRenderer();
    removeSettings();
    removeCommand();
    pills.stop();
  };
}
