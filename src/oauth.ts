import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import { CLIENT_ID_ENV, DEFAULT_CLIENT_ID, REFRESH_SKEW_MS } from "./constants.js";
import { HuggingFaceOAuthError } from "./errors.js";
import { pollDeviceToken, refreshAccessToken, requestDeviceAuthorization } from "./protocol.js";
import type { ProtocolDependencies } from "./types.js";

export type OAuthAdapterOptions = {
  readonly clientId?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly protocol?: Partial<ProtocolDependencies>;
  readonly wallNow?: () => number;
};

type OAuthConfig = NonNullable<ProviderConfig["oauth"]>;

export function resolveClientId(options: OAuthAdapterOptions = {}): string {
  const environmentClientId = options.env === undefined ? process.env[CLIENT_ID_ENV] : options.env[CLIENT_ID_ENV];
  const configured = options.clientId ?? environmentClientId ?? DEFAULT_CLIENT_ID;
  if (configured.trim().length === 0) {
    throw new HuggingFaceOAuthError("configuration", `The ${CLIENT_ID_ENV} override must not be empty.`);
  }
  return configured.trim();
}

export function credentialExpiry(now: number, expiresInSeconds: number): number {
  const lifetime = expiresInSeconds * 1000;
  const skew = Math.min(REFRESH_SKEW_MS, Math.max(1_000, Math.floor(lifetime / 10)));
  return now + Math.max(1, lifetime - skew);
}

async function refreshedCredential(
  credentials: OAuthCredentials,
  options: OAuthAdapterOptions,
  signal?: AbortSignal,
): Promise<OAuthCredentials> {
  const clientId = resolveClientId(options);
  const grant = await refreshAccessToken(clientId, credentials.refresh, { signal }, options.protocol);
  const wallNow = options.wallNow ?? Date.now;
  return {
    access: grant.accessToken,
    refresh: grant.refreshToken ?? credentials.refresh,
    expires: credentialExpiry(wallNow(), grant.expiresInSeconds),
  };
}

export function createHuggingFaceOAuth(options: OAuthAdapterOptions = {}): OAuthConfig {
  const wallNow = options.wallNow ?? Date.now;
  return {
    name: "Hugging Face Inference Providers",
    async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
      const clientId = resolveClientId(options);
      const device = await requestDeviceAuthorization(clientId, { signal: callbacks.signal }, options.protocol);
      callbacks.onDeviceCode({
        userCode: device.userCode,
        verificationUri: device.verificationUriComplete,
        intervalSeconds: device.intervalSeconds,
        expiresInSeconds: device.expiresInSeconds,
      });
      // Pi adds one persistent waiting row after onDeviceCode; onProgress would append a new row on every poll.
      const grant = await pollDeviceToken(clientId, device, { signal: callbacks.signal }, options.protocol);
      return {
        access: grant.accessToken,
        refresh: grant.refreshToken,
        expires: credentialExpiry(wallNow(), grant.expiresInSeconds),
      };
    },
    async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
      return refreshedCredential(credentials, options);
    },
    getApiKey(credentials: OAuthCredentials): string {
      if (credentials.access.trim().length === 0) {
        throw new HuggingFaceOAuthError("configuration", "The stored Hugging Face access token is invalid.");
      }
      return credentials.access;
    },
  };
}
