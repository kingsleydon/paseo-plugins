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

/** Sized to the icon slot, as Paseo's own pills draw their loading spinner. */
function SpinnerIcon({ size, color }: PluginButtonIconProps) {
  return <ActivityIndicator size={size} color={color} />;
}

function pillButton({
  visible,
  label,
  icon,
  busy,
}: PillPresentation): Pick<PluginButton, "visible" | "label" | "icon"> {
  return { visible, label, icon: busy ? SpinnerIcon : icon };
}

export interface RecapPills {
  start(): void;
  stop(): void;
  refresh(): Promise<void>;
  /** Shows progress on an agent's pill while a manual recap request runs, then its result. */
  track<T>(agentId: string, request: Promise<T>): Promise<T>;
}

/**
 * Keeps one composer pill per agent in sync with daemon recaps. Recaps finish after an idle delay
 * without any agent update, so the list is also polled, faster right after agent activity.
 *
 * A factory rather than a class: plugin client bundles reach Hermes (iOS, Android) without Metro's
 * transforms, and Hermes rejects class syntax (getpaseo/paseo#5783).
 */
export function createRecapPills(client: PluginClientContext): RecapPills {
  const pills = new Map<string, PluginButtonRegistration>();
  const lifetime = new AbortController();
  let views = new Map<string, RecapView>();
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;
  let refreshing = false;
  let lastRefreshAt = 0;
  let activeUntil = 0;

  const render = (): void => {
    const now = Date.now();
    for (const [agentId, pill] of pills) {
      pill.update(pillButton(pillPresentation(views.get(agentId), now)));
    }
  };

  const refresh = async (): Promise<void> => {
    if (refreshing || lifetime.signal.aborted) return;
    refreshing = true;
    lastRefreshAt = Date.now();
    try {
      const { recaps } = await client.rpc(recapListRpc, {});
      views = new Map(recaps.map((view) => [view.agentId, view]));
      render();
    } catch (error) {
      console.error("[paseo-recap] failed to load recaps", error);
    } finally {
      refreshing = false;
    }
  };

  const track = async <T,>(agentId: string, request: Promise<T>): Promise<T> => {
    const view = views.get(agentId) ?? { agentId, recap: null, previous: [], error: null, state: "idle" };
    views.set(agentId, { ...view, state: "generating", error: null });
    render();
    try {
      return await request;
    } finally {
      void refresh();
    }
  };

  const popover = makeRecapPopover({ cachedView: (agentId) => views.get(agentId), track });

  const register = (agent: { id: string; workspaceId?: string | null }): void => {
    if (lifetime.signal.aborted || !agent.workspaceId) return;
    pills.get(agent.id)?.remove();
    const registration = client.addComposerPill({
      id: "recap",
      workspaceId: agent.workspaceId,
      agentId: agent.id,
      button: {
        title: "Session recap",
        ...pillButton(pillPresentation(views.get(agent.id), Date.now())),
        behavior: { kind: "popover", Content: popover },
      },
    });
    pills.set(agent.id, registration);
  };

  const remove = (agentId: string): void => {
    pills.get(agentId)?.remove();
    pills.delete(agentId);
  };

  const removeAll = (): void => {
    for (const pill of pills.values()) pill.remove();
    pills.clear();
  };

  const scheduleRefresh = (): void => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      void refresh();
    }, UPDATE_DEBOUNCE_MS);
  };

  const start = (): void => {
    client.paseo.agents
      .list({ subscribe: {}, signal: lifetime.signal })
      .then(({ subscription }) => {
        subscription.subscribe({
          snapshot: ({ entries }) => {
            removeAll();
            for (const { agent } of entries) register(agent);
            scheduleRefresh();
          },
          update: (message) => {
            if (message.type !== "agent_update") return;
            const update = message.payload;
            if (update.kind === "remove") remove(update.agentId);
            else if (!pills.has(update.agent.id)) register(update.agent);
            activeUntil = Date.now() + ACTIVE_WINDOW_MS;
            scheduleRefresh();
          },
        });
      })
      .catch((error: unknown) => {
        if (!lifetime.signal.aborted) console.error("[paseo-recap] agent observation failed", error);
      });
    poll = setInterval(() => {
      const now = Date.now();
      const pending = [...views.values()].some(isPending);
      if (pending || now < activeUntil || now - lastRefreshAt >= IDLE_POLL_MS) void refresh();
    }, TICK_MS);
  };

  const stop = (): void => {
    lifetime.abort();
    if (debounce) clearTimeout(debounce);
    if (poll) clearInterval(poll);
    removeAll();
  };

  return { start, stop, refresh, track };
}
