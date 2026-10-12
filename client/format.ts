import type { RecapView } from "../shared/recap";

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
  icon: string;
}

export function pillPresentation(view: RecapView | undefined, now: number): PillPresentation {
  if (view?.state === "generating") return { visible: true, label: "Recap…", icon: "LoaderCircle" };
  if (!view?.recap) return { visible: false, label: "Recap", icon: "ScrollText" };
  return {
    visible: true,
    label: `Recap · ${relativeTime(view.recap.generatedAt, now)}`,
    icon: view.recap.stale ? "History" : "ScrollText",
  };
}
