import { describe, expect, it } from "vitest";
import { parseDeviceAuthorization, parseOAuthError, parseRefreshGrant, parseTokenGrant } from "../src/validation.js";

function validDevice(): Record<string, unknown> {
  return {
    device_code: "device",
    user_code: "CODE",
    verification_uri: "https://huggingface.co/device",
    expires_in: 900,
  };
}

function validToken(): Record<string, unknown> {
  return {
    access_token: "access",
    refresh_token: "refresh",
    expires_in: 3600,
  };
}

describe("OAuth response validation", () => {
  it("rejects non-object response roots", () => {
    expect(() => parseDeviceAuthorization([])).toThrow("invalid JSON data");
    expect(() => parseTokenGrant(null)).toThrow("invalid JSON data");
    expect(() => parseRefreshGrant("token")).toThrow("invalid JSON data");
  });

  it("rejects invalid optional device fields", () => {
    expect(() => parseDeviceAuthorization({ ...validDevice(), verification_uri_complete: 3 })).toThrow(
      "invalid verification_uri_complete",
    );
    expect(() => parseDeviceAuthorization({ ...validDevice(), interval: 61 })).toThrow("invalid interval");
    expect(() => parseDeviceAuthorization({ ...validDevice(), user_code: "unsafe\u0007code" })).toThrow(
      "invalid user_code",
    );
    expect(() => parseDeviceAuthorization({ ...validDevice(), user_code: "x".repeat(129) })).toThrow(
      "invalid user_code",
    );
    expect(() =>
      parseDeviceAuthorization({ ...validDevice(), verification_uri: "https://name:password@huggingface.co/device" }),
    ).toThrow("invalid verification_uri");
  });

  it("rejects unsupported token types and lifetimes", () => {
    expect(() => parseTokenGrant({ ...validToken(), token_type: "mac" })).toThrow("unsupported token_type");
    expect(() => parseRefreshGrant({ access_token: "access", expires_in: 0 })).toThrow("invalid expires_in");
    expect(() => parseRefreshGrant({ access_token: "access", refresh_token: 5, expires_in: 60 })).toThrow(
      "invalid refresh_token",
    );
  });

  it("parses OAuth errors without trusting unrelated fields", () => {
    expect(parseOAuthError({ error: "invalid_request" })).toEqual({ code: "invalid_request", description: "" });
    expect(parseOAuthError({ error: "invalid_request", error_description: 7 })).toEqual({
      code: "invalid_request",
      description: "",
    });
    expect(parseOAuthError({ error: "" })).toBeUndefined();
    expect(parseOAuthError([])).toBeUndefined();
  });
});
