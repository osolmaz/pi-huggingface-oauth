import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import type { ModelsPublication, ModelsStoreEntry, RefreshModelsContext } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createHuggingFaceProviderConfig } from "../index.js";
import {
  deriveProviderModelOptions,
  HUGGING_FACE_MODELS_URL,
  parseRouterCatalog,
  type ModelCatalogOptions,
} from "../src/model-catalog.js";
import type { FetchLike } from "../src/types.js";

const GLM_ID = "zai-org/GLM-5.2";
const NOW = 10_000_000;

function provider(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    provider: "novita",
    status: "live",
    context_length: 1_048_576,
    pricing: { input: 1.4, output: 4.4 },
    is_free: false,
    supports_tools: true,
    ...overrides,
  };
}

function payload(providers: readonly unknown[] = [provider()]): unknown {
  return { object: "list", data: [{ id: GLM_ID, object: "model", providers }] };
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

class MemoryStore {
  public entry: ModelsStoreEntry | undefined;

  public constructor(entry?: ModelsStoreEntry) {
    this.entry = entry;
  }

  public publish(publication: ModelsPublication): Promise<boolean> {
    if (publication.persist === null) {
      this.entry = undefined;
    } else if (publication.persist !== undefined) {
      this.entry = publication.persist;
    }
    publication.update?.();
    return Promise.resolve(true);
  }
}

function refreshContext(
  store: MemoryStore,
  overrides: Partial<Pick<RefreshModelsContext, "allowNetwork" | "signal">> = {},
): RefreshModelsContext {
  return {
    ...(store.entry === undefined ? {} : { stored: store.entry }),
    publish: (publication) => store.publish(publication),
    allowNetwork: overrides.allowNetwork ?? true,
    signal: overrides.signal ?? new AbortController().signal,
  };
}

function route<T extends { id: string }>(models: readonly T[], id: string): T | undefined {
  return models.find((model) => model.id === id);
}

function requestUrl(input: string | URL | Request | undefined): string | undefined {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input?.url;
}

function catalogRefresh(options: ModelCatalogOptions) {
  const config = createHuggingFaceProviderConfig({
    clientId: "test-client",
    env: {},
    modelCatalog: { localCatalogModifiedAt: async () => 0, ...options },
  });
  return (context: RefreshModelsContext) => {
    if (config.refreshModels === undefined) throw new Error("Expected a refreshable provider");
    return config.refreshModels(context);
  };
}

async function refreshProvider(refreshModels: ReturnType<typeof catalogRefresh>, context: RefreshModelsContext) {
  return refreshModels(context);
}

describe("Hugging Face router catalog", () => {
  it("derives provider-specific options beside all canonical automatic models", () => {
    const models = deriveProviderModelOptions(parseRouterCatalog(payload()));
    const canonical = getBuiltinModels("huggingface");
    const automatic = route(models, GLM_ID);
    const novita = models.find((model) => model.id === `${GLM_ID}:novita`);

    expect(models).toHaveLength(canonical.length + 1);
    expect(automatic?.name).toContain("· Auto");
    expect(novita).toMatchObject({
      id: `${GLM_ID}:novita`,
      name: "GLM-5.2 · Novita",
      api: "openai-completions",
      baseUrl: "https://router.huggingface.co/v1",
      contextWindow: 1_048_576,
      cost: { input: 1.4, output: 4.4, cacheRead: 0, cacheWrite: 0 },
    });
    expect(novita?.reasoning).toBe(canonical.find((model) => model.id === GLM_ID)?.reasoning);
  });

  it("keeps live tool routes and labels routes without a published price", () => {
    const models = deriveProviderModelOptions(
      parseRouterCatalog(
        payload([
          provider(),
          provider({ provider: "fireworks-ai", pricing: { input: 1, output: 2 } }),
          provider({ provider: "error-route", status: "error" }),
          provider({ provider: "no-tools", supports_tools: false }),
          provider({ provider: "no-context", context_length: undefined }),
          provider({ provider: "no-price", pricing: undefined }),
          provider({ provider: "half-price", pricing: { input: 1 } }),
          provider({ provider: "free-route", pricing: undefined, is_free: true }),
        ]),
      ),
    );

    expect(models.filter((model) => model.id.startsWith(`${GLM_ID}:`)).map((model) => model.id)).toEqual([
      `${GLM_ID}:novita`,
      `${GLM_ID}:fireworks-ai`,
      `${GLM_ID}:no-price`,
      `${GLM_ID}:half-price`,
      `${GLM_ID}:free-route`,
    ]);
    expect(route(models, `${GLM_ID}:no-price`)).toMatchObject({
      name: "GLM-5.2 · No Price (price not published)",
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_048_576,
    });
    expect(route(models, `${GLM_ID}:half-price`)?.name).toBe("GLM-5.2 · Half Price (price not published)");
    expect(route(models, `${GLM_ID}:fireworks-ai`)?.name).toBe("GLM-5.2 · Fireworks");
    expect(route(models, `${GLM_ID}:free-route`)).toMatchObject({
      name: "GLM-5.2 · Free Route",
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
  });

  it("deduplicates models and providers while preserving first-seen order", () => {
    const duplicateModel = { id: GLM_ID, providers: [provider({ provider: "ignored" })] };
    const catalog = parseRouterCatalog({
      data: [{ id: GLM_ID, providers: [provider(), provider({ pricing: { input: 99, output: 99 } })] }, duplicateModel],
    });

    expect(catalog.models).toHaveLength(1);
    expect(catalog.models[0]?.providers).toEqual([
      { id: "novita", contextWindow: 1_048_576, pricing: { inputPrice: 1.4, outputPrice: 4.4 } },
    ]);
    expect(
      parseRouterCatalog(payload([provider({ provider: "no-price", pricing: undefined })])).models[0]?.providers,
    ).toEqual([{ id: "no-price", contextWindow: 1_048_576 }]);
  });

  it.each([
    null,
    {},
    { data: null },
    { data: [{ id: GLM_ID }] },
    { data: [{ id: "", providers: [] }] },
    { data: [{ id: GLM_ID, providers: "novita" }] },
  ])("rejects malformed catalog structures", (value) => {
    expect(() => parseRouterCatalog(value)).toThrow(/invalid/u);
  });
});

describe("Hugging Face model refresh", () => {
  it("fetches the public catalog without sending credentials", async () => {
    const requests: { input: string | URL | Request; init: RequestInit | undefined }[] = [];
    const fetch: FetchLike = async (input, init) => {
      requests.push({ input, init });
      return jsonResponse(payload());
    };
    const store = new MemoryStore();
    const refreshModels = catalogRefresh({ fetch, now: () => NOW });

    const models = await refreshProvider(refreshModels, refreshContext(store));

    expect(route(models, `${GLM_ID}:novita`)).toBeDefined();
    expect(requests).toHaveLength(1);
    expect(requestUrl(requests[0]?.input)).toBe(HUGGING_FACE_MODELS_URL);
    expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBeNull();
    expect(store.entry?.models).toHaveLength(getBuiltinModels("huggingface").length + 1);
    expect(store.entry?.models.some((model) => model.id === `${GLM_ID}:novita`)).toBe(true);
    expect(store.entry?.checkedAt).toBe(NOW);
  });

  it("uses Pi's generated catalog timestamp during a default refresh", async () => {
    const config = createHuggingFaceProviderConfig({
      clientId: "test-client",
      env: {},
      modelCatalog: { fetch: async () => jsonResponse(payload()), now: () => NOW },
    });
    if (config.refreshModels === undefined) throw new Error("Expected a refreshable provider");

    const models = await config.refreshModels(refreshContext(new MemoryStore()));

    expect(route(models, `${GLM_ID}:novita`)).toBeDefined();
  });

  it("restores provider routes without network access", async () => {
    const store = new MemoryStore();
    const online = catalogRefresh({ fetch: async () => jsonResponse(payload()), now: Date.now });
    await refreshProvider(online, refreshContext(store));
    const fetch = vi.fn<FetchLike>();
    const offline = catalogRefresh({ fetch, now: Date.now });

    const models = await refreshProvider(offline, refreshContext(store, { allowNetwork: false }));

    expect(route(models, `${GLM_ID}:novita`)).toBeDefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("restores a route without a published price with its label and zero rates", async () => {
    const store = new MemoryStore();
    const online = catalogRefresh({
      fetch: async () => jsonResponse(payload([provider({ provider: "fireworks-ai", pricing: undefined })])),
      now: () => NOW,
    });
    await refreshProvider(online, refreshContext(store));
    const stored = store.entry?.models.find((model) => model.id === `${GLM_ID}:fireworks-ai`);

    expect(stored?.name).toBe("GLM-5.2 · Fireworks (price not published)");
    expect(stored?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

    const fetch = vi.fn<FetchLike>();
    const offline = catalogRefresh({ fetch, now: () => NOW });
    const models = await refreshProvider(offline, refreshContext(store, { allowNetwork: false }));

    expect(route(models, `${GLM_ID}:fireworks-ai`)).toMatchObject({
      name: "GLM-5.2 · Fireworks (price not published)",
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_048_576,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refreshes the router catalog even when the stored snapshot is recent", async () => {
    const store = new MemoryStore();
    const first = catalogRefresh({ fetch: async () => jsonResponse(payload()), now: () => NOW });
    await refreshProvider(first, refreshContext(store));
    const secondFetch = vi.fn<FetchLike>(async () => jsonResponse(payload([provider({ provider: "fireworks-ai" })])));
    const second = catalogRefresh({ fetch: secondFetch, now: () => NOW + 1_000 });

    const models = await refreshProvider(second, refreshContext(store));

    expect(secondFetch).toHaveBeenCalledOnce();
    expect(store.entry?.checkedAt).toBe(NOW + 1_000);
    expect(route(models, `${GLM_ID}:fireworks-ai`)).toBeDefined();
  });

  it("adds a route that an older stored snapshot lacks on the next refresh", async () => {
    const store = new MemoryStore();
    const older = catalogRefresh({ fetch: async () => jsonResponse(payload()), now: () => NOW });
    await refreshProvider(older, refreshContext(store));
    expect(store.entry?.models.some((model) => model.id === `${GLM_ID}:fireworks-ai`)).toBe(false);

    const upgraded = catalogRefresh({
      fetch: async () =>
        jsonResponse(payload([provider(), provider({ provider: "fireworks-ai", pricing: undefined })])),
      now: () => NOW + 60_000,
    });
    const models = await refreshProvider(upgraded, refreshContext(store));

    expect(route(models, `${GLM_ID}:fireworks-ai`)).toMatchObject({
      name: "GLM-5.2 · Fireworks (price not published)",
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    expect(store.entry?.models.some((model) => model.id === `${GLM_ID}:fireworks-ai`)).toBe(true);
  });

  it("replaces stored routes with the routes the router publishes", async () => {
    const store = new MemoryStore();
    const first = catalogRefresh({
      fetch: async () => jsonResponse(payload([provider(), provider({ provider: "fireworks-ai" })])),
      now: () => NOW,
    });
    await refreshProvider(first, refreshContext(store));
    const second = catalogRefresh({ fetch: async () => jsonResponse(payload()), now: () => NOW + 1_000 });

    const models = await refreshProvider(second, refreshContext(store));

    expect(route(models, `${GLM_ID}:fireworks-ai`)).toBeUndefined();
    expect(route(models, `${GLM_ID}:novita`)).toBeDefined();
  });

  it("keeps the last stored catalog when a refresh fails", async () => {
    const store = new MemoryStore();
    const first = catalogRefresh({ fetch: async () => jsonResponse(payload()), now: () => NOW });
    await refreshProvider(first, refreshContext(store));
    const before = structuredClone(store.entry);
    const failing = catalogRefresh({ fetch: async () => new Response(null, { status: 503 }), now: () => NOW + 1_000 });

    await expect(refreshProvider(failing, refreshContext(store))).rejects.toThrow(/status 503/u);

    expect(store.entry).toEqual(before);
  });

  it("stores a successful catalog with no eligible routes and refreshes it later", async () => {
    const store = new MemoryStore();
    const fetch = vi.fn<FetchLike>(async () => jsonResponse(payload([])));

    const initial = await refreshProvider(catalogRefresh({ fetch, now: () => NOW }), refreshContext(store));
    const restored = await refreshProvider(catalogRefresh({ fetch, now: () => NOW + 1_000 }), refreshContext(store));

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(initial).toHaveLength(getBuiltinModels("huggingface").length);
    expect(restored).toHaveLength(getBuiltinModels("huggingface").length);
    expect(store.entry?.checkedAt).toBe(NOW + 1_000);
  });

  it("preserves Pi's newer remote canonical models beside validated routes", async () => {
    const canonical = getBuiltinModels("huggingface")[0];
    if (canonical === undefined) throw new Error("Expected a canonical Hugging Face model");
    const future = { ...canonical, id: "future/model", name: "Future model" };
    const store = new MemoryStore({ models: [future], checkedAt: NOW - 1, lastModified: NOW });
    const refreshModels = catalogRefresh({ fetch: async () => jsonResponse(payload()), now: () => NOW });

    const models = await refreshProvider(refreshModels, refreshContext(store));

    expect(route(models, "future/model")?.name).toBe("Future model · Auto");
    expect(route(models, `${GLM_ID}:novita`)).toBeDefined();
    expect(store.entry?.models.some((model) => model.id === "future/model")).toBe(true);
  });

  it("labels a route once when the canonical entry already carries the automatic label", async () => {
    const canonical = getBuiltinModels("huggingface")[0];
    if (canonical === undefined) throw new Error("Expected a canonical Hugging Face model");
    const future = { ...canonical, id: "future/model", name: "Future model · Auto" };
    const store = new MemoryStore({ models: [future], checkedAt: NOW, lastModified: NOW });
    const refreshModels = catalogRefresh({
      fetch: async () => jsonResponse({ data: [{ id: "future/model", providers: [provider()] }] }),
      now: () => NOW,
    });

    const models = await refreshProvider(refreshModels, refreshContext(store));

    expect(route(models, "future/model")?.name).toBe("Future model · Auto");
    expect(route(models, "future/model:novita")?.name).toBe("Future model · Novita");
  });

  it("composes with Pi's remote-catalog provider instead of replacing it", async () => {
    const canonical = getBuiltinModels("huggingface")[0];
    if (canonical === undefined) throw new Error("Expected a canonical Hugging Face model");
    const future = { ...canonical, id: "future/model", name: "Future model" };
    const modelsStore = new InMemoryModelsStore();
    await modelsStore.write("huggingface", {
      models: [future],
      checkedAt: NOW,
      lastModified: Number.MAX_SAFE_INTEGER,
    });
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("huggingface", async () => ({ type: "api_key", key: "test-token" }));
    const runtime = await ModelRuntime.create({ credentials, modelsPath: null, modelsStore });
    const config = createHuggingFaceProviderConfig({
      clientId: "test-client",
      env: {},
      modelCatalog: {
        fetch: async () => jsonResponse(payload()),
        localCatalogModifiedAt: async () => 0,
        now: () => NOW,
      },
    });

    runtime.registerProvider("huggingface", config);
    await runtime.refresh({ allowNetwork: false });

    const registered = runtime.getRegisteredProviderConfig("huggingface");
    expect(runtime.getRegisteredNativeProvider("huggingface")).toBeUndefined();
    expect(registered?.oauth?.name).toBe("Hugging Face Inference Providers");
    expect(typeof registered?.refreshModels).toBe("function");
    expect(runtime.getModel("huggingface", "future/model")?.name).toBe("Future model · Auto");
    expect(runtime.getModel("huggingface", GLM_ID)).toBeDefined();
  });

  it("rejects redirects, HTTP failures, malformed JSON, and oversized responses", async () => {
    const cases: { fetch: FetchLike; message: RegExp }[] = [
      { fetch: async () => new Response(null, { status: 302 }), message: /unexpected redirect/u },
      { fetch: async () => new Response(null, { status: 503 }), message: /status 503/u },
      { fetch: async () => new Response("not-json"), message: /malformed JSON/u },
      {
        fetch: async () => new Response("{}", { headers: { "content-length": "100" } }),
        message: /oversized response/u,
      },
    ];
    for (const testCase of cases) {
      const refreshModels = catalogRefresh({ fetch: testCase.fetch, maxResponseBytes: 10, now: () => NOW });
      await expect(refreshProvider(refreshModels, refreshContext(new MemoryStore()))).rejects.toThrow(testCase.message);
    }
  });

  it("applies one deadline to fetching and reading the response", async () => {
    const neverFetch: FetchLike = async () => new Promise<Response>(() => undefined);
    const stalledBody = new ReadableStream<Uint8Array>({ start: () => undefined });
    const fetches: FetchLike[] = [neverFetch, async () => new Response(stalledBody)];
    for (const fetch of fetches) {
      const refreshModels = catalogRefresh({ fetch, timeoutMs: 5, now: () => NOW });
      await expect(refreshProvider(refreshModels, refreshContext(new MemoryStore()))).rejects.toThrow(/timed out/u);
    }
  });

  it("honors cancellation before and during a request", async () => {
    const before = new AbortController();
    before.abort();
    const fetch = vi.fn<FetchLike>();
    const refreshModels = catalogRefresh({ fetch, now: () => NOW });
    await expect(
      refreshProvider(refreshModels, refreshContext(new MemoryStore(), { signal: before.signal })),
    ).resolves.toHaveLength(getBuiltinModels("huggingface").length);
    expect(fetch).not.toHaveBeenCalled();

    const during = new AbortController();
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const pending: FetchLike = async () => {
      markStarted();
      return new Promise<Response>(() => undefined);
    };
    const request = refreshProvider(
      catalogRefresh({ fetch: pending, timeoutMs: 1_000, now: () => NOW }),
      refreshContext(new MemoryStore(), { signal: during.signal }),
    );
    await started;
    during.abort();
    await expect(request).rejects.toThrow(/cancelled/u);
  });
});
