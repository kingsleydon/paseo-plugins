import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { mkdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  recapGetRpc,
  recapListRpc,
  recapModelPlanRpc,
  recapRegenerateRpc,
  RECAP_TIMELINE_KIND,
  recapSettings,
  type RecapSettings,
  type RecapTimelineData,
} from "./shared/recap";
import { errorMessage, RecapSkippedError } from "./server/errors";
import { RecapGenerator } from "./server/generators";
import { describeModelPlan, resolveCandidates, type GeneratorConfig } from "./server/models";
import { runProcess } from "./server/process";
import { RecapScheduler } from "./server/scheduler";
import { RecapStore } from "./server/store";
import { UsageGuard } from "./server/usage";

const TIMELINE_FETCH_LIMIT = 500;

function log(message: string, detail?: unknown): void {
  if (detail === undefined) console.error(`[paseo-recap] ${message}`);
  else console.error(`[paseo-recap] ${message}:`, detail);
}

function storePath(): string {
  const paseoHome = process.env.PASEO_HOME ?? join(homedir(), ".paseo");
  return join(paseoHome, "plugin-data", "paseo-recap", "recaps.json");
}

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(recapSettings);
  const store = new RecapStore(storePath(), log);
  const tempRoot = join(tmpdir(), "paseo-recap");
  const generator = new RecapGenerator({ runProcess, env: process.env, tempRoot, now: Date.now, log });
  const usage = new UsageGuard(
    async () => (await requirePaseo().providers.listUsage()).providers,
    Date.now,
    log,
  );
  // The API handle arrives with hook and RPC contexts; timers fire later and reuse the latest one.
  let paseo: PaseoApi | null = null;
  const requirePaseo = (): PaseoApi => {
    if (!paseo) throw new Error("Paseo API is not available yet");
    return paseo;
  };

  const readGeneratorConfig = async (api: PaseoApi): Promise<GeneratorConfig> => {
    const { config } = await api.config.get();
    return { metadataGeneration: config.metadataGeneration, providers: config.providers };
  };

  const readSettings = async (): Promise<RecapSettings> => {
    const state = await settings.read();
    if (state.status === "ready") return state.values;
    log("settings are invalid; using defaults", state.error);
    return recapSettings.schema.parse({});
  };

  const scheduler = new RecapScheduler({
    store,
    readSettings,
    log,
    async generate(prompt, signal, { agentProvider, trigger }) {
      const [config, current] = await Promise.all([readGeneratorConfig(requirePaseo()), readSettings()]);
      let candidates = resolveCandidates(current.generator, config, agentProvider);
      if (trigger === "auto" && candidates.length > 0) {
        const nearLimit = await usage.nearLimit();
        const allowed = candidates.filter((candidate) => !nearLimit.has(candidate.provider));
        if (allowed.length === 0) throw new RecapSkippedError("recap models are near their usage limit");
        candidates = allowed;
      }
      return generator.generate(prompt, candidates, signal);
    },
    async fetchAgentContext(agentId) {
      const payload = await requirePaseo().agents.ref(agentId).timeline.refetch({
        direction: "tail",
        projection: "canonical",
        limit: TIMELINE_FETCH_LIMIT,
      });
      if (payload.error) throw new Error(payload.error);
      return {
        timeline: payload.entries.map((entry) => entry.item),
        title: payload.agent?.title ?? null,
        workspaceId: payload.agent?.workspaceId ?? null,
        provider: payload.agent?.provider ?? null,
        running: payload.agent?.status === "running",
      };
    },
    async publish(recap) {
      const data: RecapTimelineData = { summary: recap.summary, nextAction: recap.nextAction };
      await requirePaseo().agents.ref(recap.agentId).timeline.append({
        type: "plugin",
        // One row per recap, so each lands after the turn it summarizes.
        id: `recap:${recap.generatedAt}`,
        kind: RECAP_TIMELINE_KIND,
        version: 1,
        data,
      });
    },
  });

  const ready = Promise.all([
    store.load(),
    mkdir(tempRoot, { recursive: true, mode: 0o700 }),
  ]).catch((error: unknown) => log("startup failed", errorMessage(error)));

  const unsubscribers = [
    server.on("agent.turn_started", async ({ agent }, context) => {
      paseo = context.paseo;
      await ready;
      scheduler.turnStarted(agent);
    }),
    server.on("agent.turn_ended", async ({ agent, outcome, timeline }, context) => {
      paseo = context.paseo;
      await ready;
      await scheduler.turnEnded(agent, outcome, timeline);
    }),
    server.on("agent.permission_requested", ({ agent, request }) => {
      scheduler.permissionRequested(agent, request.id);
    }),
    server.on("agent.permission_resolved", async ({ agent, requestId }) => {
      await ready;
      await scheduler.permissionResolved(agent, requestId);
    }),
    server.on("agent.archived", async ({ agent }) => {
      await ready;
      await scheduler.archived(agent);
    }),
  ];

  server.handle(recapGetRpc, async ({ agentId }, context) => {
    paseo = context.paseo;
    await ready;
    return scheduler.view(agentId);
  });
  server.handle(recapListRpc, async (_input, context) => {
    paseo = context.paseo;
    await ready;
    return { recaps: scheduler.list() };
  });
  server.handle(recapModelPlanRpc, async ({ generator }, context) => {
    paseo = context.paseo;
    return describeModelPlan(generator, await readGeneratorConfig(context.paseo));
  });
  server.handle(recapRegenerateRpc, async ({ agentId }, context) => {
    paseo = context.paseo;
    await ready;
    try {
      return await scheduler.regenerate(agentId);
    } catch (error) {
      log(`manual recap failed for agent ${agentId}`, errorMessage(error));
      return { ...scheduler.view(agentId), state: "error" as const, error: "Could not generate a recap." };
    }
  });

  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
    scheduler.dispose();
  };
}
