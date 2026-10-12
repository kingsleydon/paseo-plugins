import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

// Providers ------------------------------------------------------------------------------------

/** Providers whose CLI can write recaps. Models come from what Paseo reports as installed. */
export const RECAP_PROVIDERS = {
  claude: { label: "Claude" },
  codex: { label: "Codex" },
  opencode: { label: "OpenCode" },
} as const satisfies Record<string, { label: string }>;
export type RecapProvider = keyof typeof RECAP_PROVIDERS;

export function isRecapProvider(value: string): value is RecapProvider {
  return Object.keys(RECAP_PROVIDERS).includes(value);
}

// Settings -------------------------------------------------------------------------------------

/**
 * `auto`: the agent's own provider first, then Paseo's metadata-generation order.
 * `metadata`: Paseo's metadata-generation order only.
 */
export const GeneratorModeSchema = z.enum(["auto", "metadata"]);
export type GeneratorMode = z.output<typeof GeneratorModeSchema>;

/** Model ids become a CLI argument, so they may not start with "-" or contain spaces. */
export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/;

export const GeneratorChoiceSchema = z.object({
  provider: z.string().min(1),
  model: z.string().max(200).regex(MODEL_ID_PATTERN).optional(),
});
export type GeneratorChoice = z.output<typeof GeneratorChoiceSchema>;

const GeneratorSchema = z.union([GeneratorModeSchema, GeneratorChoiceSchema]);

/** Inclusive ranges for numeric settings, shared by the schema and the settings screen. */
export const SETTING_RANGES = {
  idleDelaySeconds: { min: 0, max: 3600 },
  minTurns: { min: 1, max: 50 },
  turnsBetweenRecaps: { min: 1, max: 50 },
  historyExchanges: { min: 1, max: 100 },
} as const;

function rangedInt(key: keyof typeof SETTING_RANGES, fallback: number) {
  const { min, max } = SETTING_RANGES[key];
  return z.number().int().min(min).max(max).default(fallback);
}

export const recapSettings = defineSettings({
  id: "recap",
  scope: "host",
  version: 1,
  schema: z.object({
    autoRecap: z.boolean().default(true),
    /** Quiet time after a turn ends before generating; a reply within it skips the recap. */
    idleDelaySeconds: rangedInt("idleDelaySeconds", 10),
    /** User messages required before the first recap of a session. */
    minTurns: rangedInt("minTurns", 3),
    /** Completed turns between automatic recaps; 1 recaps after every turn. */
    turnsBetweenRecaps: rangedInt("turnsBetweenRecaps", 1),
    /** Recent exchanges (a user message and the reply) a recap reads, within an ~8K-token budget. */
    historyExchanges: rangedInt("historyExchanges", 8),
    generator: GeneratorSchema.default("auto"),
    includeSubagents: z.boolean().default(false),
    /** Hold a parent's recap while its subagents run (at most 10 minutes), as Claude Code does. */
    waitForSubagents: z.boolean().default(false),
  }),
});
export type RecapSettings = z.output<typeof recapSettings.schema>;

// Recaps ---------------------------------------------------------------------------------------

export const RECAP_SUMMARY_MAX_CHARS = 700;
export const RECAP_NEXT_ACTION_MAX_CHARS = 200;

const ModelRefSchema = z.object({ provider: z.string(), model: z.string().nullable() });
export type ModelRef = z.output<typeof ModelRefSchema>;

export const StoredRecapSchema = z.object({
  agentId: z.string(),
  summary: z.string(),
  nextAction: z.string().nullable(),
  generatedAt: z.string(),
  revision: z.number().int().nonnegative(),
  turnCount: z.number().int().nonnegative(),
  stale: z.boolean(),
  trigger: z.enum(["auto", "manual"]),
  generator: ModelRefSchema,
  /** Agent context captured at generation time. */
  agent: z
    .object({
      title: z.string().nullable(),
      workspaceId: z.string().nullable(),
      provider: z.string().nullable(),
    })
    .default({ title: null, workspaceId: null, provider: null }),
});
export type StoredRecap = z.output<typeof StoredRecapSchema>;

/** A recap shown in the conversation, like Claude Code's recap line. Display-only: never sent to the model. */
export const RECAP_TIMELINE_KIND = "recap";
export const RecapTimelineDataSchema = z.object({
  summary: z.string(),
  nextAction: z.string().nullable(),
});
export type RecapTimelineData = z.output<typeof RecapTimelineDataSchema>;

export const RecapStateSchema = z.enum(["idle", "waiting", "generating", "error"]);
export type RecapState = z.output<typeof RecapStateSchema>;

export const RecapViewSchema = z.object({
  agentId: z.string(),
  state: RecapStateSchema,
  recap: StoredRecapSchema.nullable(),
  /** Earlier recaps for this agent, newest first. */
  previous: z.array(StoredRecapSchema),
  error: z.string().nullable(),
});
export type RecapView = z.output<typeof RecapViewSchema>;

/** The models a generator setting resolves to, for the settings screen. */
export const ModelPlanSchema = z.object({
  /** "Same as agent": the model each provider's agents try first. */
  perProvider: z.array(ModelRefSchema),
  /** Tried in order: for other agents, after a first choice fails, or for every other setting. */
  fallback: z.array(ModelRefSchema),
});
export type ModelPlan = z.output<typeof ModelPlanSchema>;

// RPCs -----------------------------------------------------------------------------------------

export const recapGetRpc = defineRpc({
  name: "recap.get",
  input: z.object({ agentId: z.string().min(1) }),
  output: RecapViewSchema,
});

export const recapListRpc = defineRpc({
  name: "recap.list",
  input: z.object({}),
  output: z.object({ recaps: z.array(RecapViewSchema) }),
});

export const recapRegenerateRpc = defineRpc({
  name: "recap.regenerate",
  input: z.object({ agentId: z.string().min(1) }),
  output: RecapViewSchema,
});

export const recapModelPlanRpc = defineRpc({
  name: "recap.models",
  input: z.object({ generator: GeneratorSchema }),
  output: ModelPlanSchema,
});
