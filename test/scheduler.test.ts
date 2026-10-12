import type { PluginHookAgent } from "@getpaseo/plugin/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recapSettings, type RecapSettings, type StoredRecap } from "../shared/recap";
import type { GeneratedRecap } from "../server/generators";
import type { AgentTimelineItem } from "../server/paseo-types";
import { NoGeneratorError, RecapSkippedError } from "../server/errors";
import {
  CHILD_BLOCK_MAX_MS,
  RecapScheduler,
  RETRY_DELAY_MS,
  type AgentContext,
  type GenerateOptions,
  type RecapStoreLike,
} from "../server/scheduler";

const DELAY_MS = 120_000;

function agent(id: string, parentAgentId: string | null = null): PluginHookAgent {
  return { id, workspaceId: "ws", parentAgentId, provider: "claude", cwd: "/repo", title: "Ship recaps" };
}

function turns(count: number): AgentTimelineItem[] {
  return Array.from({ length: count }, (_, index): AgentTimelineItem[] => [
    { type: "user_message", text: `request ${index}` },
    { type: "assistant_message", text: `reply ${index}` },
  ]).flat();
}

class MemoryStore implements RecapStoreLike {
  readonly recaps = new Map<string, StoredRecap>();
  get(agentId: string) {
    return this.recaps.get(agentId) ?? null;
  }
  previous() {
    return [];
  }
  all() {
    return [...this.recaps.values()];
  }
  async set(recap: StoredRecap) {
    this.recaps.set(recap.agentId, recap);
  }
  async markStale(agentId: string) {
    const recap = this.recaps.get(agentId);
    if (recap) this.recaps.set(agentId, { ...recap, stale: true });
  }
  async delete(agentId: string) {
    this.recaps.delete(agentId);
  }
}

/** Scenario settings: slower and gated, so each rule can be exercised on its own. */
const GATED: Partial<RecapSettings> = { idleDelaySeconds: 120, minTurns: 3, turnsBetweenRecaps: 2 };
/** Default wait, but no progress gate, for scenarios that only need one turn. */
const EVERY_TURN: Partial<RecapSettings> = { minTurns: 1, turnsBetweenRecaps: 1 };

function setup(overrides: Partial<RecapSettings> = GATED) {
  const store = new MemoryStore();
  const settings: RecapSettings = { ...recapSettings.schema.parse({}), ...overrides };
  const generate = vi.fn(
    async (_prompt: string, _signal: AbortSignal, _options: GenerateOptions): Promise<GeneratedRecap> => ({
      summary: "Recap text.",
      nextAction: null,
      provider: "claude",
      model: "haiku",
    }),
  );
  const fetchAgentContext = vi.fn(async (): Promise<AgentContext> => ({
    timeline: turns(1),
    title: "Fetched",
    workspaceId: "ws-fetched",
    provider: "codex",
    running: false,
  }));
  const publish = vi.fn(async (_recap: StoredRecap) => undefined);
  const scheduler = new RecapScheduler({
    store,
    generate,
    readSettings: async () => settings,
    fetchAgentContext,
    publish,
    log: () => undefined,
  });
  return { store, generate, scheduler, settings, fetchAgentContext, publish };
}

