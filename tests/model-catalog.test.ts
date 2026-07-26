import type {
  Api,
  Model,
  ModelsStoreEntry,
  Provider,
  ProviderModelsStore,
  RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it, vi } from "vitest";
import { createHuggingFaceProvider } from "../index.js";
import {
  deriveProviderModelOptions,
  HUGGING_FACE_MODELS_URL,
  MODEL_CATALOG_REFRESH_INTERVAL_MS,
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

class MemoryStore implements ProviderModelsStore {
  public entry: ModelsStoreEntry | undefined;

  public constructor(entry?: ModelsStoreEntry) {
    this.entry = entry;
  }

  public async read(): Promise<ModelsStoreEntry | undefined> {
    return this.entry;
  }

  public async write(entry: ModelsStoreEntry): Promise<void> {
    this.entry = entry;
  }

  public async delete(): Promise<void> {
    this.entry = undefined;
  }
}

function refreshContext(
  store: ProviderModelsStore,
  overrides: Partial<Pick<RefreshModelsContext, "allowNetwork" | "force" | "signal">> = {},
): RefreshModelsContext {
  return {
    store,
    allowNetwork: overrides.allowNetwork ?? true,
    ...(overrides.force === undefined ? {} : { force: overrides.force }),
    ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
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

function catalogProvider(options: ModelCatalogOptions): Provider {
  return createHuggingFaceProvider({ clientId: "test-client", env: {}, modelCatalog: options });
}

async function refreshProvider(provider: Provider, context: RefreshModelsContext): Promise<readonly Model<Api>[]> {
  if (provider.refreshModels === undefined) throw new Error("Expected a refreshable provider");
  await provider.refreshModels(context);
  return provider.getModels();
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

  it("keeps live tool routes with complete limits and prices", () => {
    const models = deriveProviderModelOptions(
      parseRouterCatalog(
        payload([
          provider(),
          provider({ provider: "fireworks-ai", pricing: { input: 1, output: 2 } }),
          provider({ provider: "error-route", status: "error" }),
          provider({ provider: "no-tools", supports_tools: false }),
          provider({ provider: "no-context", context_length: undefined }),
          provider({ provider: "no-price", pricing: undefined }),
          provider({ provider: "free-route", pricing: undefined, is_free: true }),
        ]),
      ),
    );

    expect(models.filter((model) => model.id.startsWith(`${GLM_ID}:`)).map((model) => model.id)).toEqual([
      `${GLM_ID}:novita`,
      `${GLM_ID}:fireworks-ai`,
      `${GLM_ID}:free-route`,
    ]);
    expect(models.find((model) => model.id.endsWith(":free-route"))?.cost).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it("deduplicates models and providers while preserving first-seen order", () => {
    const duplicateModel = { id: GLM_ID, providers: [provider({ provider: "ignored" })] };
    const catalog = parseRouterCatalog({
      data: [{ id: GLM_ID, providers: [provider(), provider({ pricing: { input: 99, output: 99 } })] }, duplicateModel],
    });

    expect(catalog.models).toHaveLength(1);
    expect(catalog.models[0]?.providers).toEqual([
      { id: "novita", contextWindow: 1_048_576, inputPrice: 1.4, outputPrice: 4.4 },
    ]);
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
    const provider = catalogProvider({ fetch, now: () => NOW });

    const models = await refreshProvider(provider, refreshContext(store));

    expect(route(models, `${GLM_ID}:novita`)).toBeDefined();
    expect(requests).toHaveLength(1);
    expect(requestUrl(requests[0]?.input)).toBe(HUGGING_FACE_MODELS_URL);
    expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBeNull();
    expect(store.entry?.models.map((model) => model.id)).toEqual([`${GLM_ID}:novita`]);
    expect(store.entry?.checkedAt).toBeTypeOf("number");
  });

  it("restores provider routes without network access", async () => {
    const store = new MemoryStore();
    const online = catalogProvider({ fetch: async () => jsonResponse(payload()), now: Date.now });
    await refreshProvider(online, refreshContext(store));
    const fetch = vi.fn<FetchLike>();
    const offline = catalogProvider({ fetch, now: Date.now });

    const models = await refreshProvider(offline, refreshContext(store, { allowNetwork: false }));

    expect(route(models, `${GLM_ID}:novita`)).toBeDefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses a fresh cache unless a forced refresh is requested", async () => {
    const store = new MemoryStore();
    const first = catalogProvider({ fetch: async () => jsonResponse(payload()), now: Date.now });
    await refreshProvider(first, refreshContext(store));
    const secondFetch = vi.fn<FetchLike>(async () => jsonResponse(payload([provider({ provider: "fireworks-ai" })])));
    const second = catalogProvider({ fetch: secondFetch, now: Date.now });

    const cached = await refreshProvider(second, refreshContext(store));
    const forced = await refreshProvider(second, refreshContext(store, { force: true }));

    expect(secondFetch).toHaveBeenCalledTimes(1);
    expect(route(cached, `${GLM_ID}:novita`)).toBeDefined();
    expect(route(forced, `${GLM_ID}:fireworks-ai`)).toBeDefined();
  });

  it("refreshes an expired cache", async () => {
    const store = new MemoryStore();
    const first = catalogProvider({ fetch: async () => jsonResponse(payload()), now: () => NOW });
    await refreshProvider(first, refreshContext(store));
    if (store.entry === undefined) throw new Error("Expected a stored model catalog");
    store.entry = { ...store.entry, checkedAt: NOW };
    const fetch = vi.fn<FetchLike>(async () => jsonResponse(payload([provider({ provider: "fireworks-ai" })])));
    const second = catalogProvider({ fetch, now: () => NOW + MODEL_CATALOG_REFRESH_INTERVAL_MS });

    const models = await refreshProvider(second, refreshContext(store));

    expect(fetch).toHaveBeenCalledOnce();
    expect(route(models, `${GLM_ID}:fireworks-ai`)).toBeDefined();
  });

  it("replaces a previous provider catalog with validated route models", async () => {
    const canonical = getBuiltinModels("huggingface")[0];
    if (canonical === undefined) throw new Error("Expected a canonical Hugging Face model");
    const store = new MemoryStore({ models: [{ ...canonical, id: "future/model", name: "Future model" }] });
    const provider = catalogProvider({ fetch: async () => jsonResponse(payload()), now: Date.now });

    await refreshProvider(provider, refreshContext(store, { force: true }));

    expect(store.entry?.models.map((model) => model.id)).toEqual([`${GLM_ID}:novita`]);
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
      const provider = catalogProvider({ fetch: testCase.fetch, maxResponseBytes: 10, now: () => NOW });
      await expect(refreshProvider(provider, refreshContext(new MemoryStore()))).rejects.toThrow(testCase.message);
    }
  });

  it("applies one deadline to fetching and reading the response", async () => {
    const neverFetch: FetchLike = async () => new Promise<Response>(() => undefined);
    const stalledBody = new ReadableStream<Uint8Array>({ start: () => undefined });
    const fetches: FetchLike[] = [neverFetch, async () => new Response(stalledBody)];
    for (const fetch of fetches) {
      const provider = catalogProvider({ fetch, timeoutMs: 5, now: () => NOW });
      await expect(refreshProvider(provider, refreshContext(new MemoryStore()))).rejects.toThrow(/timed out/u);
    }
  });

  it("honors cancellation before and during a request", async () => {
    const before = new AbortController();
    before.abort();
    const fetch = vi.fn<FetchLike>();
    const provider = catalogProvider({ fetch, now: () => NOW });
    await expect(
      refreshProvider(provider, refreshContext(new MemoryStore(), { signal: before.signal })),
    ).resolves.toHaveLength(49);
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
      catalogProvider({ fetch: pending, timeoutMs: 1_000, now: () => NOW }),
      refreshContext(new MemoryStore(), { signal: during.signal }),
    );
    await started;
    during.abort();
    await expect(request).rejects.toThrow(/cancelled/u);
  });
});
