import { describe, expect, it, vi } from "vitest";
import { readBoundedJson } from "../src/http.js";

describe("bounded OAuth responses", () => {
  it("cancels a response body rejected by Content-Length", async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel,
      }),
      { headers: { "content-length": "100" } },
    );

    await expect(readBoundedJson(response, 20, "device authorization", { timeoutMs: 100 })).rejects.toThrow(
      "oversized response",
    );
    expect(cancel).toHaveBeenCalledOnce();
  });
});
