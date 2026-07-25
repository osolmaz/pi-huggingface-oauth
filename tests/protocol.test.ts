import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HuggingFaceOAuthCancelledError, HuggingFaceOAuthError } from "../src/errors.js";
import { pollDeviceToken, refreshAccessToken, requestDeviceAuthorization } from "../src/protocol.js";
import type { DeviceAuthorization, ProtocolDependencies } from "../src/types.js";
import { FakeOAuthServer } from "./fake-oauth-server.js";

const CLIENT_ID = "pi-oauth-client-id";
const ACCESS_TOKEN = "hf_access_secret_123456";
const REFRESH_TOKEN = "hf_refresh_secret_123456";
const DEVICE_CODE = "private-device-code-123456";

function device(overrides: Partial<DeviceAuthorization> = {}): DeviceAuthorization {
  return {
    deviceCode: DEVICE_CODE,
    userCode: "ABCD-EFGH",
    verificationUri: "https://huggingface.co/activate",
    verificationUriComplete: "https://huggingface.co/activate?user_code=ABCD-EFGH",
    expiresInSeconds: 30,
    intervalSeconds: 1,
    ...overrides,
  };
}

function deviceResponse(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    device_code: DEVICE_CODE,
    user_code: "ABCD-EFGH",
    verification_uri: "https://huggingface.co/activate",
    verification_uri_complete: "https://huggingface.co/activate?user_code=ABCD-EFGH",
    expires_in: 900,
    interval: 2,
    ...overrides,
  };
}

function tokenResponse(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    access_token: ACCESS_TOKEN,
    refresh_token: REFRESH_TOKEN,
    expires_in: 3600,
    token_type: "Bearer",
    ...overrides,
  };
}

type FakeClock = {
  readonly waits: number[];
  readonly dependencies: Pick<ProtocolDependencies, "monotonicNow" | "sleep">;
};

function fakeClock(): FakeClock {
  let now = 0;
  const waits: number[] = [];
  return {
    waits,
    dependencies: {
      monotonicNow: () => now,
      sleep: async (milliseconds, signal) => {
        if (signal?.aborted === true) throw new HuggingFaceOAuthCancelledError("token polling");
        waits.push(milliseconds);
        now += milliseconds;
      },
    },
  };
}

