import type {
  PluginButton,
  PluginButtonRegistration,
  PluginComposer,
  PluginComposerPillContribution,
  PluginComposerSelector,
} from "@getpaseo/plugin/client";
import type { QuickPrompt, QuickPromptsSettings } from "../shared/prompts";

const ADD_PILL_ID = "add-quick-prompt";
const MENU_PILL_ID = "quick-prompts";

export interface PromptPillHost {
  addComposerPill(contribution: PluginComposerPillContribution): PluginButtonRegistration;
  send(agentId: string, text: string): Promise<void>;
  /** Puts the text in the agent's composer without sending it. */
  insert(agentId: string, text: string): Promise<void>;
  openSettings(): void;
}

/**
 * Inserts the text at the cursor of the agent's composer and focuses it. Rejects when Paseo has no
 * composer for the agent or the composer refuses the text or focus; the pill shows that in a toast.
 */
export async function insertIntoComposer(
  composers: (selector: PluginComposerSelector) => readonly Pick<PluginComposer, "insertText" | "focus">[],
  agentId: string,
  text: string,
): Promise<void> {
  const [composer] = composers({ agentId });
  if (!composer) throw new Error("This agent's composer is not available.");
  composer.insertText(text);
  await composer.focus();
}

export interface PillAgent {
  id: string;
  workspaceId?: string | null;
  archivedAt?: string | null;
}

export interface PromptPills {
  setSettings(settings: QuickPromptsSettings): void;
  /** Replaces the agent list with a full snapshot. */
  setAgents(agents: readonly PillAgent[]): void;
  upsertAgent(agent: PillAgent): void;
  removeAgent(agentId: string): void;
  removeAll(): void;
}

/** A pill an agent should show; `content` changes whenever its button does. */
interface PillSpec {
  id: string;
  content: string;
  button(agentId: string): PluginButton;
}

interface Pill {
  id: string;
  content: string;
  registration: PluginButtonRegistration;
}

interface AgentPills {
  workspaceId: string;
  pills: Pill[];
}

/**
 * Keeps one composer pill per saved prompt on every agent, a single "Prompts" pill whose menu
 * lists them, or a single "Add quick prompt" pill when none are saved. Pills whose order is
 * unchanged update in place; a reorder, addition, removal, or display switch re-registers that
 * agent's pills, because registration order is display order.
 *
 * A factory rather than a class: plugin client bundles reach Hermes (iOS, Android) without Metro's
 * transforms, and Hermes rejects class syntax (getpaseo/paseo#5783).
 */
export function createPromptPills(host: PromptPillHost): PromptPills {
  /** Null until the first read, so agents do not flash the "Add quick prompt" pill. */
  let specs: readonly PillSpec[] | null = null;
  /** Agents that get pills, by id, with their workspace. */
  const targets = new Map<string, string>();
  const registered = new Map<string, AgentPills>();
  /**
   * Sends and inserts in flight by agent, prompt, and action. Kept outside the registrations, which a
   * reorder or display switch replaces, so a replacement pill cannot repeat a prompt before the first
   * press settles.
   */
  const pending = new Map<string, Promise<void>>();

  const run = (agentId: string, prompt: QuickPrompt, sendRightAway: boolean): Promise<void> => {
    const key = JSON.stringify([agentId, prompt.id, sendRightAway]);
    const current = pending.get(key);
    if (current) return current;
    const press = sendRightAway ? host.send(agentId, prompt.text) : host.insert(agentId, prompt.text);
    const next = press.finally(() => pending.delete(key));
    pending.set(key, next);
    return next;
  };

  const addSpec: PillSpec = {
    id: ADD_PILL_ID,
    content: "",
    button: () => ({
      title: "Add a quick prompt in settings",
      icon: "Plus",
      label: "Add quick prompt",
      behavior: { kind: "action", onPress: () => host.openSettings() },
    }),
  };

  const promptSpec = (prompt: QuickPrompt, sendRightAway: boolean): PillSpec => ({
    id: `prompt-${prompt.id}`,
    content: JSON.stringify([prompt.label, prompt.text, sendRightAway]),
    button: (agentId) => ({
      title: `${sendRightAway ? "Send" : "Insert"} quick prompt: ${prompt.label}`,
      icon: "Zap",
      label: prompt.label,
      // Paseo marks the pill busy until the press settles and shows a failure in a toast.
      behavior: { kind: "action", onPress: () => run(agentId, prompt, sendRightAway) },
    }),
  });

  const menuSpec = (prompts: readonly QuickPrompt[], sendRightAway: boolean): PillSpec => ({
    id: MENU_PILL_ID,
    content: JSON.stringify([prompts, sendRightAway]),
    button: (agentId) => ({
      title: sendRightAway ? "Send a quick prompt" : "Insert a quick prompt",
      icon: "Zap",
      label: "Prompts",
      behavior: {
        kind: "menu",
        items: [
          ...prompts.map((prompt) => ({
            kind: "item" as const,
            id: `prompt-${prompt.id}`,
            title: prompt.label,
            behavior: { kind: "action" as const, onPress: () => run(agentId, prompt, sendRightAway) },
          })),
          { kind: "separator", id: "manage-divider" },
          {
            kind: "item",
            id: "manage",
            title: "Manage prompts",
            icon: "Settings",
            behavior: { kind: "action", onPress: () => host.openSettings() },
          },
        ],
      },
    }),
  });

  const clear = (agentId: string): void => {
    for (const pill of registered.get(agentId)?.pills ?? []) pill.registration.remove();
    registered.delete(agentId);
  };

  const sync = (agentId: string, workspaceId: string): void => {
    if (specs === null) return;
    const next = specs;
    const current = registered.get(agentId);
    const sameOrder =
      current?.workspaceId === workspaceId &&
      current.pills.length === next.length &&
      current.pills.every((pill, index) => pill.id === next[index]?.id);
    if (current && sameOrder) {
      current.pills.forEach((pill, index) => {
        const spec = next[index];
        if (!spec || pill.content === spec.content) return;
        pill.content = spec.content;
        // The full button, so a menu gets its complete new behavior.
        pill.registration.update(spec.button(agentId));
      });
      return;
    }
    clear(agentId);
    registered.set(agentId, {
      workspaceId,
      pills: next.map(({ id, content, button }) => {
        const registration = host.addComposerPill({ id, workspaceId, agentId, button: button(agentId) });
        return { id, content, registration };
      }),
    });
  };

  const removeAgent = (agentId: string): void => {
    targets.delete(agentId);
    clear(agentId);
  };

  const upsertAgent = (agent: PillAgent): void => {
    if (!agent.workspaceId || agent.archivedAt) return removeAgent(agent.id);
    targets.set(agent.id, agent.workspaceId);
    sync(agent.id, agent.workspaceId);
  };

  return {
    setSettings({ prompts, display, sendRightAway }) {
      if (prompts.length === 0) specs = [addSpec];
      else if (display === "menu") specs = [menuSpec(prompts, sendRightAway)];
      else specs = prompts.map((prompt) => promptSpec(prompt, sendRightAway));
      for (const [agentId, workspaceId] of targets) sync(agentId, workspaceId);
    },
    setAgents(list) {
      const ids = new Set(list.map(({ id }) => id));
      for (const agentId of [...targets.keys()]) if (!ids.has(agentId)) removeAgent(agentId);
      for (const agent of list) upsertAgent(agent);
    },
    upsertAgent,
    removeAgent,
    removeAll() {
      for (const agentId of [...targets.keys()]) removeAgent(agentId);
    },
  };
}
