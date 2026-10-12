import { isRecapProvider, RECAP_PROVIDERS, type ModelPlan, type ModelRef, type RecapView } from "../shared/recap";

export function relativeTime(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(seconds) || seconds < 60) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export interface PillPresentation {
  visible: boolean;
  label: string;
  /** Lucide icon name; ignored while `busy`, when the pill shows a spinner instead. */
  icon: string;
  busy: boolean;
}

export function pillPresentation(view: RecapView | undefined, now: number): PillPresentation {
  if (view?.state === "generating") return { visible: true, label: "Recap…", icon: "ScrollText", busy: true };
  // Shown even before the first recap, so agents that predate the plugin can get one in a tap.
  if (!view?.recap) return { visible: true, label: "Recap", icon: "ScrollText", busy: false };
  return {
    visible: true,
    label: `Recap · ${relativeTime(view.recap.generatedAt, now)}`,
    icon: view.recap.stale ? "History" : "ScrollText",
    busy: false,
  };
}

/** A recap is on its way: worth polling closely so the pill never lingers on stale progress. */
export function isPending(view: RecapView): boolean {
  return view.state === "waiting" || view.state === "generating";
}

function providerLabel(provider: string): string {
  return isRecapProvider(provider) ? RECAP_PROVIDERS[provider].label : provider;
}

function modelName({ provider, model }: ModelRef): string {
  return `${providerLabel(provider)} ${model ?? "default model"}`;
}

/** Plain-language list of the models a setting resolves to, e.g. "Claude haiku, then Codex gpt-6-luna." */
export function describePlan(plan: ModelPlan): string {
  const order = plan.fallback.map(modelName).join(", then ");
  if (plan.perProvider.length === 0) {
    return order === "" ? "No supported model. Install and log in to claude, codex, or opencode." : `${order}.`;
  }
  const own = plan.perProvider
    .map((ref) => `${providerLabel(ref.provider)} agents: ${modelName(ref)}.`)
    .join(" ");
  return order === "" ? own : `${own} Other agents, or if that fails: ${order}.`;
}
