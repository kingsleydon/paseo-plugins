import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { PluginHookAgent, PluginTurnOutcome } from "@getpaseo/plugin/server";
import type { RecapSettings, RecapState, RecapView, StoredRecap } from "../shared/recap";
import { NoGeneratorError, RecapSkippedError } from "./errors";
import type { GeneratedRecap } from "./generators";
import { buildRecapInput, countUserTurns, isCompacting, latestActiveTask, trimForRecap } from "./history";
import { historyBudget, renderPrompt } from "./prompt";

export const MAX_CONSECUTIVE_FAILURES = 3;
export const RETRY_DELAY_MS = 30_000;
/**
 * A child agent blocks its parent's recap (its work is still landing) only this long; a child
 * whose turn-ended event never arrives must not suppress the parent forever.
 */
export const CHILD_BLOCK_MAX_MS = 10 * 60_000;

const GENERIC_FAILURE = "Could not generate a recap.";
const NO_GENERATOR =
  "No recap model is available. Log in to the claude or codex CLI, or pick a model in the plugin settings.";

export interface AgentContext {
  timeline: readonly AgentTimelineItem[];
  title: string | null;
  workspaceId: string | null;
  provider: string | null;
  /** Live status from the daemon; hook events alone can miss a turn's end. */
  running: boolean;
}

export interface GenerateOptions {
  /** Lets the generator prefer the agent's own provider. */
  agentProvider: string | null;
  /** Automatic recaps skip providers near their usage limit; manual ones do not. */
  trigger: Trigger;
}

export interface RecapStoreLike {
  get(agentId: string): StoredRecap | null;
  previous(agentId: string): StoredRecap[];
  all(): StoredRecap[];
  set(recap: StoredRecap): Promise<void>;
  markStale(agentId: string): Promise<void>;
  delete(agentId: string): Promise<void>;
}

export interface SchedulerDeps {
  store: RecapStoreLike;
  readSettings(): Promise<RecapSettings>;
  generate(prompt: string, signal: AbortSignal, options: GenerateOptions): Promise<GeneratedRecap>;
  /** Fresh timeline for manual recaps of agents this plugin has not observed yet. */
  fetchAgentContext(agentId: string): Promise<AgentContext>;
  /** Shows a newly stored recap in the agent's conversation. */
  publish(recap: StoredRecap): Promise<void>;
  log(message: string, detail?: unknown): void;
}

export type Trigger = "auto" | "manual";

interface AgentEntry {
  id: string;
  parentAgentId: string | null;
  workspaceId: string | null;
  provider: string | null;
  title: string | null;
  /** Incremented on every turn start; a recap is only kept for the revision it started on. */
  revision: number;
  running: boolean;
  /** Epoch ms when the current turn started; null while idle. */
  runningSince: number | null;
  lastTurnCompleted: boolean;
  /** Completed turns since the last stored recap; null until known (no recap observed yet). */
  turnsSinceRecap: number | null;
  /** User messages in the whole conversation (the kept timeline is trimmed). */
  userTurns: number;
  /** Trimmed to what a recap reads; see `trimForRecap`. */
  timeline: readonly AgentTimelineItem[] | null;
  pendingPermissions: Set<string>;
  runningChildren: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: { abort: AbortController; promise: Promise<void> } | null;
  failures: number;
  state: RecapState;
  error: string | null;
}

/**
 * Per-agent recap state machine: idle → waiting (delay) → generating → idle, reset by every turn
 * start. See docs/design.md §5.2–5.3 for the rules and the products they come from.
 */
export class RecapScheduler {
  readonly #deps: SchedulerDeps;
  readonly #entries = new Map<string, AgentEntry>();
  /** Manual requests in progress (fetch + generate), so repeated /recap calls share one run. */
  readonly #manual = new Map<string, Promise<RecapView>>();
  #disposed = false;

  constructor(deps: SchedulerDeps) {
    this.#deps = deps;
  }

