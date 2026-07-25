import {
  DEFAULT_POLL_INTERVAL_SECONDS,
  HUGGING_FACE_ORIGIN,
  MAX_DEVICE_LIFETIME_SECONDS,
  MAX_POLL_INTERVAL_SECONDS,
  MAX_TOKEN_LIFETIME_SECONDS,
} from "./constants.js";
import { HuggingFaceOAuthError } from "./errors.js";
import type { DeviceAuthorization, RefreshGrant, TokenGrant } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(
  record: Record<string, unknown>,
  key: string,
  stage: "device authorization" | "token polling" | "token refresh",
): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HuggingFaceOAuthError(stage, `Hugging Face ${stage} returned an invalid ${key} field.`);
  }
  return value;
}

function displayString(record: Record<string, unknown>, key: string, stage: "device authorization"): string {
  const value = requiredString(record, key, stage);
  const unsafe = Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || (code >= 127 && code <= 159);
  });
  if (unsafe || value.length > 128) {
    throw new HuggingFaceOAuthError(stage, `Hugging Face ${stage} returned an invalid ${key} field.`);
  }
  return value;
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  stage: "device authorization" | "token refresh",
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HuggingFaceOAuthError(stage, `Hugging Face ${stage} returned an invalid ${key} field.`);
  }
  return value;
}

function positiveInteger(
  record: Record<string, unknown>,
  key: string,
  maximum: number,
  stage: "device authorization" | "token polling" | "token refresh",
): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > maximum) {
    throw new HuggingFaceOAuthError(stage, `Hugging Face ${stage} returned an invalid ${key} field.`);
  }
  return value;
}

function optionalPositiveInteger(record: Record<string, unknown>, key: string, fallback: number): number {
  const value = record[key];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > MAX_POLL_INTERVAL_SECONDS) {
    throw new HuggingFaceOAuthError(
      "device authorization",
      `Hugging Face device authorization returned an invalid ${key} field.`,
    );
  }
  return value;
}

function huggingFaceUrl(value: string, field: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HuggingFaceOAuthError(
      "device authorization",
      `Hugging Face device authorization returned an invalid ${field} field.`,
    );
  }
  if (url.origin !== HUGGING_FACE_ORIGIN || url.protocol !== "https:" || url.username || url.password) {
    throw new HuggingFaceOAuthError(
      "device authorization",
      `Hugging Face device authorization returned an invalid ${field} field.`,
    );
  }
  return url.toString();
}

function validateTokenType(record: Record<string, unknown>, stage: "token polling" | "token refresh"): void {
  const tokenType = record["token_type"];
  if (tokenType !== undefined && (typeof tokenType !== "string" || tokenType.toLowerCase() !== "bearer")) {
    throw new HuggingFaceOAuthError(stage, `Hugging Face ${stage} returned an unsupported token_type field.`);
  }
}

export function parseDeviceAuthorization(value: unknown): DeviceAuthorization {
  if (!isRecord(value))
    throw new HuggingFaceOAuthError(
      "device authorization",
      "Hugging Face device authorization returned invalid JSON data.",
    );
  const verificationUri = huggingFaceUrl(
    requiredString(value, "verification_uri", "device authorization"),
    "verification_uri",
  );
  const complete = optionalString(value, "verification_uri_complete", "device authorization");
  return {
    deviceCode: requiredString(value, "device_code", "device authorization"),
    userCode: displayString(value, "user_code", "device authorization"),
    verificationUri,
    verificationUriComplete:
      complete === undefined ? verificationUri : huggingFaceUrl(complete, "verification_uri_complete"),
    expiresInSeconds: positiveInteger(value, "expires_in", MAX_DEVICE_LIFETIME_SECONDS, "device authorization"),
    intervalSeconds: optionalPositiveInteger(value, "interval", DEFAULT_POLL_INTERVAL_SECONDS),
  };
}

export function parseTokenGrant(value: unknown): TokenGrant {
  if (!isRecord(value))
    throw new HuggingFaceOAuthError("token polling", "Hugging Face token polling returned invalid JSON data.");
  validateTokenType(value, "token polling");
  return {
    accessToken: requiredString(value, "access_token", "token polling"),
    refreshToken: requiredString(value, "refresh_token", "token polling"),
    expiresInSeconds: positiveInteger(value, "expires_in", MAX_TOKEN_LIFETIME_SECONDS, "token polling"),
  };
}

export function parseRefreshGrant(value: unknown): RefreshGrant {
  if (!isRecord(value))
    throw new HuggingFaceOAuthError("token refresh", "Hugging Face token refresh returned invalid JSON data.");
  validateTokenType(value, "token refresh");
  return {
    accessToken: requiredString(value, "access_token", "token refresh"),
    refreshToken: optionalString(value, "refresh_token", "token refresh"),
    expiresInSeconds: positiveInteger(value, "expires_in", MAX_TOKEN_LIFETIME_SECONDS, "token refresh"),
  };
}

export function parseOAuthError(value: unknown): { code: string; description: string } | undefined {
  if (!isRecord(value) || typeof value["error"] !== "string" || value["error"].trim().length === 0) return undefined;
  const description = typeof value["error_description"] === "string" ? value["error_description"] : "";
  return { code: value["error"], description };
}
