import type { RecapEvent, RecapView } from "../shared/recap";

export function createRecapStream() {
  const subscribers = new Set<(event: RecapEvent) => void>();

  function subscribe(
    snapshot: () => RecapView[],
    push: (event: RecapEvent) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const close = () => {
        subscribers.delete(send);
        signal.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        close();
        resolve();
      };
      const send = (event: RecapEvent) => {
        void push(event).catch((error: unknown) => {
          close();
          reject(error);
        });
      };
      const initial = snapshot();
      signal.addEventListener("abort", onAbort, { once: true });
      subscribers.add(send);
      send({ type: "snapshot", recaps: initial });
    });
  }

  function update(view: RecapView): void {
    for (const send of subscribers) send({ type: "update", view });
  }

  return { subscribe, update };
}