  turnStarted(agent: PluginHookAgent): void {
    const entry = this.#entry(agent);
    entry.revision++;
    entry.running = true;
    entry.runningSince = Date.now();
    // A new turn means earlier requests were answered or abandoned.
    entry.pendingPermissions.clear();
    entry.lastTurnCompleted = false;
    entry.failures = 0;
    entry.error = null;
    entry.state = "idle";
    this.#cancel(entry);
    void this.#deps.store.markStale(entry.id);
    if (entry.parentAgentId) this.#entryById(entry.parentAgentId).runningChildren.add(entry.id);
  }

  async turnEnded(
    agent: PluginHookAgent,
    outcome: PluginTurnOutcome,
    timeline: readonly AgentTimelineItem[],
  ): Promise<void> {
    const entry = this.#entry(agent);
    entry.running = false;
    entry.runningSince = null;
    entry.timeline = trimForRecap(timeline);
    entry.userTurns = countUserTurns(timeline);
    entry.lastTurnCompleted = outcome.kind === "completed";
    if (entry.lastTurnCompleted && entry.turnsSinceRecap !== null) entry.turnsSinceRecap++;
    if (entry.parentAgentId) {
      const parent = this.#entryById(entry.parentAgentId);
      parent.runningChildren.delete(entry.id);
      // The parent may have been waiting only for this child.
      await this.#maybeSchedule(parent);
    }
    await this.#maybeSchedule(entry);
  }

  permissionRequested(agent: PluginHookAgent, requestId: string): void {
    const entry = this.#entry(agent);
    entry.pendingPermissions.add(requestId);
    this.#clearTimer(entry);
    if (entry.state === "waiting") entry.state = "idle";
  }

  async permissionResolved(agent: PluginHookAgent, requestId: string): Promise<void> {
    const entry = this.#entry(agent);
    entry.pendingPermissions.delete(requestId);
    // A request cleared without resuming the turn (e.g. dismissed while idle) re-arms the recap.
    if (!entry.running) await this.#maybeSchedule(entry);
  }

  async archived(agent: PluginHookAgent): Promise<void> {
    const entry = this.#entries.get(agent.id);
    if (entry) {
      this.#cancel(entry);
      this.#entries.delete(agent.id);
    }
    if (agent.parentAgentId) this.#entries.get(agent.parentAgentId)?.runningChildren.delete(agent.id);
    await this.#deps.store.delete(agent.id);
  }

  /** Manual recap: bypasses delay, frequency, and opt-out, but never runs during a turn. */
  regenerate(agentId: string): Promise<RecapView> {
    const pending = this.#manual.get(agentId);
    if (pending) return pending;
    const request = this.#regenerate(agentId).finally(() => this.#manual.delete(agentId));
    this.#manual.set(agentId, request);
    return request;
  }

