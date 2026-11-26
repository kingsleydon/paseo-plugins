import type { PluginClientContext } from "@getpaseo/plugin/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { subscribeToRecaps } from "../client/recap-subscription";
import { createRecapStream } from "../server/recap-stream";
import type { RecapEvent, RecapView } from "../shared/recap";
import { makeRecap } from "./fixtures";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("recap subscription", () => {
  it("delivers snapshots and changes, then catches up after a server close", async () => {
    vi.useFakeTimers();
    const stream = createRecapStream();
    const openConnections: AbortController[] = [];
    let latest: RecapView = { agentId: "a", state: "generating", recap: null, previous: [], error: null };
    const client: Pick<PluginClientContext, "subscribe"> = {
      subscribe(contract, _input, onEvent, options) {
        const server = new AbortController();
        openConnections.push(server);
        let released = false;
        const release = () => {
          released = true;
          server.abort();
        };
        const finished = stream.subscribe(() => [latest], async (event) => {
          onEvent(contract.event.parse(event));
        }, server.signal);
        void finished.then(() => {
          if (!released) options?.onClosed?.({});
        }, (error: Error) => options?.onClosed?.({ error }));
        return Object.assign(release, { ready: Promise.resolve(), release: async () => release() });
      },
    };

    const events: RecapEvent[] = [];
    const lifetime = new AbortController();
    subscribeToRecaps(client, (event) => events.push(event), lifetime.signal);
    expect(events).toEqual([{ type: "snapshot", recaps: [latest] }]);

    latest = { ...latest, state: "idle", recap: makeRecap() };
    stream.update(latest);
    expect(events.at(-1)).toEqual({ type: "update", view: latest });

    openConnections[0]?.abort();
    latest = { ...latest, state: "idle", recap: makeRecap({ stale: true }) };
    stream.update(latest);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(openConnections).toHaveLength(2);
    expect(events).toHaveLength(3);
    expect(events.at(-1)).toEqual({ type: "snapshot", recaps: [latest] });

    lifetime.abort();
    stream.update({ ...latest, recap: null });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(openConnections).toHaveLength(2);
    expect(events).toHaveLength(3);
    expect(openConnections[1]?.signal.aborted).toBe(true);
  });

  it("backs off after refusals up to a fixed ceiling and cancels a retry on release", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const attempts: number[] = [];
    const refusal = new Error("Unavailable");
    const client: Pick<PluginClientContext, "subscribe"> = {
      subscribe(_contract, _input, _onEvent, options) {
        attempts.push(Date.now());
        options?.onClosed?.({ error: refusal });
        return Object.assign(() => undefined, {
          ready: Promise.reject(refusal),
          release: async () => undefined,
        });
      },
    };

    const lifetime = new AbortController();
    subscribeToRecaps(client, () => undefined, lifetime.signal);
    await vi.advanceTimersByTimeAsync(91_000);
    const first = attempts[0] ?? 0;
    expect(attempts.map((time) => time - first)).toEqual([0, 1000, 3000, 7000, 15_000, 31_000, 61_000, 91_000]);
    lifetime.abort();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(attempts).toHaveLength(8);
  });
});
