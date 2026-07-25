import { afterEach, describe, expect, it, vi } from "vitest";
import { HuggingFaceOAuthCancelledError } from "../src/errors.js";
import { sleepWithSignal } from "../src/time.js";

describe("abort-aware sleep", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves after the requested delay", async () => {
    vi.useFakeTimers();
    const pending = sleepWithSignal(100);
    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toBeUndefined();
  });

  it("stops when cancellation arrives", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const pending = sleepWithSignal(100, controller.signal);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(HuggingFaceOAuthCancelledError);
  });

  it("rejects an already cancelled wait", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sleepWithSignal(100, controller.signal)).rejects.toBeInstanceOf(HuggingFaceOAuthCancelledError);
  });
});
