import {
  isRecapProvider,
  type GeneratorChoice,
  type GeneratorMode,
  type ModelPlan,
  type ModelRef,
  type RecapProvider,
} from "../shared/recap";
import { asRecord } from "./json";

/**
 * Paseo's built-in small models for one-shot text, tried after the configured metadata models.
 * Mirrors DEFAULT_STRUCTURED_GENERATION_PROVIDERS in Paseo's server, which plugins cannot import.
 * Each entry matches an installed model whose id or label contains it.
 */
const PASEO_SMALL_MODELS = ["haiku", "gpt-5.4-mini", "minimax-m3", "nemotron-3-super"] as const;

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

/** The parts of a Paseo provider snapshot entry that model selection reads. */
export interface ProviderModels {
  provider: string;
  enabled: boolean;
  models?: ReadonlyArray<{ id: string; label: string; isDefault?: boolean }>;
}

export interface GeneratorInputs {
  config: GeneratorConfig;
  /** `paseo.providers.snapshot().entries`: the providers and models installed on this host. */
  providers: readonly ProviderModels[];
}

/**
 * Orders recap models the way Paseo picks a model for metadata generation: the configured metadata
 * models, then Paseo's small models that are installed. Unlike Paseo, the agent's own model is never
 * a last resort, so a recap does not run on a large model. `auto` puts the agent's own provider first
 * when it has one of those small models, keeping the conversation with the vendor already in use.
 */
export function resolveCandidates(
  choice: GeneratorMode | GeneratorChoice,
  inputs: GeneratorInputs,
  agentProvider: string | null = null,
): GeneratorCandidate[] {
  const runnable = inputs.providers.filter(
    (entry): entry is ProviderModels & { provider: RecapProvider } =>
      entry.enabled && isRecapProvider(entry.provider),
  );
  const byProvider = new Map<string, ProviderModels>(runnable.map((entry) => [entry.provider, entry]));
  let ordered: ModelRef[];
  if (typeof choice === "object") {
    const entry = byProvider.get(choice.provider);
    ordered = [{ provider: choice.provider, model: choice.model ?? (entry ? smallModel(entry) : null) }];
  } else {
    const own = agentProvider ? byProvider.get(agentProvider) : undefined;
    const ownSmall = own ? smallModel(own) : null;
    ordered = [
      ...(choice === "auto" && own && ownSmall ? [{ provider: own.provider, model: ownSmall }] : []),
      ...configuredModels(inputs.config, byProvider),
      ...PASEO_SMALL_MODELS.flatMap((needle) => {
        for (const entry of runnable) {
          const model = entry.models?.find((candidate) => matches(candidate, needle));
          if (model) return [{ provider: entry.provider, model: model.id }];
        }
        return [];
      }),
    ];
  }
  const seen = new Set<string>();
  const candidates: GeneratorCandidate[] = [];
  for (const { provider, model } of ordered) {
    if (!isRecapProvider(provider)) continue;
    const key = `${provider}\u0000${model ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const providerConfig = asRecord(inputs.config.providers?.[provider]);
    candidates.push({ provider, model, command: configuredCommand(providerConfig?.command) ?? [provider] });
  }
  return candidates;
}

/** Which models a setting resolves to, for the settings screen. Availability is checked at run time. */
export function describeModelPlan(choice: GeneratorMode | GeneratorChoice, inputs: GeneratorInputs): ModelPlan {
  const refs = (candidates: readonly GeneratorCandidate[]): ModelRef[] =>
    candidates.map(({ provider, model }) => ({ provider, model }));
  const fallback = refs(resolveCandidates(choice === "auto" ? "metadata" : choice, inputs));
  if (choice !== "auto") return { perProvider: [], fallback };
  // What each provider's agents try first; a provider without a small model just uses the fallback.
  const perProvider = inputs.providers.flatMap((entry) =>
    refs(resolveCandidates("auto", inputs, entry.provider).slice(0, 1)).filter((ref) => ref.provider === entry.provider),
  );
  return { perProvider, fallback };
}

/** Configured metadata models on enabled providers; without a model, the provider's default model. */
function configuredModels(config: GeneratorConfig, byProvider: ReadonlyMap<string, ProviderModels>): ModelRef[] {
  return (config.metadataGeneration?.providers ?? []).flatMap(({ provider, model }) => {
    const entry = byProvider.get(provider);
    if (!entry) return [];
    const configured = model?.trim();
    const fallback = entry.models?.find((candidate) => candidate.isDefault) ?? entry.models?.[0];
    return [{ provider, model: configured || fallback?.id || null }];
  });
}

/** The provider's first installed model from Paseo's small-model list, in list order. */
function smallModel(entry: ProviderModels): string | null {
  for (const needle of PASEO_SMALL_MODELS) {
    const model = entry.models?.find((candidate) => matches(candidate, needle));
    if (model) return model.id;
  }
  return null;
}

function matches(model: { id: string; label: string }, needle: string): boolean {
  return [model.id, model.label].some((value) => value.toLowerCase().includes(needle));
}

function configuredCommand(value: unknown): readonly [string, ...string[]] | null {
  if (typeof value === "string" && value.trim() !== "") return [value];
  if (!Array.isArray(value)) return null;
  const parts = value.filter((part): part is string => typeof part === "string");
  const [first, ...rest] = parts;
  return parts.length === value.length && first ? [first, ...rest] : null;
}
