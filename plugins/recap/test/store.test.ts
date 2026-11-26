import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PREVIOUS_RECAPS_KEPT, RecapStore, RECAP_RETENTION_MS } from "../server/store";
import { makeRecap } from "./fixtures";

type RecapAgents = ReturnType<ConstructorParameters<typeof RecapStore>[0]>;
type MetadataPatch = Parameters<ReturnType<RecapAgents["ref"]>["setMetadata"]>[0];
const METADATA_KEY = "paseo-recap";
const NOW = Date.parse("2026-10-08T00:00:00.000Z");
const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function setup(...ids: string[]) {
  const dir = await mkdtemp(join(tmpdir(), "recap-store-"));
  dirs.push(dir);
  const path = join(dir, "recaps.json");
  const records = new Map<string, { id: string; metadata: MetadataPatch }>(
    ids.map((id) => [id, { id, metadata: {} }]),
  );
  const writeMetadata = async (id: string, patch: MetadataPatch) => {
    const agent = records.get(id);
    if (!agent) throw new Error(`Agent ${id} is missing`);
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete agent.metadata[key];
      else agent.metadata[key] = value;
    }
  };
  const write = vi.fn(writeMetadata);
  const list = vi.fn<RecapAgents["list"]>(async (options) => {
    const agents = [...records.values()];
    const index = Number(options?.page?.cursor ?? "0");
    return {
      entries: agents.slice(index, index + 1).map((agent) => ({ agent })),
      pageInfo: { nextCursor: index + 1 < agents.length ? String(index + 1) : null },
    };
  });
  const api: RecapAgents = {
    list,
    ref: (id) => ({
      async refresh() {
        const agent = records.get(id);
        return agent ? { agent } : null;
      },
      setMetadata: (patch) => write(id, patch),
    }),
  };
  const log = vi.fn();
  const openStore = () => new RecapStore(() => api, path, log);
  return { path, list, log, openStore, write, writeMetadata, records };
}

describe("RecapStore", () => {
  it("persists on the agent, reloads across pages, and clears metadata on deletion", async () => {
    const { openStore, records, list } = await setup("a", "b");
    const store = openStore();
    await store.load(NOW);
    await store.set(makeRecap());
    await store.set(makeRecap({ agentId: "b" }));
    await store.markStale("a");
    expect(records.get("a")?.metadata[METADATA_KEY]).toMatchObject({
      version: 1, latest: { stale: true }, previous: [],
    });

    const reloaded = openStore();
    await reloaded.load(NOW);
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ page: { limit: 200, cursor: "1" } }));
    expect(reloaded.all().map((recap) => recap.agentId)).toEqual(["a", "b"]);
    expect(reloaded.get("a")).toEqual(makeRecap({ stale: true }));
    await reloaded.delete("a");
    expect(reloaded.get("a")).toBeNull();
    expect(records.get("a")?.metadata).not.toHaveProperty(METADATA_KEY);
  });

  it("serializes concurrent writes and keeps a bounded history, newest first", async () => {
    const { openStore } = await setup("a");
    const store = openStore();
    const writes = Array.from({ length: PREVIOUS_RECAPS_KEPT + 3 }, (_, index) =>
      store.set(makeRecap({ summary: `recap ${index}`, revision: index })),
    );
    await Promise.all([...writes, store.markStale("a")]);
    expect(store.get("a")).toMatchObject({ summary: `recap ${PREVIOUS_RECAPS_KEPT + 2}`, stale: true });
    expect(store.previous("a")).toHaveLength(PREVIOUS_RECAPS_KEPT);
    expect(store.previous("a")[0]).toMatchObject({ summary: `recap ${PREVIOUS_RECAPS_KEPT + 1}`, stale: true });
  });

  it("clears metadata from an archive event even if the agent was outside the startup scan", async () => {
    const { openStore, records } = await setup("a");
    await openStore().set(makeRecap());
    await openStore().delete("a", records.get("a")?.metadata);
    expect(records.get("a")?.metadata).not.toHaveProperty(METADATA_KEY);
  });

  it("keeps a newer in-memory recap when the startup scan recovers", async () => {
    const { openStore, list, write } = await setup("a", "b");
    const saved = openStore();
    await saved.set(makeRecap({ summary: "older" }));
    await saved.set(makeRecap({ agentId: "b" }));

    const store = openStore();
    list.mockRejectedValueOnce(new Error("scan unavailable"));
    await expect(store.load(NOW)).rejects.toThrow("scan unavailable");
    write.mockRejectedValueOnce(new Error("write unavailable"));
    await store.set(makeRecap({ summary: "newer" }));

    expect(await store.load(NOW)).toEqual(["b"]);
    expect(store.get("a")?.summary).toBe("newer");
    expect(store.get("b")).toEqual(makeRecap({ agentId: "b" }));
  });

  it("drops recaps older than the retention window on load", async () => {
    const { openStore, records } = await setup("old", "new");
    const store = openStore();
    await store.set(makeRecap({ agentId: "old", generatedAt: "2026-01-01T00:00:00.000Z" }));
    await store.set(makeRecap({ agentId: "new", generatedAt: "2026-10-01T00:00:00.000Z" }));
    const reloaded = openStore();
    await reloaded.load(Date.parse("2026-10-01T00:00:00.000Z") + RECAP_RETENTION_MS - 1);
    expect(reloaded.all().map((recap) => recap.agentId)).toEqual(["new"]);
    expect(records.get("old")?.metadata).not.toHaveProperty(METADATA_KEY);
  });

  it("preserves the legacy file on failure and resumes migration without overwriting metadata", async () => {
    const { openStore, path, write, writeMetadata } = await setup("a", "b");
    const legacy = {
      version: 1,
      agents: {
        a: { latest: makeRecap(), previous: [makeRecap({ summary: "previous", stale: true })] },
        b: { latest: makeRecap({ agentId: "b" }), previous: [] },
        missing: { latest: makeRecap({ agentId: "missing" }), previous: [] },
      },
    };
    await writeFile(path, JSON.stringify(legacy));
    write.mockImplementationOnce(writeMetadata).mockRejectedValueOnce(new Error("connection lost"));
    await expect(openStore().load(NOW)).rejects.toThrow("connection lost");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(legacy);
    await expect(readFile(`${path}.migrated`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    write.mockClear();

    const reloaded = openStore();
    await reloaded.load(NOW);
    expect(write.mock.calls.map(([id]) => id)).toEqual(["b"]);
    expect(reloaded.previous("a")).toEqual(legacy.agents.a.previous);
    expect(reloaded.get("b")).toEqual(legacy.agents.b.latest);
    expect(reloaded.get("missing")).toBeNull();
    await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(`${path}.migrated`, "utf8"))).toEqual(legacy);
  });

  it("keeps a corrupt legacy file and still loads saved agent metadata", async () => {
    const { openStore, path, log } = await setup("a");
    const store = openStore();
    await store.set(makeRecap());
    await writeFile(path, "{not json");
    const reloaded = openStore();
    await reloaded.load(NOW);
    expect(reloaded.get("a")).toEqual(makeRecap());
    expect(await readFile(path, "utf8")).toBe("{not json");
    expect(log).toHaveBeenCalledOnce();
  });
});