  async #regenerate(agentId: string): Promise<RecapView> {
    const entry = this.#entryById(agentId);
    if (entry.inFlight) {
      // Codex reports "already generating"; joining the in-flight request gives the same result.
      await entry.inFlight.promise;
      return this.view(agentId);
    }
    this.#clearTimer(entry);
    entry.error = null;
    entry.state = "generating";
    let context: AgentContext;
    try {
      context = await this.#deps.fetchAgentContext(agentId);
    } catch (error) {
      entry.state = "error";
      entry.error = "Could not read the conversation.";
      this.#deps.log(`could not fetch timeline for agent ${agentId}`, errorText(error));
      return this.view(agentId);
    }
    entry.timeline = trimForRecap(context.timeline);
    entry.userTurns = countUserTurns(context.timeline);
    entry.title = context.title ?? entry.title;
    entry.workspaceId = context.workspaceId ?? entry.workspaceId;
    entry.provider = context.provider ?? entry.provider;
    // Trust the daemon's live status over hook bookkeeping, which can miss a turn's end.
    if (context.running) {
      entry.state = "idle";
      entry.error = "The agent is running. Try again when it is idle.";
      return this.view(agentId);
    }
    if (entry.running) {
      entry.running = false;
      entry.runningSince = null;
    }
    await this.#run(entry, "manual");
    return this.view(agentId);
  }

  view(agentId: string): RecapView {
    const entry = this.#entries.get(agentId);
    return {
      agentId,
      state: entry?.state ?? "idle",
      recap: this.#deps.store.get(agentId),
      previous: this.#deps.store.previous(agentId),
      error: entry?.error ?? null,
    };
  }

  list(): RecapView[] {
    const ids = new Set<string>([
      ...this.#deps.store.all().map((recap) => recap.agentId),
      ...[...this.#entries.values()]
        .filter((entry) => entry.state !== "idle" || entry.error !== null)
        .map((entry) => entry.id),
    ]);
    return [...ids].map((id) => this.view(id));
  }

  dispose(): void {
    this.#disposed = true;
    for (const entry of this.#entries.values()) this.#cancel(entry);
    this.#entries.clear();
  }

  async #maybeSchedule(entry: AgentEntry, delayMs?: number): Promise<void> {
    const settings = await this.#deps.readSettings();
    if (!this.#eligible(entry, settings)) {
      this.#recheckAfterChildBlock(entry, settings);
      return;
    }
    this.#clearTimer(entry);
    const revision = entry.revision;
    entry.state = "waiting";
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void this.#fire(entry, revision);
    }, delayMs ?? settings.idleDelaySeconds * 1000);
  }

  async #fire(entry: AgentEntry, revision: number): Promise<void> {
    if (this.#disposed || entry.revision !== revision || entry.running) return;
    // Re-check: settings, permissions, or children may have changed during the delay.
    const settings = await this.#deps.readSettings();
    if (!this.#eligible(entry, settings)) {
      if (entry.state === "waiting") entry.state = entry.error ? "error" : "idle";
      this.#recheckAfterChildBlock(entry, settings);
      return;
    }
    await this.#run(entry, "auto");
  }

  /**
   * A child that never reports its turn end blocks its parent for at most CHILD_BLOCK_MAX_MS. No
   * event marks that deadline, so check again when it passes.
   */
  #recheckAfterChildBlock(entry: AgentEntry, settings: RecapSettings): void {
    if (!settings.waitForSubagents || entry.timer || !this.#hasBlockingChild(entry)) return;
    const now = Date.now();
    let blockEndsAt = now;
    for (const childId of entry.runningChildren) {
      const since = this.#entries.get(childId)?.runningSince;
      if (since != null) blockEndsAt = Math.max(blockEndsAt, since + CHILD_BLOCK_MAX_MS);
    }
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void this.#maybeSchedule(entry);
    }, blockEndsAt - now);
  }

  #eligible(entry: AgentEntry, settings: RecapSettings): boolean {
    if (this.#disposed || !settings.autoRecap) return false;
    if (entry.parentAgentId && !settings.includeSubagents) return false;
    if (entry.running || !entry.lastTurnCompleted || entry.inFlight) return false;
    if (entry.pendingPermissions.size > 0) return false;
    if (settings.waitForSubagents && this.#hasBlockingChild(entry)) return false;
    if (entry.failures >= MAX_CONSECUTIVE_FAILURES || !entry.timeline) return false;
    if (isCompacting(entry.timeline)) return false;
    if (entry.userTurns < settings.minTurns) return false;
    // Without an observed recap (fresh agent or daemon restart), recap the next completed turn.
    return entry.turnsSinceRecap === null || entry.turnsSinceRecap >= settings.turnsBetweenRecaps;
  }

  #run(entry: AgentEntry, trigger: Trigger): Promise<void> {
    const abort = new AbortController();
    const promise = this.#generate(entry, trigger, abort).finally(() => {
      if (entry.inFlight?.abort === abort) entry.inFlight = null;
    });
    entry.inFlight = { abort, promise };
    return promise;
  }

  async #generate(entry: AgentEntry, trigger: Trigger, abort: AbortController): Promise<void> {
    const revision = entry.revision;
    const { historyExchanges } = await this.#deps.readSettings();
    // A turn may have started while settings loaded; it has already reset this entry.
    if (abort.signal.aborted || entry.revision !== revision || this.#disposed) return;
    const timeline = entry.timeline ?? [];
    const context = { goal: entry.title, activeTask: latestActiveTask(timeline) };
    const input = buildRecapInput(timeline, historyBudget(context), historyExchanges);
    if (input.history === "") {
      entry.state = "idle";
      entry.error = trigger === "manual" ? "There is no conversation to recap yet." : null;
      return;
    }
    entry.state = "generating";
    entry.error = null;
    try {
      const generated = await this.#deps.generate(renderPrompt(input.history, context), abort.signal, {
        agentProvider: entry.provider,
        trigger,
      });
      // Never paint a stale recap: drop results that land after a new turn started.
      if (abort.signal.aborted || entry.revision !== revision || this.#disposed) return;
      const recap: StoredRecap = {
        agentId: entry.id,
        summary: generated.summary,
        nextAction: generated.nextAction,
        generatedAt: new Date().toISOString(),
        revision,
        turnCount: entry.userTurns,
        stale: false,
        trigger,
        generator: { provider: generated.provider, model: generated.model },
        agent: { title: entry.title, workspaceId: entry.workspaceId, provider: entry.provider },
      };
      await this.#deps.store.set(recap);
      entry.failures = 0;
      entry.turnsSinceRecap = 0;
      entry.state = "idle";
      await this.#deps.publish(recap).catch((error: unknown) => {
        this.#deps.log(`could not show recap for agent ${entry.id}`, errorText(error));
      });
    } catch (error) {
      if (abort.signal.aborted || entry.revision !== revision) return;
      if (error instanceof RecapSkippedError) {
        // Deliberate skip (usage limits): not a failure, nothing to retry or show.
        entry.state = "idle";
        this.#deps.log(`recap skipped for agent ${entry.id}`, error.message);
        return;
      }
      if (error instanceof NoGeneratorError) {
        // Retrying cannot help until the user fixes their setup; stop for this turn.
        entry.failures = MAX_CONSECUTIVE_FAILURES;
        entry.state = "error";
        entry.error = NO_GENERATOR;
        return;
      }
      entry.failures++;
      entry.state = "error";
      entry.error = GENERIC_FAILURE;
      this.#deps.log(`recap failed for agent ${entry.id}`, errorText(error));
      // Release the in-flight slot first; eligibility rejects agents with work in flight.
      if (entry.inFlight?.abort === abort) entry.inFlight = null;
      if (trigger === "auto" && entry.failures < MAX_CONSECUTIVE_FAILURES) {
        await this.#maybeSchedule(entry, RETRY_DELAY_MS);
      }
    }
  }

  #hasBlockingChild(entry: AgentEntry): boolean {
    const now = Date.now();
    for (const childId of entry.runningChildren) {
      const child = this.#entries.get(childId);
      if (child?.running && child.runningSince !== null && now - child.runningSince < CHILD_BLOCK_MAX_MS) {
        return true;
      }
    }
    return false;
  }

  #cancel(entry: AgentEntry): void {
    this.#clearTimer(entry);
    entry.inFlight?.abort.abort();
    entry.inFlight = null;
  }

  #clearTimer(entry: AgentEntry): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
  }

  #entry(agent: PluginHookAgent): AgentEntry {
    const entry = this.#entryById(agent.id);
    entry.parentAgentId = agent.parentAgentId;
    entry.workspaceId = agent.workspaceId ?? entry.workspaceId;
    entry.provider = agent.provider;
    entry.title = agent.title ?? entry.title;
    return entry;
  }

  #entryById(id: string): AgentEntry {
    let entry = this.#entries.get(id);
    if (!entry) {
      entry = {
        id,
        parentAgentId: null,
        workspaceId: null,
        provider: null,
        title: null,
        revision: 0,
        running: false,
        runningSince: null,
        lastTurnCompleted: false,
        turnsSinceRecap: null,
        userTurns: 0,
        timeline: null,
        pendingPermissions: new Set(),
        runningChildren: new Set(),
        timer: null,
        inFlight: null,
        failures: 0,
        state: "idle",
        error: null,
      };
      this.#entries.set(id, entry);
    }
    return entry;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
