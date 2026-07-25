import { HuggingFaceOAuthCancelledError, HuggingFaceOAuthError } from "./errors.js";
import type { OAuthStage } from "./errors.js";
import type { FetchLike } from "./types.js";

class ResponseTooLargeError extends Error {}
class ResponseBodyTimeoutError extends Error {}

async function collectStream(reader: ReadableStreamDefaultReader<Uint8Array>, maximumBytes: number): Promise<string> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > maximumBytes) throw new ResponseTooLargeError();
    chunks.push(result.value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function interruptedRead(): {
  promise: Promise<never>;
  reject: (error: Error) => void;
} {
  let rejectRead: (error: Error) => void = () => undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    rejectRead = reject;
  });
  return { promise, reject: rejectRead };
}

async function readStream(
  response: Response,
  maximumBytes: number,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  stage: OAuthStage,
): Promise<string> {
  if (signalAborted(signal)) throw new HuggingFaceOAuthCancelledError(stage);
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const interruption = interruptedRead();
  const onAbort = (): void => {
    interruption.reject(new HuggingFaceOAuthCancelledError(stage));
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    interruption.reject(new ResponseBodyTimeoutError());
  }, timeoutMs);
  try {
    return await Promise.race([collectStream(reader, maximumBytes), interruption.promise]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    void reader.cancel().catch(() => undefined);
  }
}

function hasOversizedContentLength(response: Response, maximumBytes: number): boolean {
  const contentLength = Number(response.headers.get("content-length"));
  return Number.isFinite(contentLength) && contentLength > maximumBytes;
}

export async function readBoundedJson(
  response: Response,
  maximumBytes: number,
  stage: OAuthStage,
  options: { timeoutMs: number; signal?: AbortSignal | undefined },
): Promise<unknown> {
  if (hasOversizedContentLength(response, maximumBytes)) {
    void response.body?.cancel().catch(() => undefined);
    throw new HuggingFaceOAuthError(stage, `Hugging Face ${stage} returned an oversized response.`);
  }
  let text: string;
  try {
    text = await readStream(response, maximumBytes, options.timeoutMs, options.signal, stage);
  } catch (error) {
    if (error instanceof HuggingFaceOAuthCancelledError) throw error;
    if (error instanceof ResponseTooLargeError) {
      throw new HuggingFaceOAuthError(stage, `Hugging Face ${stage} returned an oversized response.`);
    }
    const message =
      error instanceof ResponseBodyTimeoutError
        ? `Hugging Face ${stage} response timed out.`
        : `Hugging Face ${stage} response failed.`;
    throw new HuggingFaceOAuthError(stage, message, { retryable: true });
  }
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    throw new HuggingFaceOAuthError(stage, `Hugging Face ${stage} returned malformed JSON.`);
  }
}

function verifyResponseOrigin(response: Response, requestUrl: string, stage: OAuthStage): void {
  if (response.status >= 300 && response.status < 400) {
    throw new HuggingFaceOAuthError(stage, `Hugging Face ${stage} returned an unexpected redirect.`);
  }
  if (response.url.length > 0 && new URL(response.url).origin !== new URL(requestUrl).origin) {
    throw new HuggingFaceOAuthError(stage, `Hugging Face ${stage} redirected to another origin.`);
  }
}

function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

type AbortState = { cause: "none" | "caller" | "timeout" };

function requestFailure(stage: OAuthStage, state: AbortState): never {
  if (state.cause === "caller") throw new HuggingFaceOAuthCancelledError(stage);
  const message =
    state.cause === "timeout" ? `Hugging Face ${stage} timed out.` : `Hugging Face ${stage} network request failed.`;
  throw new HuggingFaceOAuthError(stage, message, { retryable: true });
}

export async function postForm(input: {
  url: string;
  form: URLSearchParams;
  fetch: FetchLike;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  stage: OAuthStage;
}): Promise<Response> {
  if (signalAborted(input.signal)) throw new HuggingFaceOAuthCancelledError(input.stage);
  const controller = new AbortController();
  const state: AbortState = { cause: "none" };
  const onAbort = (): void => {
    if (state.cause === "none") state.cause = "caller";
    controller.abort();
  };
  input.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    if (state.cause === "none") state.cause = "timeout";
    controller.abort();
  }, input.timeoutMs);
  try {
    const response = await input.fetch(input.url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: input.form.toString(),
      redirect: "manual",
      signal: controller.signal,
    });
    verifyResponseOrigin(response, input.url, input.stage);
    return response;
  } catch (error) {
    if (error instanceof HuggingFaceOAuthError) throw error;
    return requestFailure(input.stage, state);
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);
  }
}
