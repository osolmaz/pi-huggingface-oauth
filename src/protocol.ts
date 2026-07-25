import {
  DEFAULT_HTTP_TIMEOUT_MS,
  DEVICE_AUTHORIZATION_URL,
  DEVICE_CODE_GRANT_TYPE,
  MAX_POLL_INTERVAL_SECONDS,
  MAX_RESPONSE_BYTES,
  OAUTH_SCOPE,
  REFRESH_RETRY_DELAYS_MS,
  TOKEN_URL,
} from "./constants.js";
import { HuggingFaceOAuthCancelledError, HuggingFaceOAuthError } from "./errors.js";
import { postForm, readBoundedJson } from "./http.js";
import { redactForError } from "./redaction.js";
import { sleepWithSignal } from "./time.js";
import type {
  DeviceAuthorization,
  PollOptions,
  ProtocolDependencies,
  RefreshGrant,
  RequestOptions,
  TokenGrant,
} from "./types.js";
import { parseDeviceAuthorization, parseOAuthError, parseRefreshGrant, parseTokenGrant } from "./validation.js";

const defaultDependencies: ProtocolDependencies = {
  fetch: globalThis.fetch,
  monotonicNow: () => performance.now(),
  sleep: sleepWithSignal,
  endpoints: { deviceAuthorization: DEVICE_AUTHORIZATION_URL, token: TOKEN_URL },
  httpTimeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
  maxResponseBytes: MAX_RESPONSE_BYTES,
};

function dependencies(override?: Partial<ProtocolDependencies>): ProtocolDependencies {
  return {
    ...defaultDependencies,
    ...override,
    endpoints: { ...defaultDependencies.endpoints, ...override?.endpoints },
  };
}

function containsControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || (code >= 127 && code <= 159);
  });
}

function assertClientId(clientId: string): void {
  if (clientId.trim().length === 0 || clientId.length > 512 || containsControl(clientId)) {
    throw new HuggingFaceOAuthError("configuration", "The Hugging Face OAuth client ID is invalid.");
  }
}

function form(fields: Readonly<Record<string, string>>): URLSearchParams {
  const value = new URLSearchParams();
  for (const [key, entry] of Object.entries(fields)) value.set(key, entry);
  return value;
}

function safeOAuthErrorCode(value: string, secrets: readonly string[]): string {
  const redacted = redactForError(value, secrets);
  return redacted.length > 0 ? redacted : "unknown_oauth_error";
}

async function parseErrorResponse(
  response: Response,
  deps: ProtocolDependencies,
  stage: "device authorization" | "token polling" | "token refresh",
  secrets: readonly string[],
  signal: AbortSignal | undefined,
): Promise<HuggingFaceOAuthError> {
  let parsed: unknown;
  try {
    parsed = await readBoundedJson(response, deps.maxResponseBytes, stage, {
      timeoutMs: deps.httpTimeoutMs,
      signal,
    });
  } catch (error) {
    if (error instanceof HuggingFaceOAuthCancelledError) throw error;
    if (error instanceof HuggingFaceOAuthError && error.retryable) throw error;
    return new HuggingFaceOAuthError(stage, `Hugging Face ${stage} failed with HTTP ${String(response.status)}.`);
  }
  const oauth = parseOAuthError(parsed);
  if (oauth === undefined)
    return new HuggingFaceOAuthError(stage, `Hugging Face ${stage} failed with HTTP ${String(response.status)}.`);
  const code = safeOAuthErrorCode(oauth.code, secrets);
  const description = redactForError(oauth.description, secrets);
  const suffix = description.length > 0 ? `: ${description}` : "";
  return new HuggingFaceOAuthError(stage, `Hugging Face ${stage} failed (${code})${suffix}.`, { code });
}