async function endTurn(scheduler: RecapScheduler, a: PluginHookAgent, timeline: AgentTimelineItem[]) {
  scheduler.turnStarted(a);
  await scheduler.turnEnded(a, { kind: "completed" }, timeline);
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("RecapScheduler", () => {
  it("by default recaps after 3 messages, then every completed turn, 10 seconds after each", async () => {
    const { scheduler, generate } = setup({});
    await endTurn(scheduler, agent("a"), turns(2));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(generate).not.toHaveBeenCalled();

    await endTurn(scheduler, agent("a"), turns(3));
    await vi.advanceTimersByTimeAsync(9_999);
    expect(generate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(generate).toHaveBeenCalledOnce();

    // A turn without a new user message (e.g. resumed after a permission) still counts.
    await endTurn(scheduler, agent("a"), turns(3));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("by default recaps a parent while its subagent is still running", async () => {
    const { scheduler, generate } = setup({});
    scheduler.turnStarted(agent("child", "p"));
    await endTurn(scheduler, agent("p"), turns(3));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(generate).toHaveBeenCalledOnce();
  });

  it("generates immediately with a zero idle delay", async () => {
    const { scheduler, generate } = setup({ ...EVERY_TURN, idleDelaySeconds: 0 });
    await endTurn(scheduler, agent("a"), turns(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(generate).toHaveBeenCalledOnce();
  });

  it("generates after the idle delay once enough turns have happened", async () => {
    const { scheduler, generate, store, publish } = setup();
    await endTurn(scheduler, agent("a"), turns(2));
    await vi.advanceTimersByTimeAsync(DELAY_MS);
    expect(generate).not.toHaveBeenCalled();

    await endTurn(scheduler, agent("a"), turns(3));
    expect(scheduler.view("a").state).toBe("waiting");
    await vi.advanceTimersByTimeAsync(DELAY_MS - 1);
    expect(generate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(generate).toHaveBeenCalledOnce();
    expect(store.get("a")).toMatchObject({ summary: "Recap text.", turnCount: 3, stale: false });
    expect(generate.mock.calls[0]?.[0]).toContain("Overall goal: Ship recaps");
    expect(publish).toHaveBeenCalledWith(store.get("a"));
  });

  it("keeps a stored recap when showing it in the conversation fails", async () => {
    const { scheduler, store, publish } = setup(EVERY_TURN);
    publish.mockRejectedValueOnce(new Error("timeline unavailable"));
    await endTurn(scheduler, agent("a"), turns(1));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(store.get("a")?.summary).toBe("Recap text.");
    expect(scheduler.view("a")).toMatchObject({ state: "idle", error: null });
  });

  it("waits turnsBetweenRecaps completed turns before recapping again", async () => {
    const { scheduler, generate } = setup();
    await endTurn(scheduler, agent("a"), turns(3));
    await vi.advanceTimersByTimeAsync(DELAY_MS);
    await endTurn(scheduler, agent("a"), turns(4));
    await vi.advanceTimersByTimeAsync(DELAY_MS);
    expect(generate).toHaveBeenCalledOnce();
    await endTurn(scheduler, agent("a"), turns(5));
    await vi.advanceTimersByTimeAsync(DELAY_MS);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("cancels the timer and marks the recap stale when a new turn starts", async () => {
    const { scheduler, generate, store } = setup();
    await endTurn(scheduler, agent("a"), turns(3));
    await vi.advanceTimersByTimeAsync(DELAY_MS);
    await scheduler.turnEnded(agent("a"), { kind: "completed" }, turns(5));
    scheduler.turnStarted(agent("a"));
    expect(store.get("a")?.stale).toBe(true);
    await vi.advanceTimersByTimeAsync(DELAY_MS * 2);
    expect(generate).toHaveBeenCalledOnce();
  });

  it("discards a result when a turn starts during generation", async () => {
    const { scheduler, generate, store, publish } = setup();
    let release: () => void = () => undefined;
    generate.mockImplementationOnce(
      (_prompt, signal) =>
        new Promise((resolve, reject) => {
          release = () =>
            resolve({ summary: "late", nextAction: null, provider: "claude", model: null });
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    await endTurn(scheduler, agent("a"), turns(3));
    await vi.advanceTimersByTimeAsync(DELAY_MS);
    expect(scheduler.view("a").state).toBe("generating");
    scheduler.turnStarted(agent("a"));
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.get("a")).toBeNull();
    expect(publish).not.toHaveBeenCalled();
    expect(scheduler.view("a").state).toBe("idle");
  });

  it("skips canceled turns, pending permissions, and running subagents when waiting for them", async () => {
    const { scheduler, generate } = setup({ ...GATED, waitForSubagents: true });
    scheduler.turnStarted(agent("a"));
    await scheduler.turnEnded(agent("a"), { kind: "canceled", reason: "user" }, turns(3));
    await vi.advanceTimersByTimeAsync(DELAY_MS);
    expect(generate).not.toHaveBeenCalled();

    scheduler.turnStarted(agent("b"));
    scheduler.permissionRequested(agent("b"), "req-1");
    await scheduler.turnEnded(agent("b"), { kind: "completed" }, turns(3));
    await vi.advanceTimersByTimeAsync(DELAY_MS);
    expect(generate).not.toHaveBeenCalled();

    scheduler.turnStarted(agent("child", "c"));
    await endTurn(scheduler, agent("c"), turns(3));
    await vi.advanceTimersByTimeAsync(DELAY_MS);
    expect(generate).not.toHaveBeenCalled();
    await scheduler.turnEnded(agent("child", "c"), { kind: "completed" }, turns(1));
    await vi.advanceTimersByTimeAsync(DELAY_MS);
    expect(generate).toHaveBeenCalledOnce();
  });

  it("does not recap subagents unless enabled", async () => {
    const { scheduler, generate } = setup();
    await endTurn(scheduler, agent("child", "parent"), turns(3));
    await vi.advanceTimersByTimeAsync(DELAY_MS);
    expect(generate).not.toHaveBeenCalled();
  });

  it("retries automatic failures, then gives up after three", async () => {
    const { scheduler, generate } = setup();
    generate.mockRejectedValue(new Error("boom"));
    await endTurn(scheduler, agent("a"), turns(3));
    await vi.advanceTimersByTimeAsync(DELAY_MS);
    // A retry is queued; the error stays visible meanwhile.
    expect(scheduler.view("a")).toMatchObject({ state: "waiting", error: "Could not generate a recap." });
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS * 5);
    expect(generate).toHaveBeenCalledTimes(3);
    expect(scheduler.view("a").state).toBe("error");
  });

  it("regenerates manually from a fetched timeline, bypassing gates", async () => {
    const { scheduler, generate, store } = setup({ ...GATED, autoRecap: false });
    const view = await scheduler.regenerate("x");
    expect(generate).toHaveBeenCalledOnce();
    expect(view.recap).toMatchObject({ trigger: "manual", turnCount: 1 });
    expect(store.get("x")).not.toBeNull();
    expect(generate.mock.calls[0]?.[0]).toContain("Overall goal: Fetched");
  });

  it("refuses manual recaps while the daemon reports the agent running", async () => {
    const { scheduler, generate, fetchAgentContext } = setup();
    fetchAgentContext.mockResolvedValueOnce({
      timeline: turns(1),
      title: null,
      workspaceId: null,
      provider: null,
      running: true,
    });
    const view = await scheduler.regenerate("a");
    expect(generate).not.toHaveBeenCalled();
    expect(view.error).toMatch(/running/);
  });

  it("recovers from a missed turn-ended event on manual recaps", async () => {
    const { scheduler, generate } = setup();
    scheduler.turnStarted(agent("a"));
    const view = await scheduler.regenerate("a");
    expect(generate).toHaveBeenCalledOnce();
    expect(view.recap).not.toBeNull();
  });

  it("forgets archived agents", async () => {
    const { scheduler, store } = setup();
    await scheduler.regenerate("a");
    await scheduler.archived(agent("a"));
    expect(store.get("a")).toBeNull();
    expect(scheduler.list()).toEqual([]);
  });
  it("passes the agent's provider to the generator and records agent context", async () => {
    const { scheduler, generate, store } = setup(EVERY_TURN);
    await endTurn(scheduler, { ...agent("a"), provider: "codex" }, turns(1));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(generate.mock.calls[0]?.[2]).toEqual({ agentProvider: "codex", trigger: "auto" });
    expect(store.get("a")?.agent).toEqual({ title: "Ship recaps", workspaceId: "ws", provider: "codex" });
  });

  it("counts user turns over the full timeline while keeping only recent exchanges", async () => {
    const { scheduler, generate, store } = setup(EVERY_TURN);
    await endTurn(scheduler, agent("a"), turns(30));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(store.get("a")?.turnCount).toBe(30);
    const prompt = generate.mock.calls[0]?.[0] ?? "";
    expect(prompt).toContain("request 29");
    expect(prompt).not.toContain("request 21\n");
  });

  it("skips while the provider is compacting context", async () => {
    const { scheduler, generate } = setup(EVERY_TURN);
    const compacting: AgentTimelineItem[] = [...turns(2), { type: "compaction", status: "loading" }];
    await endTurn(scheduler, agent("a"), compacting);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(generate).not.toHaveBeenCalled();
  });

  it("re-arms when a pending permission is cleared while idle", async () => {
    const { scheduler, generate } = setup(EVERY_TURN);
    scheduler.turnStarted(agent("a"));
    scheduler.permissionRequested(agent("a"), "req");
    await scheduler.turnEnded(agent("a"), { kind: "completed" }, turns(1));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(generate).not.toHaveBeenCalled();
    await scheduler.permissionResolved(agent("a"), "req");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(generate).toHaveBeenCalledOnce();
  });

  it("cancels a pending recap when a permission request arrives during the wait", async () => {
    const { scheduler, generate } = setup(EVERY_TURN);
    await endTurn(scheduler, agent("a"), turns(1));
    scheduler.permissionRequested(agent("a"), "req");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(generate).not.toHaveBeenCalled();
  });

  it("respects settings changed during the wait", async () => {
    const { scheduler, generate, settings } = setup(EVERY_TURN);
    await endTurn(scheduler, agent("a"), turns(1));
    settings.autoRecap = false;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(generate).not.toHaveBeenCalled();
    expect(scheduler.view("a").state).toBe("idle");
  });

  it("shares one run between concurrent manual requests", async () => {
    const { scheduler, generate, fetchAgentContext } = setup(EVERY_TURN);
    const [first, second] = await Promise.all([scheduler.regenerate("x"), scheduler.regenerate("x")]);
    expect(fetchAgentContext).toHaveBeenCalledOnce();
    expect(generate).toHaveBeenCalledOnce();
    expect(first.recap).toEqual(second.recap);
    expect(first.recap?.agent).toEqual({ title: "Fetched", workspaceId: "ws-fetched", provider: "codex" });
  });

  it("reports a timeline fetch failure on manual recaps", async () => {
    const { scheduler, generate, fetchAgentContext } = setup(EVERY_TURN);
    fetchAgentContext.mockRejectedValueOnce(new Error("offline"));
    const view = await scheduler.regenerate("x");
    expect(generate).not.toHaveBeenCalled();
    expect(view).toMatchObject({ state: "error", error: "Could not read the conversation." });
  });

  it("reports an empty conversation on manual recaps", async () => {
    const { scheduler, generate, fetchAgentContext } = setup(EVERY_TURN);
    fetchAgentContext.mockResolvedValueOnce({
      timeline: [],
      title: null,
      workspaceId: null,
      provider: null,
      running: false,
    });
    const view = await scheduler.regenerate("x");
    expect(generate).not.toHaveBeenCalled();
    expect(view.error).toBe("There is no conversation to recap yet.");
  });

  it("stops scheduling after dispose", async () => {
    const { scheduler, generate } = setup(EVERY_TURN);
    await endTurn(scheduler, agent("a"), turns(1));
    scheduler.dispose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(generate).not.toHaveBeenCalled();
  });
  it("stops blocking the parent when a child never reports its turn end", async () => {
    const { scheduler, generate } = setup({ ...EVERY_TURN, waitForSubagents: true });
    scheduler.turnStarted(agent("child", "p"));
    await endTurn(scheduler, agent("p"), turns(1));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(generate).not.toHaveBeenCalled();
    // No further events: the parent is recapped once the block expires.
    await vi.advanceTimersByTimeAsync(CHILD_BLOCK_MAX_MS - 60_000 + 10_000);
    expect(generate).toHaveBeenCalledOnce();
  });

  it("explains a missing recap model and does not retry", async () => {
    const { scheduler, generate } = setup(EVERY_TURN);
    generate.mockRejectedValue(new NoGeneratorError());
    await endTurn(scheduler, agent("a"), turns(1));
    await vi.advanceTimersByTimeAsync(10_000 + RETRY_DELAY_MS * 3);
    expect(generate).toHaveBeenCalledOnce();
    expect(scheduler.view("a")).toMatchObject({ state: "error", error: expect.stringMatching(/No recap model/) });
  });

  it("treats usage-limit skips as silent, not as failures", async () => {
    const { scheduler, generate } = setup(EVERY_TURN);
    generate.mockRejectedValueOnce(new RecapSkippedError("near limit"));
    await endTurn(scheduler, agent("a"), turns(1));
    await vi.advanceTimersByTimeAsync(10_000 + RETRY_DELAY_MS);
    expect(generate).toHaveBeenCalledOnce();
    expect(scheduler.view("a")).toMatchObject({ state: "idle", error: null });
    await endTurn(scheduler, agent("a"), turns(2));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("clears pending permissions when a new turn starts", async () => {
    const { scheduler, generate } = setup(EVERY_TURN);
    scheduler.permissionRequested(agent("a"), "abandoned");
    await endTurn(scheduler, agent("a"), turns(1));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(generate).toHaveBeenCalledOnce();
  });
});
