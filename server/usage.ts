import { errorMessage } from "./errors";

/** Automatic recaps skip a provider once any of its usage windows passes this share. */
const USAGE_SKIP_PERCENT = 90;
const USAGE_CACHE_MS = 5 * 60_000;

/** Minimal shape of Paseo's provider usage report (`paseo.providers.listUsage()`). */
export interface ProviderUsage {
  providerId: string;
  windows: ReadonlyArray<{ usedPct?: number | null }>;
}

export function providersNearLimit(
  providers: readonly ProviderUsage[],
  threshold = USAGE_SKIP_PERCENT,
): Set<string> {
  const near = new Set<string>();
  for (const provider of providers) {
    if (provider.windows.some((window) => (window.usedPct ?? 0) >= threshold)) {
      near.add(provider.providerId);
    }
  }
  return near;
}

/**
 * Caches which providers are near their plan limits. Like Claude Code's recap, automatic recaps
 * stay out of the way when the user is about to run out; manual recaps ignore this.
 */
export class UsageGuard {
  readonly #fetch: () => Promise<readonly ProviderUsage[]>;
  readonly #now: () => number;
  readonly #log: (message: string, detail?: unknown) => void;
  #cached: { at: number; near: Set<string> } | null = null;
  #pending: Promise<Set<string>> | null = null;

  constructor(
    fetch: () => Promise<readonly ProviderUsage[]>,
    now: () => number,
    log: (message: string, detail?: unknown) => void,
  ) {
    this.#fetch = fetch;
    this.#now = now;
    this.#log = log;
  }

  /** Providers to skip. Usage that cannot be read never blocks recaps. */
  async nearLimit(): Promise<Set<string>> {
    if (this.#cached && this.#now() - this.#cached.at < USAGE_CACHE_MS) return this.#cached.near;
    this.#pending ??= this.#fetch()
      .then((providers) => providersNearLimit(providers))
      .catch((error: unknown) => {
        this.#log("could not read provider usage", errorMessage(error));
        return new Set<string>();
      })
      .then((near) => {
        this.#cached = { at: this.#now(), near };
        this.#pending = null;
        return near;
      });
    return this.#pending;
  }
}