export async function requestDeviceAuthorization(
  clientId: string,
  options: RequestOptions = {},
  override?: Partial<ProtocolDependencies>,
): Promise<DeviceAuthorization> {
  assertClientId(clientId);
  const deps = dependencies(override);
  const response = await postForm({
    url: deps.endpoints.deviceAuthorization,
    form: form({ client_id: clientId, scope: OAUTH_SCOPE }),
    fetch: deps.fetch,
    timeoutMs: deps.httpTimeoutMs,
    signal: options.signal,
    stage: "device authorization",
  });
  if (!response.ok) throw await parseErrorResponse(response, deps, "device authorization", [], options.signal);
  const value = await readBoundedJson(response, deps.maxResponseBytes, "device authorization", {
    timeoutMs: deps.httpTimeoutMs,
    signal: options.signal,
  });
  return parseDeviceAuthorization(value);
}

async function tokenPollResponse(
  clientId: string,
  device: DeviceAuthorization,
  signal: AbortSignal | undefined,
  deps: ProtocolDependencies,
  timeoutMs: number,
): Promise<Response> {
  return postForm({
    url: deps.endpoints.token,
    form: form({ grant_type: DEVICE_CODE_GRANT_TYPE, device_code: device.deviceCode, client_id: clientId }),
    fetch: deps.fetch,
    timeoutMs,
    signal,
    stage: "token polling",
  });
}

function terminalPollError(code: string): HuggingFaceOAuthError | undefined {
  if (code === "access_denied") {
    return new HuggingFaceOAuthError("token polling", "Hugging Face authorization was denied.", { code });
  }
  if (code === "expired_token") {
    return new HuggingFaceOAuthError("token polling", "The Hugging Face device code expired.", { code });
  }
  return undefined;
}

type PollOutcome = { readonly grant?: TokenGrant; readonly nextIntervalAdjustment?: number };

function oauthPollOutcome(oauth: { code: string; description: string }, device: DeviceAuthorization): PollOutcome {
  if (oauth.code === "authorization_pending") return {};
  if (oauth.code === "slow_down") return { nextIntervalAdjustment: 5 };
  const terminal = terminalPollError(oauth.code);
  if (terminal !== undefined) throw terminal;
  const secrets = [device.deviceCode];
  const code = safeOAuthErrorCode(oauth.code, secrets);
  const description = redactForError(oauth.description, secrets);
  const suffix = description.length > 0 ? `: ${description}` : "";
  throw new HuggingFaceOAuthError("token polling", `Hugging Face token polling failed (${code})${suffix}.`, { code });
}

