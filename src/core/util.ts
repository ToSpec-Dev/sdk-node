/** A promise that resolves after `ms`, or early when `signal` aborts. */
export function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      cleanup();
      resolve();
    };
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function isAbortError(e: unknown): boolean {
  return e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError");
}
