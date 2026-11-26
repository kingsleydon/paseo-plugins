import type {
  PluginButton,
  PluginButtonIconProps,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { ActivityIndicator } from "react-native";
import type { RecapEvent, RecapView } from "../shared/recap";
import { pillPresentation, type PillPresentation } from "./format";
import { makeRecapPopover } from "./recap-card";
import { subscribeToRecaps } from "./recap-subscription";

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
}

/**
 * Keeps composer pills and their popovers in sync over one subscription per host.
 *
 * A factory rather than a class: plugin client bundles reach Hermes (iOS, Android) without Metro's
 * transforms, and Hermes rejects class syntax (getpaseo/paseo#5783).
 */
export function createRecapPills(client: PluginClientContext): RecapPills {
  const pills = new Map<string, PluginButtonRegistration>();
  const lifetime = new AbortController();
  const listeners = new Set<() => void>();
  let views: Map<string, RecapView> | undefined;
  let ageTimer: ReturnType<typeof setInterval> | undefined;

  const render = (agentId: string): void => {
    pills.get(agentId)?.update(pillButton(pillPresentation(views?.get(agentId), Date.now())));
  };

  const update = (event: RecapEvent): void => {
    if (event.type === "snapshot") {
      views = new Map(event.recaps.map((view) => [view.agentId, view]));
      for (const agentId of pills.keys()) render(agentId);
    } else {
      const { view } = event;
      if (view.recap || view.state !== "idle" || view.error) views?.set(view.agentId, view);
      else views?.delete(view.agentId);
      render(view.agentId);
    }
    for (const listener of listeners) listener();
  };

  const popover = makeRecapPopover({
    getView: (agentId) => views ? (views.get(agentId) ?? null) : undefined,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  });

  const register = (agent: { id: string; workspaceId?: string | null }): void => {
    if (lifetime.signal.aborted || !agent.workspaceId) return;
    pills.get(agent.id)?.remove();
    const registration = client.addComposerPill({
      id: "recap",
      workspaceId: agent.workspaceId,
      agentId: agent.id,
      button: {
        title: "Session recap",
        ...pillButton(pillPresentation(views?.get(agent.id), Date.now())),
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

  const start = (): void => {
    subscribeToRecaps(client, update, lifetime.signal);
    client.paseo.agents
      .list({ subscribe: {}, signal: lifetime.signal })
      .then(({ subscription }) => {
        if (lifetime.signal.aborted) return subscription.release();
        subscription.subscribe({
          snapshot: ({ entries }) => {
            removeAll();
            for (const { agent } of entries) register(agent);
          },
          update: (message) => {
            if (message.type !== "agent_update") return;
            const update = message.payload;
            if (update.kind === "remove") remove(update.agentId);
            else if (!pills.has(update.agent.id)) register(update.agent);
          },
        });
      })
      .catch((error: unknown) => {
        if (!lifetime.signal.aborted) console.error("[paseo-recap] agent observation failed", error);
      });
    // Keep the displayed ages current without requesting data from the daemon.
    ageTimer = setInterval(() => {
      for (const [agentId, view] of views ?? []) {
        if (view.recap) render(agentId);
      }
    }, 60_000);
  };

  const stop = (): void => {
    lifetime.abort();
    clearInterval(ageTimer);
    removeAll();
  };

  return { start, stop };
}