function discardResponse(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

async function handlePollResponse(
  response: Response,
  device: DeviceAuthorization,
  deps: ProtocolDependencies,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<PollOutcome> {
  if (response.status === 429 || response.status >= 500) {
    discardResponse(response);
    return {};
  }
  const value = await readBoundedJson(response, deps.maxResponseBytes, "token polling", {
    timeoutMs,
    signal,
  });
  if (response.ok) return { grant: parseTokenGrant(value) };
  const oauth = parseOAuthError(value);
  if (oauth !== undefined) return oauthPollOutcome(oauth, device);
  throw new HuggingFaceOAuthError(
    "token polling",
    `Hugging Face token polling failed with HTTP ${String(response.status)}.`,
  );
}

async function pollOnce(
  clientId: string,
  device: DeviceAuthorization,
  options: PollOptions,
  deps: ProtocolDependencies,
  deadline: number,
): Promise<PollOutcome> {
  const remainingMs = Math.max(1, deadline - deps.monotonicNow());
  const requestTimeoutMs = Math.min(deps.httpTimeoutMs, remainingMs);
  try {
    const response = await tokenPollResponse(clientId, device, options.signal, deps, requestTimeoutMs);
    const bodyRemainingMs = deadline - deps.monotonicNow();
    if (bodyRemainingMs <= 0) {
      discardResponse(response);
      return {};
    }
    return await handlePollResponse(
      response,
      device,
      deps,
      options.signal,
      Math.min(deps.httpTimeoutMs, bodyRemainingMs),
    );
  } catch (error) {
    if (error instanceof HuggingFaceOAuthCancelledError) throw error;
    if (error instanceof HuggingFaceOAuthError && error.retryable) return {};
    throw error;
  }
}

async function wait(
  deps: ProtocolDependencies,
  milliseconds: number,
  signal: AbortSignal | undefined,
  stage: "token polling" | "token refresh",
): Promise<void> {
  try {
    await deps.sleep(milliseconds, signal);
  } catch (error) {
    if (signal?.aborted === true) throw new HuggingFaceOAuthCancelledError(stage);
    throw error;
  }
  if (signal?.aborted === true) throw new HuggingFaceOAuthCancelledError(stage);
}

function reportProgress(callback: PollOptions["onProgress"]): void {
  callback?.("Waiting for Hugging Face authorization…");
}

function adjustedInterval(current: number, outcome: PollOutcome): number {
  return Math.min(MAX_POLL_INTERVAL_SECONDS, current + (outcome.nextIntervalAdjustment ?? 0));
}

function boundedPollWait(intervalSeconds: number, now: number, deadline: number): number {
  return Math.min(intervalSeconds * 1000, Math.max(0, deadline - now));
}

export async function pollDeviceToken(
  clientId: string,
  device: DeviceAuthorization,
  options: PollOptions = {},
  override?: Partial<ProtocolDependencies>,
): Promise<TokenGrant> {
  assertClientId(clientId);
  const deps = dependencies(override);
  const deadline = deps.monotonicNow() + device.expiresInSeconds * 1000;
  let intervalSeconds = device.intervalSeconds;
  while (deps.monotonicNow() < deadline) {
    await wait(deps, boundedPollWait(intervalSeconds, deps.monotonicNow(), deadline), options.signal, "token polling");
    if (deps.monotonicNow() >= deadline) break;
    reportProgress(options.onProgress);
    const outcome = await pollOnce(clientId, device, options, deps, deadline);
    if (deps.monotonicNow() >= deadline) break;
    if (outcome.grant !== undefined) return outcome.grant;
    intervalSeconds = adjustedInterval(intervalSeconds, outcome);
  }
  throw new HuggingFaceOAuthError("token polling", "The Hugging Face device code expired.", {
    code: "expired_token",
  });
}

async function refreshAttempt(
  clientId: string,
  refreshToken: string,
  signal: AbortSignal | undefined,
  deps: ProtocolDependencies,
): Promise<RefreshGrant> {
  const response = await postForm({
    url: deps.endpoints.token,
    form: form({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId }),
    fetch: deps.fetch,
    timeoutMs: deps.httpTimeoutMs,
    signal,
    stage: "token refresh",
  });
  if (response.status === 429 || response.status >= 500) {
    discardResponse(response);
    throw new HuggingFaceOAuthError("token refresh", "Hugging Face token refresh is temporarily unavailable.", {
      retryable: true,
    });
  }
  if (!response.ok) {
    const error = await parseErrorResponse(response, deps, "token refresh", [refreshToken], signal);
    if (error.code === "invalid_grant") {
      throw new HuggingFaceOAuthError(
        "token refresh",
        "The Hugging Face authorization expired or was revoked. Run /login again.",
        {
          code: "invalid_grant",
        },
      );
    }
    throw error;
  }
  const value = await readBoundedJson(response, deps.maxResponseBytes, "token refresh", {
    timeoutMs: deps.httpTimeoutMs,
    signal,
  });
  return parseRefreshGrant(value);
}

function retryDelay(error: unknown, attempt: number): number | undefined {
  if (!(error instanceof HuggingFaceOAuthError) || !error.retryable) return undefined;
  return REFRESH_RETRY_DELAYS_MS[attempt];
}

export async function refreshAccessToken(
  clientId: string,
  refreshToken: string,
  options: RequestOptions = {},
  override?: Partial<ProtocolDependencies>,
): Promise<RefreshGrant> {
  assertClientId(clientId);
  if (refreshToken.length === 0) {
    throw new HuggingFaceOAuthError("token refresh", "The stored Hugging Face refresh token is invalid.");
  }
  const deps = dependencies(override);
  for (let attempt = 0; attempt <= REFRESH_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await refreshAttempt(clientId, refreshToken, options.signal, deps);
    } catch (error) {
      const delay = retryDelay(error, attempt);
      if (delay === undefined) throw error;
      await wait(deps, delay, options.signal, "token refresh");
    }
  }
  throw new HuggingFaceOAuthError("token refresh", "Hugging Face token refresh failed.");
}
