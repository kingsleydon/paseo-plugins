import type { PluginHookContext, PluginLifecycleEvents } from "@getpaseo/plugin/server";

// Paseo resolves only its plugin SDK when it builds a plugin, so `@getpaseo/client` and
// `@getpaseo/protocol` cannot be imported, even for types. These come from the SDK instead.

export type PaseoApi = PluginHookContext["paseo"];
export type AgentTimelineItem = PluginLifecycleEvents["agent.turn_ended"]["timeline"][number];
export type ProviderSnapshotEntry = Awaited<ReturnType<PaseoApi["providers"]["snapshot"]>>["entries"][number];
