import type { PluginHooks, PluginServerContext } from "@getpaseo/plugin/server";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import contribute from "../index.server";
import { recapSubscription, type RecapEvent } from "../shared/recap";
import { makeRecap } from "./fixtures";

function setup() {
  const hooks = new Map<keyof PluginHooks, unknown>();
  const rpcs = new Map<string, unknown>();
  function unsupported(): never {
    throw new Error("Unexpected API call while registering Recap");
  }
  const server: PluginServerContext = {
    addHook(name, handler) {
      hooks.set(name, handler);
      return () => { hooks.delete(name); };
    },
    handle(contract, handler) {
      rpcs.set(contract.name, handler);
    },
    registerSettings: () => ({ read: unsupported, subscribe: unsupported }),
    registerProvider: unsupported,
    registerUsageSource: unsupported,
    registerWorktreeManager: unsupported,
    on: unsupported,
    before: unsupported,
  };

  function invoke(handler: unknown, input: unknown, context: unknown): unknown {
    if (typeof handler !== "function") throw new Error("Missing Recap handler");
    return handler(input, context);
  }
  return { hooks, rpcs, invoke, dispose: contribute(server) };
}

it("registers and releases the Paseo 0.16 lifecycle hooks", () => {
  const { hooks, dispose } = setup();
  try {
    expect([...hooks.keys()]).toEqual([
      "agent.turn.before",
      "agent.turn.after",
      "agent.permission.before",
      "agent.permission.after",
      "agent.archive.after",
    ]);
  } finally {
    dispose();
  }
  expect(hooks.size).toBe(0);
});

it("keeps hooks and RPCs available after a load failure and pushes recovered recaps", async () => {
  const dir = await mkdtemp(join(tmpdir(), "recap-startup-"));
  vi.useFakeTimers();
  for (const key of ["PASEO_HOME", "TMPDIR", "TMP", "TEMP"]) vi.stubEnv(key, dir);
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const { hooks, rpcs, invoke, dispose } = setup();
  const lifetime = new AbortController();
  try {
    const agent = { id: "a", workspaceId: "ws", parentAgentId: null, provider: "claude" };
    const latest = makeRecap({ generatedAt: new Date().toISOString() });
    const list = vi.fn()
      .mockRejectedValueOnce(new Error("daemon connection lost"))
      .mockRejectedValueOnce(new Error("daemon still unavailable"))
      .mockResolvedValue({
        entries: [{ agent: { ...agent, metadata: { "paseo-recap": { version: 1, latest, previous: [] } } } }],
        pageInfo: { nextCursor: null },
      });
    const context = { paseo: { agents: { list, ref: () => ({ setMetadata: async () => undefined }) } } };
    const events: RecapEvent[] = [];
    const subscribed = Promise.resolve(invoke(rpcs.get(recapSubscription.name), {}, {
      ...context, signal: lifetime.signal, push: async (event: RecapEvent) => { events.push(event); },
    }));

    try {
      await vi.waitFor(() => expect(events).toEqual([{ type: "snapshot", recaps: [] }]));
      await invoke(hooks.get("agent.turn.before"), { agent, turnId: "next" }, context);
      expect(await invoke(rpcs.get("recap.get"), { agentId: "a" }, context)).toMatchObject({ recap: null });
      expect(await invoke(rpcs.get("recap.list"), {}, context)).toEqual({ recaps: [] });
      expect(list).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(2));
      await vi.advanceTimersByTimeAsync(1_500);
      expect(list).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(500);
      await vi.waitFor(() => expect(events.at(-1)).toMatchObject({
        type: "update", view: { agentId: "a", recap: { ...latest, stale: true } },
      }));
      expect(list).toHaveBeenCalledTimes(3);
    } finally {
      lifetime.abort();
      await subscribed;
    }
  } finally {
    dispose();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  }
});
