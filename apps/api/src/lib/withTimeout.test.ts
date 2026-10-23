import { describe, expect, it } from "vitest";
import { withTimeout, TimeoutError } from "./withTimeout";

// Real (short) timers throughout — vi's fake timers interact badly with a
// chained then/catch promise like withTimeout's (the derived promise needs an
// extra microtask tick fake-timer advancement doesn't reliably flush), so
// real millisecond-scale delays are simpler and more robust here.

describe("withTimeout", () => {
  it("resolves with the promise's value when it settles before the timeout", async () => {
    const promise = new Promise<string>((resolve) => setTimeout(() => resolve("done"), 5));

    await expect(withTimeout(promise, 1000, "should not fire")).resolves.toBe("done");
  });

  it("rejects with the promise's own error when it rejects before the timeout", async () => {
    const promise = new Promise<string>((_resolve, reject) =>
      setTimeout(() => reject(new Error("boom")), 5)
    );

    await expect(withTimeout(promise, 1000, "should not fire")).rejects.toThrow("boom");
  });

  it("rejects with a TimeoutError once the deadline passes, without waiting for the hung promise", async () => {
    const hung = new Promise<string>(() => {
      // never resolves — simulates a stuck Agent SDK subprocess
    });

    const result = withTimeout(hung, 5, "negotiation timed out");

    await expect(result).rejects.toThrow(TimeoutError);
    await expect(withTimeout(hung, 5, "negotiation timed out")).rejects.toThrow(
      "negotiation timed out"
    );
  });

  it("does not throw an unhandled rejection when the abandoned promise later rejects", async () => {
    let rejectLate: (error: Error) => void = () => {};
    const late = new Promise<string>((_resolve, reject) => {
      rejectLate = reject;
    });

    await expect(withTimeout(late, 5, "timed out")).rejects.toThrow(TimeoutError);

    rejectLate(new Error("late failure, arrives after the caller moved on"));
    // Nothing to assert beyond "this doesn't crash the test process" — an
    // unhandled rejection here would surface as a process-level warning/error.
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
});
