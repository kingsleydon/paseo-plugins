/** Raised when a CLI cannot run at all (missing binary, not logged in, rate limited). */
export class GeneratorUnavailableError extends Error {}

/** No candidate could run: none configured, all cooling down, or all unavailable. */
export class NoGeneratorError extends Error {
  constructor() {
    super("No recap model is available");
    this.name = "NoGeneratorError";
  }
}

/** Every candidate was skipped on purpose (near its usage limit); not a failure. */
export class RecapSkippedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "RecapSkippedError";
  }
}

/** Typed abort error; RN's global AbortSignal typing lacks `reason`. */
export function abortError(): Error {
  const error = new Error("Recap generation aborted");
  error.name = "AbortError";
  return error;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
