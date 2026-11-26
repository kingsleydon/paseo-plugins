import { readFile, rename } from "node:fs/promises";
import { z } from "zod";
import { StoredRecapSchema, type StoredRecap } from "../shared/recap";
import { parseJson } from "./json";
import type { PaseoApi } from "./paseo-types";

const METADATA_KEY = "paseo-recap";
/** Earlier recaps kept per agent besides the latest. */
export const PREVIOUS_RECAPS_KEPT = 4;
/** Recaps older than this are dropped when the plugin starts. */
export const RECAP_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const AgentRecapsSchema = z.object({
  latest: StoredRecapSchema,
  previous: z.array(StoredRecapSchema).default([]),
});
const RecapMetadataSchema = AgentRecapsSchema.extend({ version: z.literal(1) });
type RecapMetadata = z.output<typeof RecapMetadataSchema>;

const StoreFileSchema = z.object({
  version: z.literal(1),
  agents: z.record(z.string(), AgentRecapsSchema),
});

type AgentActions = PaseoApi["agents"];
type AgentHandle = ReturnType<AgentActions["ref"]>;
type AgentList = Awaited<ReturnType<AgentActions["list"]>>;
type StoreAgent = Pick<AgentList["entries"][number]["agent"], "id" | "metadata">;
type RecapAgents = {
  list(options: Parameters<AgentActions["list"]>[0]): Promise<{
    entries: readonly { agent: StoreAgent }[];
    pageInfo: Pick<AgentList["pageInfo"], "nextCursor">;
  }>;
  ref(agentId: string): Pick<AgentHandle, "setMetadata"> & {
    refresh(): Promise<{ agent: StoreAgent } | null>;
  };
};

/** A cache of agent metadata, loaded in pages once and updated after successful writes. */
export class RecapStore {
  readonly #agents: () => RecapAgents;
  readonly #legacyPath: string;
  readonly #log: (message: string, detail?: unknown) => void;
  #recaps = new Map<string, RecapMetadata>();
  readonly #writes = new Map<string, Promise<void>>();

  constructor(agents: () => RecapAgents, legacyPath: string, log: (message: string, detail?: unknown) => void) {
    this.#agents = agents;
    this.#legacyPath = legacyPath;
    this.#log = log;
  }

  async load(now = Date.now()): Promise<void> {
    const agents = this.#agents();
    await this.#migrate(agents);
    const recaps = new Map<string, RecapMetadata>();
    let cursor: string | undefined;
    do {
      // A metadata write changes updatedAt, so paginate using a stable sort.
      const { entries, pageInfo } = await agents.list({
        scope: "active",
        sort: [{ key: "created_at", direction: "asc" }],
        page: { limit: 200, cursor },
      });
      for (const { agent } of entries) {
        const parsed = RecapMetadataSchema.safeParse(agent.metadata?.[METADATA_KEY]);
        if (!parsed.success || parsed.data.latest.agentId !== agent.id) continue;
        if (now - Date.parse(parsed.data.latest.generatedAt) > RECAP_RETENTION_MS) {
          await agents.ref(agent.id).setMetadata({ [METADATA_KEY]: null });
          continue;
        }
        recaps.set(agent.id, parsed.data);
      }
      cursor = pageInfo.nextCursor ?? undefined;
    } while (cursor);
    this.#recaps = recaps;
  }

  get(agentId: string): StoredRecap | null {
    return this.#recaps.get(agentId)?.latest ?? null;
  }

  previous(agentId: string): StoredRecap[] {
    return this.#recaps.get(agentId)?.previous ?? [];
  }

  all(): StoredRecap[] {
    return [...this.#recaps.values()].map((recaps) => recaps.latest);
  }

  set(recap: StoredRecap): Promise<void> {
    return this.#update(recap.agentId, (existing) => ({
      version: 1,
      latest: recap,
      previous: existing
        ? [{ ...existing.latest, stale: true }, ...existing.previous].slice(0, PREVIOUS_RECAPS_KEPT)
        : [],
    }));
  }

  markStale(agentId: string): Promise<void> {
    return this.#update(agentId, (recaps) =>
      recaps && !recaps.latest.stale ? { ...recaps, latest: { ...recaps.latest, stale: true } } : recaps,
    );
  }

  delete(agentId: string, metadata?: StoreAgent["metadata"]): Promise<void> {
    return this.#update(agentId, () => undefined, metadata?.[METADATA_KEY] !== undefined);
  }

  #update(
    agentId: string,
    change: (current?: RecapMetadata) => RecapMetadata | undefined,
    force = false,
  ): Promise<void> {
    const write = async () => {
      const current = this.#recaps.get(agentId);
      const next = change(current);
      if (!force && next === current) return;
      await this.#agents().ref(agentId).setMetadata({ [METADATA_KEY]: next ?? null });
      if (next) this.#recaps.set(agentId, next);
      else this.#recaps.delete(agentId);
    };
    const previous = this.#writes.get(agentId);
    const result = previous ? previous.then(write, write) : write();
    this.#writes.set(agentId, result);
    const clear = () => {
      if (this.#writes.get(agentId) === result) this.#writes.delete(agentId);
    };
    void result.then(clear, clear);
    return result;
  }

  async #migrate(agents: RecapAgents): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.#legacyPath, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    const parsed = StoreFileSchema.safeParse(parseJson(text));
    if (!parsed.success) {
      this.#log("legacy recap file is unreadable", this.#legacyPath);
      return;
    }
    for (const [agentId, recaps] of Object.entries(parsed.data.agents)) {
      const handle = agents.ref(agentId);
      const result = await handle.refresh();
      if (result?.agent.id !== agentId || result.agent.metadata?.[METADATA_KEY] !== undefined) continue;
      await handle.setMetadata({
        [METADATA_KEY]: { version: 1, latest: recaps.latest, previous: recaps.previous.slice(0, PREVIOUS_RECAPS_KEPT) },
      });
    }
    // Preserve the source if any read or write failed. Already migrated entries are skipped on retry.
    await rename(this.#legacyPath, `${this.#legacyPath}.migrated`);
  }
}
