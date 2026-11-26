import type { PluginClientContext, PluginSubscriptionHandle } from "@getpaseo/plugin/client";
import { recapSubscription, type RecapEvent } from "../shared/recap";

const INITIAL_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

/** The SDK reconnects its transport; retry a subscription that the server itself has closed. */
export function subscribeToRecaps(
  client: Pick<PluginClientContext, "subscribe">,
  onEvent: (event: RecapEvent) => void,
  signal: AbortSignal,
): void {
  let delay = INITIAL_RETRY_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let current: PluginSubscriptionHandle | undefined;

  function open(): void {
    if (signal.aborted) return;
    let closed = false;
    const retry = (error?: unknown) => {
      if (closed || signal.aborted) return;
      closed = true;
      current?.();
      current = undefined;
      if (error) console.error("[paseo-recap] recap subscription closed", error);
      timer = setTimeout(open, delay);
      delay = Math.min(delay * 2, MAX_RETRY_MS);
    };
    try {
      const handle = client.subscribe(recapSubscription, {}, (event) => {
        if (closed || signal.aborted) return;
        delay = INITIAL_RETRY_MS;
        onEvent(event);
      }, { onClosed: ({ error }) => retry(error) });
      if (closed || signal.aborted) handle();
      else current = handle;
      void handle.ready.catch(retry);
    } catch (error) {
      retry(error);
    }
  }

  if (signal.aborted) return;
  signal.addEventListener("abort", () => {
    clearTimeout(timer);
    current?.();
  }, { once: true });
  open();
}
