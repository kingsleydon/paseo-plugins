import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const RECAP_SUMMARY_MAX_CHARS = 700;
export const RECAP_NEXT_ACTION_MAX_CHARS = 200;

/**
 * `auto`: the agent's own provider (cheap model) first, then Paseo's metadata-generation order.
 * `metadata`: Paseo's metadata-generation order only.
 */
export const GeneratorModeSchema = z.enum(["auto", "metadata"]);
export type GeneratorMode = z.output<typeof GeneratorModeSchema>;

export const GeneratorChoiceSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1).optional(),
});
export type GeneratorChoice = z.output<typeof GeneratorChoiceSchema>;

export const StoredRecapSchema = z.object({
  agentId: z.string(),
  summary: z.string(),
  nextAction: z.string().nullable(),
  generatedAt: z.string(),
  revision: z.number().int().nonnegative(),
  turnCount: z.number().int().nonnegative(),
  stale: z.boolean(),
  trigger: z.enum(["auto", "manual"]),
  generator: z.object({ provider: z.string(), model: z.string().nullable() }),
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

export const recapSettings = defineSettings({
  id: "recap",
  scope: "host",
  version: 1,
  schema: z.object({
    autoRecap: z.boolean().default(true),
    /** Quiet time after a turn ends before generating; a reply within it skips the recap. */
    idleDelaySeconds: z.number().int().min(0).max(3600).default(10),
    /** User messages required before the first recap of a session. */
    minTurns: z.number().int().min(1).max(50).default(3),
    /** Completed turns between automatic recaps; 1 recaps after every turn. */
    turnsBetweenRecaps: z.number().int().min(1).max(50).default(1),
    generator: z.union([GeneratorModeSchema, GeneratorChoiceSchema]).default("auto"),
    includeSubagents: z.boolean().default(false),
    /** Hold a parent's recap while its subagents run (at most 10 minutes), as Claude Code does. */
    waitForSubagents: z.boolean().default(false),
  }),
});
export type RecapSettings = z.output<typeof recapSettings.schema>;
