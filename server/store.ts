import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { StoredRecapSchema, type StoredRecap } from "../shared/recap";
import { errorMessage } from "./errors";
import { parseJson } from "./json";

/** Earlier recaps kept per agent besides the latest (OMP journals every recap; we keep a few). */
export const PREVIOUS_RECAPS_KEPT = 4;
/** Recaps of agents not seen for this long are dropped on load (e.g. deleted without archiving). */
export const RECAP_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const AgentRecapsSchema = z.object({
  latest: StoredRecapSchema,
  previous: z.array(StoredRecapSchema).default([]),
});
type AgentRecaps = z.output<typeof AgentRecapsSchema>;

const StoreFileSchema = z.object({
  version: z.literal(1),
  agents: z.record(z.string(), AgentRecapsSchema),
});

/** Latest recaps per agent, persisted as one JSON file under the user's Paseo home. */
export class RecapStore {
  readonly #path: string;
  readonly #log: (message: string, detail?: unknown) => void;
  #agents = new Map<string, AgentRecaps>();
  #writeChain: Promise<void> = Promise.resolve();

  constructor(path: string, log: (message: string, detail?: unknown) => void) {
    this.#path = path;
    this.#log = log;
  }

  async load(now = Date.now()): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.#path, "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) return;
      throw error;
    }
    const parsed = StoreFileSchema.safeParse(parseJson(text));
    if (!parsed.success) {
      this.#log("recap store is unreadable; starting empty", this.#path);
      return;
    }
    this.#agents = new Map(Object.entries(parsed.data.agents));
    let pruned = false;
    for (const [agentId, recaps] of this.#agents) {
      if (now - Date.parse(recaps.latest.generatedAt) > RECAP_RETENTION_MS) {
        this.#agents.delete(agentId);
        pruned = true;
      }
    }
    if (pruned) await this.#persist();
  }

  get(agentId: string): StoredRecap | null {
    return this.#agents.get(agentId)?.latest ?? null;
  }

  previous(agentId: string): StoredRecap[] {
    return this.#agents.get(agentId)?.previous ?? [];
  }

  all(): StoredRecap[] {
    return [...this.#agents.values()].map((recaps) => recaps.latest);
  }

  set(recap: StoredRecap): Promise<void> {
    const existing = this.#agents.get(recap.agentId);
    const previous = existing
      ? [{ ...existing.latest, stale: true }, ...existing.previous].slice(0, PREVIOUS_RECAPS_KEPT)
      : [];
    this.#agents.set(recap.agentId, { latest: recap, previous });
    return this.#persist();
  }

  markStale(agentId: string): Promise<void> {
    const recaps = this.#agents.get(agentId);
    if (!recaps || recaps.latest.stale) return Promise.resolve();
    this.#agents.set(agentId, { ...recaps, latest: { ...recaps.latest, stale: true } });
    return this.#persist();
  }

  delete(agentId: string): Promise<void> {
    if (!this.#agents.delete(agentId)) return Promise.resolve();
    return this.#persist();
  }

  /** Serializes writes; each write replaces the file atomically via rename. */
  #persist(): Promise<void> {
    const snapshot = JSON.stringify({ version: 1, agents: Object.fromEntries(this.#agents) });
    const write = async () => {
      await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
      const temp = `${this.#path}.${process.pid}.tmp`;
      await writeFile(temp, snapshot, { mode: 0o600 });
      await rename(temp, this.#path);
    };
    this.#writeChain = this.#writeChain.then(write, write);
    return this.#writeChain.catch((error: unknown) => {
      this.#log("failed to persist recaps", errorMessage(error));
    });
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
