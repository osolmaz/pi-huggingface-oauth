import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import { CLIENT_ID_ENV, REFRESH_SKEW_MS } from "./constants.js";
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
  const configured = options.clientId ?? environmentClientId;
  if (configured === undefined || configured.trim().length === 0) {
    throw new HuggingFaceOAuthError(
      "configuration",
      `Hugging Face browser login needs a dedicated public OAuth client ID. Set ${CLIENT_ID_ENV} before starting Pi.`,
    );
  }
  return configured.trim();
}

export function credentialExpiry(now: number, expiresInSeconds: number): number {
  const lifetime = expiresInSeconds * 1000;
  const skew = Math.min(REFRESH_SKEW_MS, Math.max(1_000, Math.floor(lifetime / 10)));
  return now + Math.max(1, lifetime - skew);
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
      const grant = await pollDeviceToken(
        clientId,
        device,
        {
          signal: callbacks.signal,
          onProgress: (message) => {
            callbacks.onProgress?.(message);
          },
        },
        options.protocol,
      );
      return {
        access: grant.accessToken,
        refresh: grant.refreshToken,
        expires: credentialExpiry(wallNow(), grant.expiresInSeconds),
      };
    },
    async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
      const clientId = resolveClientId(options);
      const grant = await refreshAccessToken(clientId, credentials.refresh, {}, options.protocol);
      return {
        access: grant.accessToken,
        refresh: grant.refreshToken ?? credentials.refresh,
        expires: credentialExpiry(wallNow(), grant.expiresInSeconds),
      };
    },
    getApiKey(credentials: OAuthCredentials): string {
      if (credentials.access.trim().length === 0) {
        throw new HuggingFaceOAuthError("configuration", "The stored Hugging Face access token is invalid.");
      }
      return credentials.access;
    },
  };
}
