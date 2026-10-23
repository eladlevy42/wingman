// Generic race-against-a-timer helper (#307): a hung downstream call (e.g. a
// stuck Agent SDK subprocess) otherwise never resolves and stalls whatever
// awaits it forever. This does not cancel `promise` — there is no way to abort
// an in-flight Agent SDK call — it only stops the caller from waiting on it
// past `ms`. The original promise keeps running in the background and its
// eventual resolution/rejection is simply ignored (the `.catch` below exists
// only to prevent an unhandled-rejection warning if it fails after we've
// already moved on).
export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error as Error);
      }
    );
  }).catch((error: unknown) => {
    if (error instanceof TimeoutError) {
      promise.catch(() => {
        // Swallow a late resolution/rejection from the abandoned call — the
        // caller already moved on when the timeout fired.
      });
    }
    throw error;
  });
}
