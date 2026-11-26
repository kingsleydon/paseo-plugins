import type { PluginServerContext } from "@getpaseo/plugin/server";
import { mkdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { errorMessage, RecapSkippedError } from "./server/errors";
import { RecapGenerator } from "./server/generators";
import { describeModelPlan, resolveCandidates, type GeneratorInputs } from "./server/models";
import type { PaseoApi } from "./server/paseo-types";
import { runProcess } from "./server/process";
import { createRecapStream } from "./server/recap-stream";
import { RecapScheduler } from "./server/scheduler";
import { RecapStore } from "./server/store";
import { UsageGuard } from "./server/usage";
import {
  RECAP_TIMELINE_KIND,
  recapGetRpc,
  recapListRpc,
  recapModelPlanRpc,
  recapRegenerateRpc,
  recapSettings,
  recapSubscription,
  type RecapSettings,
  type RecapTimelineData,
} from "./shared/recap";

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
  const store = new RecapStore(() => requirePaseo().agents, storePath(), log);
  const stream = createRecapStream();
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

  const readGeneratorInputs = async (api: PaseoApi): Promise<GeneratorInputs> => {
    const [{ config }, { entries }] = await Promise.all([api.config.get(), api.providers.snapshot()]);
    return {
      config: { metadataGeneration: config.metadataGeneration, providers: config.providers },
      providers: entries,
    };
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
    onChange: stream.update,
    log,
    async generate(prompt, signal, { agentProvider, trigger }) {
      const [inputs, current] = await Promise.all([readGeneratorInputs(requirePaseo()), readSettings()]);
      let candidates = resolveCandidates(current.generator, inputs, agentProvider);
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

  let ready: Promise<void> | undefined;
  const initialize = (api: PaseoApi): Promise<void> => {
    paseo = api;
    // The SDK supplies the connection with the first hook or client request.
    ready ??= (async () => {
      await mkdir(tempRoot, { recursive: true, mode: 0o700 });
      await store.load();
    })().catch((error: unknown) => {
      ready = undefined;
      log("startup failed", errorMessage(error));
      throw error;
    });
    return ready;
  };

  const unsubscribers = [
    server.addHook("agent.turn.before", async ({ agent }, { paseo }) => {
      await initialize(paseo);
      scheduler.turnStarted(agent);
    }),
    server.addHook("agent.turn.after", async ({ agent, outcome }, { paseo }) => {
      await initialize(paseo);
      await scheduler.turnEnded(agent, outcome);
    }),
    server.addHook("agent.permission.before", async ({ agent, request }, { paseo }) => {
      await initialize(paseo);
      scheduler.permissionRequested(agent, request.id);
    }),
    server.addHook("agent.permission.after", async ({ agent, requestId }, { paseo }) => {
      await initialize(paseo);
      await scheduler.permissionResolved(agent, requestId);
    }),
    server.addHook("agent.archive.after", async ({ agent }, { paseo }) => {
      await initialize(paseo);
      await scheduler.archived(agent);
    }),
  ];

  server.handle(recapGetRpc, async ({ agentId }, { paseo }) => {
    await initialize(paseo);
    return scheduler.view(agentId);
  });
  server.handle(recapListRpc, async (_input, { paseo }) => {
    await initialize(paseo);
    return { recaps: scheduler.list() };
  });
  server.handle(recapSubscription, async (_input, { paseo, push, signal }) => {
    await initialize(paseo);
    await stream.subscribe(() => scheduler.list(), push, signal);
  });
  server.handle(recapModelPlanRpc, async ({ generator }, { paseo }) => {
    await initialize(paseo);
    return describeModelPlan(generator, await readGeneratorInputs(paseo));
  });
  server.handle(recapRegenerateRpc, async ({ agentId }, { paseo }) => {
    try {
      await initialize(paseo);
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
