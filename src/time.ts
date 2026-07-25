import { HuggingFaceOAuthCancelledError } from "./errors.js";
import type { OAuthStage } from "./errors.js";

export function sleepWithSignal(milliseconds: number, signal?: AbortSignal): Promise<void> {
  const stage: OAuthStage = "token polling";
  if (signal?.aborted === true) return Promise.reject(new HuggingFaceOAuthCancelledError(stage));

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new HuggingFaceOAuthCancelledError(stage));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
