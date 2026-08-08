import type { OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import registerHuggingFaceOAuth, { createHuggingFaceProviderConfig } from "../index.js";
import type { ProviderRegistrar } from "../index.js";
import { DEFAULT_CLIENT_ID } from "../src/constants.js";
import { HuggingFaceOAuthError } from "../src/errors.js";
import { createHuggingFaceOAuth, credentialExpiry, resolveClientId } from "../src/oauth.js";
import type { ProtocolDependencies } from "../src/types.js";
import { FakeOAuthServer } from "./fake-oauth-server.js";

const CLIENT_ID = "dedicated-public-client";
const ACCESS_TOKEN = "hf_access_secret_123456";
const REFRESH_TOKEN = "hf_refresh_secret_123456";

type CallbackState = {
  readonly devices: {
    userCode: string;
    verificationUri: string;
    intervalSeconds?: number;
    expiresInSeconds?: number;
  }[];
  readonly progress: string[];
};

function callbacks(state: CallbackState, signal?: AbortSignal): OAuthLoginCallbacks {
  return {
    onAuth: () => undefined,
    onDeviceCode: (info) => {
      state.devices.push(info);
    },
    onPrompt: async () => "",
    onProgress: (message) => {
      state.progress.push(message);
    },
    onSelect: async () => undefined,
    ...(signal === undefined ? {} : { signal }),
  };
}

function fakeTime(): Pick<ProtocolDependencies, "monotonicNow" | "sleep"> {
  let now = 0;
  return {
    monotonicNow: () => now,
    sleep: async (milliseconds) => {
      now += milliseconds;
    },
  };
}

describe("Pi OAuth adapter", () => {
  let server: FakeOAuthServer;

  beforeEach(async () => {
    server = new FakeOAuthServer();
    await server.start();
  });

  afterEach(async () => {
    await server.close();
  });

  it("overlays OAuth and model refresh onto Pi's built-in provider", () => {
    const config = createHuggingFaceProviderConfig({ clientId: CLIENT_ID });
    const registrations: { name: string; config: ProviderConfig }[] = [];
    const registrar: ProviderRegistrar = {
      registerProvider: (name, registered) => {
        registrations.push({ name, config: registered });
      },
    };
    registerHuggingFaceOAuth(registrar);

    expect(registrations).toHaveLength(1);
    expect(registrations[0]?.name).toBe("huggingface");
    expect(registrations[0]?.config.oauth?.name).toBe("Hugging Face Inference Providers");
    expect(config.oauth?.name).toBe("Hugging Face Inference Providers");
    expect(typeof config.refreshModels).toBe("function");
    expect(config.models).toBeUndefined();
    expect(config.baseUrl).toBeUndefined();
    expect(config.apiKey).toBeUndefined();
    expect(config.streamSimple).toBeUndefined();
  });

  it("uses the bundled public client ID by default", () => {
    expect(resolveClientId({ env: {} })).toBe(DEFAULT_CLIENT_ID);
  });

  it("resolves an explicit client ID before the environment and bundled default", () => {
    expect(resolveClientId({ clientId: " explicit ", env: { PI_HUGGINGFACE_OAUTH_CLIENT_ID: "environment" } })).toBe(
      "explicit",
    );
    expect(resolveClientId({ env: { PI_HUGGINGFACE_OAUTH_CLIENT_ID: " environment " } })).toBe("environment");
  });

  it("rejects an empty client ID override before network access", async () => {
    const oauth = createHuggingFaceOAuth({ env: { PI_HUGGINGFACE_OAUTH_CLIENT_ID: " " } });
    const state: CallbackState = { devices: [], progress: [] };
    await expect(oauth.login(callbacks(state))).rejects.toThrow("must not be empty");
    expect(server.requests).toHaveLength(0);
  });

  it("completes device login through Pi callbacks", async () => {
    server.enqueue(
      {
        body: {
          device_code: "private-device",
          user_code: "ABCD-EFGH",
          verification_uri: "https://huggingface.co/device",
          verification_uri_complete: "https://huggingface.co/device?user_code=ABCD-EFGH",
          expires_in: 900,
          interval: 2,
        },
      },
      {
        body: {
          access_token: ACCESS_TOKEN,
          refresh_token: REFRESH_TOKEN,
          expires_in: 3600,
          token_type: "bearer",
        },
      },
    );
    const state: CallbackState = { devices: [], progress: [] };
    const oauth = createHuggingFaceOAuth({
      clientId: CLIENT_ID,
      protocol: { endpoints: server.endpoints(), ...fakeTime() },
      wallNow: () => 1_000_000,
    });

    await expect(oauth.login(callbacks(state))).resolves.toEqual({
      access: ACCESS_TOKEN,
      refresh: REFRESH_TOKEN,
      expires: 4_300_000,
    });
    expect(state.devices).toEqual([
      {
        userCode: "ABCD-EFGH",
        verificationUri: "https://huggingface.co/device?user_code=ABCD-EFGH",
        intervalSeconds: 2,
        expiresInSeconds: 900,
      },
    ]);
    expect(state.progress).toEqual([]);
  });

  it("preserves or rotates the refresh token", async () => {
    server.enqueue(
      { body: { access_token: "access-1", expires_in: 600, token_type: "bearer" } },
      { body: { access_token: "access-2", refresh_token: "refresh-2", expires_in: 600 } },
    );
    const oauth = createHuggingFaceOAuth({
      clientId: CLIENT_ID,
      protocol: { endpoints: server.endpoints(), ...fakeTime() },
      wallNow: () => 10_000,
    });
    const current = { access: ACCESS_TOKEN, refresh: REFRESH_TOKEN, expires: 0 };

    const signal = new AbortController().signal;
    await expect(oauth.refreshToken(current, signal)).resolves.toMatchObject({
      access: "access-1",
      refresh: REFRESH_TOKEN,
    });
    await expect(oauth.refreshToken(current, signal)).resolves.toMatchObject({
      access: "access-2",
      refresh: "refresh-2",
    });
  });

  it("returns only a non-empty access token to Pi", () => {
    const oauth = createHuggingFaceOAuth({ clientId: CLIENT_ID });
    expect(oauth.getApiKey({ access: ACCESS_TOKEN, refresh: REFRESH_TOKEN, expires: 1 })).toBe(ACCESS_TOKEN);
    expect(() => oauth.getApiKey({ access: "", refresh: REFRESH_TOKEN, expires: 1 })).toThrow(HuggingFaceOAuthError);
  });

  it("applies a five-minute skew without expiring short-lived credentials immediately", () => {
    expect(credentialExpiry(1_000_000, 3600)).toBe(4_300_000);
    expect(credentialExpiry(1_000_000, 60)).toBe(1_054_000);
    expect(credentialExpiry(1_000_000, 1)).toBe(1_000_001);
  });
});