describe("Hugging Face OAuth protocol", () => {
  let server: FakeOAuthServer;

  beforeEach(async () => {
    server = new FakeOAuthServer();
    await server.start();
  });

  afterEach(async () => {
    await server.close();
  });

  it("requests and validates a device authorization", async () => {
    server.enqueue({ body: deviceResponse() });
    const result = await requestDeviceAuthorization(CLIENT_ID, {}, { endpoints: server.endpoints() });

    expect(result).toEqual(device({ expiresInSeconds: 900, intervalSeconds: 2 }));
    expect(server.requests[0]?.path).toBe("/oauth/device");
    expect(server.requests[0]?.form.get("client_id")).toBe(CLIENT_ID);
    expect(server.requests[0]?.form.get("scope")).toBe("inference-api");
    expect(server.requests[0]?.headers["content-type"]).toBe("application/x-www-form-urlencoded");
  });

  it("uses RFC defaults for optional device fields", async () => {
    server.enqueue({
      body: deviceResponse({ verification_uri_complete: undefined, interval: undefined }),
    });
    const result = await requestDeviceAuthorization(CLIENT_ID, {}, { endpoints: server.endpoints() });

    expect(result.verificationUriComplete).toBe("https://huggingface.co/activate");
    expect(result.intervalSeconds).toBe(5);
  });

  it.each([
    ["cross-origin verification URL", { verification_uri: "https://example.com/activate" }],
    ["HTTP verification URL", { verification_uri: "http://huggingface.co/activate" }],
    ["missing device code", { device_code: "" }],
    ["invalid lifetime", { expires_in: Number.POSITIVE_INFINITY }],
    ["invalid interval", { interval: 0 }],
  ])("rejects %s", async (_name, override) => {
    server.enqueue({ body: deviceResponse(override) });
    await expect(requestDeviceAuthorization(CLIENT_ID, {}, { endpoints: server.endpoints() })).rejects.toThrow(
      HuggingFaceOAuthError,
    );
  });

  it("rejects malformed, oversized, and redirected device responses", async () => {
    server.enqueue({ rawBody: "not json" });
    await expect(requestDeviceAuthorization(CLIENT_ID, {}, { endpoints: server.endpoints() })).rejects.toThrow(
      "malformed JSON",
    );

    server.enqueue({ rawBody: "x".repeat(100), headers: { "content-length": "100" } });
    await expect(
      requestDeviceAuthorization(CLIENT_ID, {}, { endpoints: server.endpoints(), maxResponseBytes: 20 }),
    ).rejects.toThrow("oversized response");

    server.enqueue({ status: 302, headers: { location: "https://example.com" } });
    await expect(requestDeviceAuthorization(CLIENT_ID, {}, { endpoints: server.endpoints() })).rejects.toThrow(
      "unexpected redirect",
    );
  });

  it("times out a stalled response body", async () => {
    const stalledResponse = new Response(new ReadableStream<Uint8Array>());
    await expect(
      requestDeviceAuthorization(
        CLIENT_ID,
        {},
        { fetch: async () => stalledResponse, endpoints: server.endpoints(), httpTimeoutMs: 10 },
      ),
    ).rejects.toThrow("response timed out");
  });

  it("counts response-header time against the HTTP deadline", async () => {
    let now = 0;
    await expect(
      requestDeviceAuthorization(
        CLIENT_ID,
        {},
        {
          fetch: async () => {
            now = 100;
            return new Response(JSON.stringify(deviceResponse()));
          },
          httpTimeoutMs: 100,
          monotonicNow: () => now,
        },
      ),
    ).rejects.toThrow("device authorization timed out");
  });

  it("cancels while reading a response body", async () => {
    server.enqueue({ bodyDelayMs: 500, body: deviceResponse() });
    const controller = new AbortController();
    const pending = requestDeviceAuthorization(
      CLIENT_ID,
      { signal: controller.signal },
      { endpoints: server.endpoints() },
    );
    setTimeout(() => {
      controller.abort();
    }, 20);
    await expect(pending).rejects.toBeInstanceOf(HuggingFaceOAuthCancelledError);
  });

  it("polls quietly after waiting and handles authorization_pending", async () => {
    server.enqueue({ status: 400, body: { error: "authorization_pending" } }, { body: tokenResponse() });
    const clock = fakeClock();
    const result = await pollDeviceToken(
      CLIENT_ID,
      device(),
      {},
      {
        endpoints: server.endpoints(),
        ...clock.dependencies,
      },
    );

    expect(result).toEqual({ accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN, expiresInSeconds: 3600 });
    expect(clock.waits).toEqual([1000, 1000]);
    expect(server.requests[0]?.form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
    expect(server.requests[0]?.form.get("device_code")).toBe(DEVICE_CODE);
  });

  it("adds five seconds after slow_down", async () => {
    server.enqueue({ status: 400, body: { error: "slow_down" } }, { body: tokenResponse() });
    const clock = fakeClock();
    await pollDeviceToken(CLIENT_ID, device(), {}, { endpoints: server.endpoints(), ...clock.dependencies });
    expect(clock.waits).toEqual([1000, 6000]);
  });

  it("retries rate limits and server errors until success", async () => {
    server.enqueue({ status: 500, rawBody: "gateway" }, { status: 429, rawBody: "slow" }, { body: tokenResponse() });
    const clock = fakeClock();
    await expect(
      pollDeviceToken(CLIENT_ID, device(), {}, { endpoints: server.endpoints(), ...clock.dependencies }),
    ).resolves.toMatchObject({ accessToken: ACCESS_TOKEN });
    expect(server.requests).toHaveLength(3);
  });

  it("expires after repeated transient failures", async () => {
    server.enqueue({ status: 500 }, { status: 500 }, { status: 500 });
    const clock = fakeClock();
    await expect(
      pollDeviceToken(
        CLIENT_ID,
        device({ expiresInSeconds: 3 }),
        {},
        { endpoints: server.endpoints(), ...clock.dependencies },
      ),
    ).rejects.toMatchObject({ code: "expired_token" });
    expect(server.requests).toHaveLength(2);
    expect(clock.waits).toEqual([1000, 1000, 1000]);
  });

  it("caps the final polling wait at the device deadline", async () => {
    server.enqueue({ status: 500 }, { status: 500 }, { status: 500 });
    const clock = fakeClock();
    await expect(
      pollDeviceToken(
        CLIENT_ID,
        device({ expiresInSeconds: 5, intervalSeconds: 2 }),
        {},
        { endpoints: server.endpoints(), ...clock.dependencies },
      ),
    ).rejects.toMatchObject({ code: "expired_token" });
    expect(clock.waits).toEqual([2000, 2000, 1000]);
    expect(server.requests).toHaveLength(2);
  });

  it.each([
    ["access_denied", "authorization was denied"],
    ["expired_token", "device code expired"],
  ])("stops on %s", async (code, message) => {
    server.enqueue({ status: 400, body: { error: code } });
    const clock = fakeClock();
    await expect(
      pollDeviceToken(CLIENT_ID, device(), {}, { endpoints: server.endpoints(), ...clock.dependencies }),
    ).rejects.toThrow(message);
  });

  it("redacts secrets from unexpected polling errors", async () => {
    server.enqueue({
      status: 400,
      body: { error: DEVICE_CODE, error_description: `device_code=${DEVICE_CODE} Bearer ${ACCESS_TOKEN}` },
    });
    const clock = fakeClock();
    let caught: unknown;
    try {
      await pollDeviceToken(CLIENT_ID, device(), {}, { endpoints: server.endpoints(), ...clock.dependencies });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "[redacted]" });
    expect(String(caught)).not.toContain(DEVICE_CODE);
    expect(String(caught)).not.toContain(ACCESS_TOKEN);
    expect(String(caught)).toContain("[redacted]");
  });

  it("rejects malformed successful token responses", async () => {
    server.enqueue({ body: tokenResponse({ refresh_token: "" }) });
    const clock = fakeClock();
    await expect(
      pollDeviceToken(CLIENT_ID, device(), {}, { endpoints: server.endpoints(), ...clock.dependencies }),
    ).rejects.toThrow("invalid refresh_token");
  });

  it("cancels during a wait", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(pollDeviceToken(CLIENT_ID, device(), { signal: controller.signal })).rejects.toBeInstanceOf(
      HuggingFaceOAuthCancelledError,
    );
    expect(server.requests).toHaveLength(0);
  });

  it("cancels an in-flight token request", async () => {
    server.enqueue({ delayMs: 500, body: tokenResponse() });
    const controller = new AbortController();
    const clock = fakeClock();
    const pending = pollDeviceToken(
      CLIENT_ID,
      device(),
      { signal: controller.signal },
      { endpoints: server.endpoints(), ...clock.dependencies },
    );
    setTimeout(() => {
      controller.abort();
    }, 20);
    await expect(pending).rejects.toBeInstanceOf(HuggingFaceOAuthCancelledError);
  });

  it("refreshes tokens and accepts refresh-token rotation", async () => {
    server.enqueue({ body: tokenResponse({ access_token: "new-access", refresh_token: "new-refresh" }) });
    await expect(refreshAccessToken(CLIENT_ID, REFRESH_TOKEN, {}, { endpoints: server.endpoints() })).resolves.toEqual({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      expiresInSeconds: 3600,
    });
    expect(server.requests[0]?.form.get("grant_type")).toBe("refresh_token");
    expect(server.requests[0]?.form.get("refresh_token")).toBe(REFRESH_TOKEN);
  });

  it("allows refresh responses to omit refresh-token rotation", async () => {
    server.enqueue({ body: tokenResponse({ refresh_token: undefined }) });
    await expect(refreshAccessToken(CLIENT_ID, REFRESH_TOKEN, {}, { endpoints: server.endpoints() })).resolves.toEqual({
      accessToken: ACCESS_TOKEN,
      refreshToken: undefined,
      expiresInSeconds: 3600,
    });
  });

  it("retries transient refresh failures with bounded delays", async () => {
    server.enqueue({ status: 500 }, { status: 429 }, { body: tokenResponse() });
    const clock = fakeClock();
    await refreshAccessToken(CLIENT_ID, REFRESH_TOKEN, {}, { endpoints: server.endpoints(), ...clock.dependencies });
    expect(clock.waits).toEqual([250, 500]);
    expect(server.requests).toHaveLength(3);
  });

  it("counts response-header time against each refresh deadline", async () => {
    let now = 0;
    let requests = 0;
    await expect(
      refreshAccessToken(
        CLIENT_ID,
        REFRESH_TOKEN,
        {},
        {
          fetch: async () => {
            requests += 1;
            now += 100;
            return new Response(JSON.stringify(tokenResponse()));
          },
          httpTimeoutMs: 100,
          monotonicNow: () => now,
          sleep: async () => undefined,
        },
      ),
    ).rejects.toThrow("token refresh timed out");
    expect(requests).toBe(3);
  });

  it("redacts a refresh token echoed as an OAuth error code", async () => {
    server.enqueue({ status: 400, body: { error: REFRESH_TOKEN } });
    let caught: unknown;
    try {
      await refreshAccessToken(CLIENT_ID, REFRESH_TOKEN, {}, { endpoints: server.endpoints() });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "[redacted]" });
    expect(String(caught)).not.toContain(REFRESH_TOKEN);
  });

  it("reports invalid_grant without exposing the refresh token", async () => {
    server.enqueue({
      status: 400,
      body: { error: "invalid_grant", error_description: `revoked ${REFRESH_TOKEN}` },
    });
    let caught: unknown;
    try {
      await refreshAccessToken(CLIENT_ID, REFRESH_TOKEN, {}, { endpoints: server.endpoints() });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "invalid_grant" });
    expect(String(caught)).toContain("Run /login again");
    expect(String(caught)).not.toContain(REFRESH_TOKEN);
  });
});
