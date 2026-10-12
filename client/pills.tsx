import type {
  PluginButton,
  PluginButtonIconProps,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { ActivityIndicator } from "react-native";
import { recapListRpc, type RecapView } from "../shared/recap";
import { isPending, pillPresentation, type PillPresentation } from "./format";
import { makeRecapPopover } from "./recap-card";

const TICK_MS = 2_000;
const IDLE_POLL_MS = 30_000;
/** After agent activity, poll every tick: a recap lands a few seconds after the idle delay. */
const ACTIVE_WINDOW_MS = 30_000;
const UPDATE_DEBOUNCE_MS = 1_000;

/** The spinner Paseo itself shows while loading (a small ActivityIndicator). */
function SpinnerIcon({ color }: PluginButtonIconProps) {
  return <ActivityIndicator size="small" color={color} />;
}

function pillButton({
  visible,
  label,
  icon,
  busy,
}: PillPresentation): Pick<PluginButton, "visible" | "label" | "icon"> {
  return { visible, label, icon: busy ? SpinnerIcon : icon };
}

/**
 * Keeps one composer pill per agent in sync with daemon recaps. Recaps finish after an idle delay
 * without any agent update, so the list is also polled, faster right after agent activity.
 */
export class RecapPills {
  readonly #client: PluginClientContext;
  readonly #pills = new Map<string, PluginButtonRegistration>();
  readonly #lifetime = new AbortController();
  #views = new Map<string, RecapView>();
  #debounce: ReturnType<typeof setTimeout> | null = null;
  #poll: ReturnType<typeof setInterval> | null = null;
  #refreshing = false;
  #lastRefreshAt = 0;
  #activeUntil = 0;
  readonly #popover = makeRecapPopover((agentId, request) => this.track(agentId, request));

  constructor(client: PluginClientContext) {
    this.#client = client;
  }

  start(): void {
    this.#client.paseo.agents
      .list({ subscribe: {}, signal: this.#lifetime.signal })
      .then(({ subscription }) => {
        subscription.subscribe({
          snapshot: ({ entries }) => {
            this.#removeAll();
            for (const { agent } of entries) this.#register(agent);
            this.#scheduleRefresh();
          },
          update: (message) => {
            if (message.type !== "agent_update") return;
            const update = message.payload;
            if (update.kind === "remove") this.#remove(update.agentId);
            else if (!this.#pills.has(update.agent.id)) this.#register(update.agent);
            this.#activeUntil = Date.now() + ACTIVE_WINDOW_MS;
            this.#scheduleRefresh();
          },
        });
      })
      .catch((error: unknown) => {
        if (!this.#lifetime.signal.aborted) console.error("[paseo-recap] agent observation failed", error);
      });
    this.#poll = setInterval(() => {
      const now = Date.now();
      const pending = [...this.#views.values()].some(isPending);
      if (pending || now < this.#activeUntil || now - this.#lastRefreshAt >= IDLE_POLL_MS) {
        void this.refresh();
      }
    }, TICK_MS);
  }

  async refresh(): Promise<void> {
    if (this.#refreshing || this.#lifetime.signal.aborted) return;
    this.#refreshing = true;
    this.#lastRefreshAt = Date.now();
    try {
      const { recaps } = await this.#client.rpc(recapListRpc, {});
      this.#views = new Map(recaps.map((view) => [view.agentId, view]));
      this.#render();
    } catch (error) {
      console.error("[paseo-recap] failed to load recaps", error);
    } finally {
      this.#refreshing = false;
    }
  }

  /** Shows progress on an agent's pill while a manual recap request runs, then its result. */
  async track<T>(agentId: string, request: Promise<T>): Promise<T> {
    const view = this.#views.get(agentId) ?? { agentId, recap: null, previous: [], error: null, state: "idle" };
    this.#views.set(agentId, { ...view, state: "generating", error: null });
    this.#render();
    try {
      return await request;
    } finally {
      void this.refresh();
    }
  }

  stop(): void {
    this.#lifetime.abort();
    if (this.#debounce) clearTimeout(this.#debounce);
    if (this.#poll) clearInterval(this.#poll);
    this.#removeAll();
  }

  #register(agent: { id: string; workspaceId?: string | null }): void {
    if (this.#lifetime.signal.aborted || !agent.workspaceId) return;
    this.#pills.get(agent.id)?.remove();
    const registration = this.#client.addComposerPill({
      id: "recap",
      workspaceId: agent.workspaceId,
      agentId: agent.id,
      button: {
        title: "Session recap",
        ...pillButton(pillPresentation(this.#views.get(agent.id), Date.now())),
        behavior: { kind: "popover", Content: this.#popover },
      },
    });
    this.#pills.set(agent.id, registration);
  }

  #render(): void {
    const now = Date.now();
    for (const [agentId, pill] of this.#pills) {
      pill.update(pillButton(pillPresentation(this.#views.get(agentId), now)));
    }
  }

  #scheduleRefresh(): void {
    if (this.#debounce) clearTimeout(this.#debounce);
    this.#debounce = setTimeout(() => {
      this.#debounce = null;
      void this.refresh();
    }, UPDATE_DEBOUNCE_MS);
  }

  #remove(agentId: string): void {
    this.#pills.get(agentId)?.remove();
    this.#pills.delete(agentId);
  }

  #removeAll(): void {
    for (const pill of this.#pills.values()) pill.remove();
    this.#pills.clear();
  }
}
