import type { PluginHookContext } from "@getpaseo/plugin/server";

// Paseo resolves only its plugin SDK when it builds a plugin, so `@getpaseo/client` and
// `@getpaseo/protocol` cannot be imported, even for types. These come from the SDK instead.

export type PaseoApi = PluginHookContext["paseo"];
type AgentHandle = ReturnType<PaseoApi["agents"]["ref"]>;
type Timeline = Awaited<ReturnType<AgentHandle["timeline"]["refetch"]>>;
export type AgentTimelineItem = Timeline["entries"][number]["item"];
export type ProviderSnapshotEntry = Awaited<ReturnType<PaseoApi["providers"]["snapshot"]>>["entries"][number];
