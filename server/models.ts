import {
  isRecapProvider,
  RECAP_PROVIDERS,
  type GeneratorChoice,
  type GeneratorMode,
  type ModelPlan,
  type ModelRef,
  type RecapProvider,
} from "../shared/recap";
import { asRecord } from "./json";

export interface GeneratorCandidate {
  provider: RecapProvider;
  model: string | null;
  /** Executable followed by fixed leading arguments. */
  command: readonly [string, ...string[]];
}

/** Subset of daemon config read here; validated loosely because provider entries are open-ended. */
export interface GeneratorConfig {
  metadataGeneration?: { providers?: ReadonlyArray<{ provider: string; model?: string }> };
  providers?: Record<string, unknown>;
}

/** Each provider with its recap model; tried after Paseo's metadata order, as Paseo does for its own one-shot text. */
const DEFAULT_ORDER: readonly GeneratorChoice[] = (["claude", "codex"] as const).map((provider) => ({
  provider,
  model: RECAP_PROVIDERS[provider].defaultModel,
}));

/**
 * Orders recap generators. In `auto`, the agent's own provider goes first — Claude Code, Codex, and
 * OMP all recap with the session's provider, and it keeps the conversation with the vendor the user
 * already chose for that agent.
 */
export function resolveCandidates(
  choice: GeneratorMode | GeneratorChoice,
  config: GeneratorConfig,
  agentProvider: string | null = null,
): GeneratorCandidate[] {
  const paseoOrder = [...(config.metadataGeneration?.providers ?? []), ...DEFAULT_ORDER];
  let ordered: readonly GeneratorChoice[];
  if (choice === "auto") {
    const own =
      agentProvider && isRecapProvider(agentProvider)
        ? [{ provider: agentProvider, model: RECAP_PROVIDERS[agentProvider].defaultModel ?? undefined }]
        : [];
    ordered = [...own, ...paseoOrder];
  } else if (choice === "metadata") {
    ordered = paseoOrder;
  } else {
    ordered = [choice];
  }
  const seen = new Set<string>();
  const candidates: GeneratorCandidate[] = [];
  for (const entry of ordered) {
    if (!isRecapProvider(entry.provider)) continue;
    const providerConfig = asRecord(config.providers?.[entry.provider]);
    if (providerConfig?.enabled === false) continue;
    const model = entry.model ?? null;
    const key = `${entry.provider}\u0000${model ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      provider: entry.provider,
      model,
      command: configuredCommand(providerConfig?.command) ?? [entry.provider],
    });
  }
  return candidates;
}

/** Which models a setting resolves to, for the settings screen. Availability is checked at run time. */
export function describeModelPlan(choice: GeneratorMode | GeneratorChoice, config: GeneratorConfig): ModelPlan {
  const refs = (candidates: readonly GeneratorCandidate[]): ModelRef[] =>
    candidates.map(({ provider, model }) => ({ provider, model }));
  const fallback = refs(resolveCandidates(choice === "auto" ? "metadata" : choice, config));
  if (choice !== "auto") return { perProvider: [], fallback };
  const perProvider = (Object.keys(RECAP_PROVIDERS) as RecapProvider[]).flatMap((provider) =>
    refs(resolveCandidates("auto", config, provider).slice(0, 1)).filter((ref) => ref.provider === provider),
  );
  return { perProvider, fallback };
}

function configuredCommand(value: unknown): readonly [string, ...string[]] | null {
  if (typeof value === "string" && value.trim() !== "") return [value];
  if (!Array.isArray(value)) return null;
  const parts = value.filter((part): part is string => typeof part === "string");
  const [first, ...rest] = parts;
  return parts.length === value.length && first ? [first, ...rest] : null;
}
