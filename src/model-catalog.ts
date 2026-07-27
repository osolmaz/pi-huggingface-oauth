import type { Api, Model, ModelsStoreEntry, RefreshModelsContext } from "@earendil-works/pi-ai";
import { getBuiltinModelDataGeneratedAt, getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import type { ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { FetchLike } from "./types.js";

export const HUGGING_FACE_MODELS_URL = "https://router.huggingface.co/v1/models";
export const MODEL_CATALOG_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;
export const DEFAULT_MODEL_CATALOG_TIMEOUT_MS = 15_000;
export const MAX_MODEL_CATALOG_BYTES = 4 * 1024 * 1024;
const MAX_CATALOG_MODELS = 2_048;
const MAX_PROVIDERS_PER_MODEL = 128;
const MAX_MODEL_ID_LENGTH = 512;
const MAX_PROVIDER_ID_LENGTH = 64;
const MAX_CONTEXT_TOKENS = 16 * 1024 * 1024;
const MAX_PRICE_PER_MILLION_TOKENS = 1_000_000;
const HUGGING_FACE_PROVIDER = "huggingface";
const HUGGING_FACE_API = "openai-completions";
const HUGGING_FACE_BASE_URL = "https://router.huggingface.co/v1";

const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  cerebras: "Cerebras",
  deepinfra: "DeepInfra",
  "featherless-ai": "Featherless AI",
  "fireworks-ai": "Fireworks",
  groq: "Groq",
  "hf-inference": "HF Inference",
  novita: "Novita",
  nscale: "Nscale",
  ovhcloud: "OVHcloud",
  publicai: "Public AI",
  scaleway: "Scaleway",
  together: "Together",
  "zai-org": "Z.ai",
};

export type ModelCatalogOptions = {
  readonly fetch?: FetchLike;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly localCatalogModifiedAt?: () => Promise<number | undefined>;
};

type RouterProvider = {
  readonly id: string;
  readonly contextWindow: number;
  readonly inputPrice: number;
  readonly outputPrice: number;
};

type RouterModel = {
  readonly id: string;
  readonly providers: readonly RouterProvider[];
};

export type RouterCatalog = {
  readonly models: readonly RouterModel[];
};

class ModelCatalogTimeoutError extends Error {}
class ModelCatalogTooLargeError extends Error {}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Readonly<Record<string, unknown>>;
}

function boundedString(value: unknown, maximumLength: number): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength) return undefined;
  if (/\p{Cc}/u.test(value)) return undefined;
  return value;
}

function finiteNumber(value: unknown, maximum: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > maximum) return undefined;
  return value;
}

function positiveInteger(value: unknown, maximum: number): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > maximum) return undefined;
  return value;
}

function providerId(value: unknown): string | undefined {
  const id = boundedString(value, MAX_PROVIDER_ID_LENGTH);
  return id !== undefined && /^[a-z0-9][a-z0-9.-]*$/u.test(id) ? id : undefined;
}

function providerPrice(source: Readonly<Record<string, unknown>>, field: "input" | "output"): number | undefined {
  if (source["is_free"] === true) return 0;
  return finiteNumber(record(source["pricing"])?.[field], MAX_PRICE_PER_MILLION_TOKENS);
}

function parseProvider(value: unknown): RouterProvider | undefined {
  const source = record(value);
  if (source?.["status"] !== "live") return undefined;
  if (source["supports_tools"] !== true) return undefined;
  const id = providerId(source["provider"]);
  const contextWindow = positiveInteger(source["context_length"], MAX_CONTEXT_TOKENS);
  const inputPrice = providerPrice(source, "input");
  const outputPrice = providerPrice(source, "output");
  if (id === undefined) return undefined;
  if (contextWindow === undefined) return undefined;
  if (inputPrice === undefined) return undefined;
  if (outputPrice === undefined) return undefined;
  return { id, contextWindow, inputPrice, outputPrice };
}

function parseProviders(values: readonly unknown[]): RouterProvider[] {
  const seen = new Set<string>();
  const providers: RouterProvider[] = [];
  for (const value of values) {
    const provider = parseProvider(value);
    if (provider === undefined || seen.has(provider.id)) continue;
    seen.add(provider.id);
    providers.push(provider);
  }
  return providers;
}

function parseRouterModel(value: unknown): RouterModel {
  const source = record(value);
  const id = boundedString(source?.["id"], MAX_MODEL_ID_LENGTH);
  const providers = source?.["providers"];
  if (id === undefined || !Array.isArray(providers) || providers.length > MAX_PROVIDERS_PER_MODEL) {
    throw new Error("Hugging Face model catalog contains an invalid model entry.");
  }
  return { id, providers: parseProviders(providers) };
}

export function parseRouterCatalog(value: unknown): RouterCatalog {
  const data = record(value)?.["data"];
  if (!Array.isArray(data) || data.length > MAX_CATALOG_MODELS) {
    throw new Error("Hugging Face model catalog has an invalid data field.");
  }
  const seen = new Set<string>();
  const models: RouterModel[] = [];
  for (const item of data) {
    const model = parseRouterModel(item);
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  return { models };
}

function copyCost(cost: Model<Api>["cost"]): Model<Api>["cost"] {
  return {
    input: cost.input,
    output: cost.output,
    cacheRead: cost.cacheRead,
    cacheWrite: cost.cacheWrite,
    ...(cost.tiers === undefined ? {} : { tiers: cost.tiers.map((tier) => ({ ...tier })) }),
  };
}

function toConfig(model: Model<Api>, name = model.name): ProviderModelConfig {
  return {
    id: model.id,
    name,
    api: model.api,
    baseUrl: model.baseUrl,
    reasoning: model.reasoning,
    input: [...model.input],
    cost: copyCost(model.cost),
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...(model.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: { ...model.thinkingLevelMap } }),
    ...(model.headers === undefined ? {} : { headers: { ...model.headers } }),
    ...(model.compat === undefined ? {} : { compat: { ...model.compat } }),
  };
}

function baselineModels(): readonly Model<Api>[] {
  return getBuiltinModels("huggingface").map((model) => ({
    ...model,
    input: [...model.input],
    cost: copyCost(model.cost),
  }));
}

function friendlyProviderName(id: string): string {
  const known = PROVIDER_NAMES[id];
  if (known !== undefined) return known;
  return id
    .split(/[.-]/u)
    .filter((part) => part.length > 0)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function routeConfig(base: Model<Api>, route: RouterProvider): ProviderModelConfig {
  return {
    ...toConfig(base, `${base.name} · ${friendlyProviderName(route.id)}`),
    id: `${base.id}:${route.id}`,
    cost: { input: route.inputPrice, output: route.outputPrice, cacheRead: 0, cacheWrite: 0 },
    contextWindow: route.contextWindow,
    maxTokens: Math.min(base.maxTokens, route.contextWindow),
  };
}

export function deriveProviderModelOptions(
  catalog: RouterCatalog,
  canonicalModels: readonly Model<Api>[] = baselineModels(),
): ProviderModelConfig[] {
  const catalogById = new Map(catalog.models.map((model) => [model.id, model]));
  const models: ProviderModelConfig[] = [];
  for (const base of canonicalModels) {
    models.push(toConfig(base, `${base.name} · Auto`));
    const routes = catalogById.get(base.id)?.providers ?? [];
    for (const route of routes) models.push(routeConfig(base, route));
  }
  return models;
}

function splitRouteId(id: string, knownBaseIds: ReadonlySet<string>): { baseId: string; routeId: string } | undefined {
  const separator = id.lastIndexOf(":");
  if (separator <= 0) return undefined;
  const baseId = id.slice(0, separator);
  const routeId = providerId(id.slice(separator + 1));
  return routeId === undefined || !knownBaseIds.has(baseId) ? undefined : { baseId, routeId };
}

type CachedRouteContext = {
  readonly baseById: ReadonlyMap<string, Model<Api>>;
  readonly knownBaseIds: ReadonlySet<string>;
};

function isStoredHuggingFaceRoute(source: Readonly<Record<string, unknown>>): boolean {
  return (
    source["provider"] === HUGGING_FACE_PROVIDER &&
    source["api"] === HUGGING_FACE_API &&
    source["baseUrl"] === HUGGING_FACE_BASE_URL
  );
}

type CachedRouteMetadata = RouterProvider & { readonly baseId: string };

function cachedRouteMetadata(
  source: Readonly<Record<string, unknown>>,
  knownBaseIds: ReadonlySet<string>,
): CachedRouteMetadata | undefined {
  const id = boundedString(source["id"], MAX_MODEL_ID_LENGTH + MAX_PROVIDER_ID_LENGTH + 1);
  const split = id === undefined ? undefined : splitRouteId(id, knownBaseIds);
  if (split === undefined) return undefined;
  const contextWindow = positiveInteger(source["contextWindow"], MAX_CONTEXT_TOKENS);
  const cost = record(source["cost"]);
  const inputPrice = finiteNumber(cost?.["input"], MAX_PRICE_PER_MILLION_TOKENS);
  const outputPrice = finiteNumber(cost?.["output"], MAX_PRICE_PER_MILLION_TOKENS);
  if (contextWindow === undefined) return undefined;
  if (inputPrice === undefined) return undefined;
  if (outputPrice === undefined) return undefined;
  return { baseId: split.baseId, id: split.routeId, contextWindow, inputPrice, outputPrice };
}

function restoreCachedRoute(stored: unknown, context: CachedRouteContext): ProviderModelConfig | undefined {
  const source = record(stored);
  if (source === undefined) return undefined;
  if (!isStoredHuggingFaceRoute(source)) return undefined;
  const metadata = cachedRouteMetadata(source, context.knownBaseIds);
  if (metadata === undefined) return undefined;
  const base = context.baseById.get(metadata.baseId);
  return base === undefined ? undefined : routeConfig(base, metadata);
}

function cachedRoutes(entry: ModelsStoreEntry | undefined, bases: readonly Model<Api>[]): ProviderModelConfig[] {
  if (entry === undefined || !Array.isArray(entry.models)) return [];
  const context: CachedRouteContext = {
    baseById: new Map(bases.map((model) => [model.id, model])),
    knownBaseIds: new Set(bases.map((model) => model.id)),
  };
  const seen = new Set<string>();
  const routes: ProviderModelConfig[] = [];
  for (const stored of entry.models) {
    const route = restoreCachedRoute(stored, context);
    if (route === undefined || seen.has(route.id)) continue;
    seen.add(route.id);
    routes.push(route);
  }
  return routes;
}

function toStoredModel(config: ProviderModelConfig): Model<"openai-completions"> {
  return {
    id: config.id,
    name: config.name,
    api: HUGGING_FACE_API,
    provider: HUGGING_FACE_PROVIDER,
    baseUrl: HUGGING_FACE_BASE_URL,
    reasoning: config.reasoning,
    input: [...config.input],
    cost: copyCost(config.cost),
    contextWindow: config.contextWindow,
    maxTokens: config.maxTokens,
    ...(config.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: { ...config.thinkingLevelMap } }),
    ...(config.headers === undefined ? {} : { headers: { ...config.headers } }),
    ...(config.compat === undefined ? {} : { compat: { ...config.compat } }),
  };
}

async function collectBody(response: Response, maximumBytes: number): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maximumBytes) throw new ModelCatalogTooLargeError();
      chunks.push(result.value);
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function oversizedContentLength(response: Response, maximumBytes: number): boolean {
  const value = Number(response.headers.get("content-length"));
  return Number.isFinite(value) && value > maximumBytes;
}

type Interruption = {
  readonly promise: Promise<never>;
  reject(error: Error): void;
};

function interruption(): Interruption {
  let rejectPromise: (error: Error) => void = () => undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    rejectPromise = reject;
  });
  return { promise, reject: rejectPromise };
}

function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function validateCatalogResponse(response: Response, maximumBytes: number): void {
  if (response.status >= 300 && response.status < 400) {
    throw new Error("Hugging Face model catalog returned an unexpected redirect.");
  }
  if (response.url.length > 0 && new URL(response.url).origin !== new URL(HUGGING_FACE_MODELS_URL).origin) {
    throw new Error("Hugging Face model catalog redirected to another origin.");
  }
  if (!response.ok)
    throw new Error(`Hugging Face model catalog request failed with status ${String(response.status)}.`);
  if (oversizedContentLength(response, maximumBytes)) throw new ModelCatalogTooLargeError();
}

function parseCatalogText(text: string): RouterCatalog {
  try {
    const value: unknown = JSON.parse(text);
    return parseRouterCatalog(value);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Hugging Face model catalog returned malformed JSON.");
    throw error;
  }
}

function normalizedCatalogError(error: unknown, cause: "none" | "caller" | "timeout"): Error {
  if (error instanceof ModelCatalogTooLargeError) {
    return new Error("Hugging Face model catalog returned an oversized response.");
  }
  if (error instanceof ModelCatalogTimeoutError || cause === "timeout") {
    return new Error("Hugging Face model catalog request timed out.");
  }
  if (cause === "caller") return new Error("Hugging Face model catalog refresh was cancelled.");
  if (error instanceof Error && error.name === "AbortError") {
    return new Error("Hugging Face model catalog request failed.");
  }
  return error instanceof Error ? error : new Error("Hugging Face model catalog request failed.");
}

type ResolvedModelCatalogOptions = {
  readonly fetch: FetchLike;
  readonly timeoutMs: number;
  readonly maximumBytes: number;
};

function resolveModelCatalogOptions(options: ModelCatalogOptions): ResolvedModelCatalogOptions {
  return {
    fetch: options.fetch ?? globalThis.fetch,
    timeoutMs: options.timeoutMs ?? DEFAULT_MODEL_CATALOG_TIMEOUT_MS,
    maximumBytes: options.maxResponseBytes ?? MAX_MODEL_CATALOG_BYTES,
  };
}

function interruptionError(cause: "caller" | "timeout"): Error {
  return cause === "caller"
    ? new Error("Hugging Face model catalog refresh was cancelled.")
    : new ModelCatalogTimeoutError();
}

function listenForAbort(signal: AbortSignal | undefined, listener: () => void): () => void {
  signal?.addEventListener("abort", listener, { once: true });
  return () => signal?.removeEventListener("abort", listener);
}

function cancelResponse(response: Response | undefined): void {
  void response?.body?.cancel().catch(() => undefined);
}

async function fetchCatalog(options: ModelCatalogOptions, signal: AbortSignal | undefined): Promise<RouterCatalog> {
  if (signalAborted(signal)) throw new Error("Hugging Face model catalog refresh was cancelled.");
  const resolved = resolveModelCatalogOptions(options);
  const controller = new AbortController();
  const stopped = interruption();
  const state: { cause: "none" | "caller" | "timeout" } = { cause: "none" };
  const stop = (next: "caller" | "timeout"): void => {
    if (state.cause !== "none") return;
    state.cause = next;
    controller.abort();
    stopped.reject(interruptionError(next));
  };
  const onAbort = (): void => {
    stop("caller");
  };
  const stopListening = listenForAbort(signal, onAbort);
  const timer = setTimeout(() => {
    stop("timeout");
  }, resolved.timeoutMs);
  let response: Response | undefined;
  try {
    response = await Promise.race([
      resolved.fetch(HUGGING_FACE_MODELS_URL, {
        headers: { Accept: "application/json" },
        redirect: "manual",
        signal: controller.signal,
      }),
      stopped.promise,
    ]);
    validateCatalogResponse(response, resolved.maximumBytes);
    const text = await Promise.race([collectBody(response, resolved.maximumBytes), stopped.promise]);
    return parseCatalogText(text);
  } catch (error) {
    throw normalizedCatalogError(error, state.cause);
  } finally {
    clearTimeout(timer);
    stopListening();
    cancelResponse(response);
  }
}

function cacheIsFresh(checkedAt: number | undefined, now: number): boolean {
  return checkedAt !== undefined && checkedAt <= now && now - checkedAt < MODEL_CATALOG_REFRESH_INTERVAL_MS;
}

function useCachedSnapshot(
  context: RefreshModelsContext,
  hasSnapshot: boolean,
  checkedAt: number | undefined,
  now: number,
): boolean {
  if (context.force || !hasSnapshot) return false;
  return cacheIsFresh(checkedAt, now);
}

function isStoredHuggingFaceModel(model: Model<Api>): boolean {
  return (
    model.provider === HUGGING_FACE_PROVIDER &&
    model.api === HUGGING_FACE_API &&
    model.baseUrl === HUGGING_FACE_BASE_URL &&
    boundedString(model.id, MAX_MODEL_ID_LENGTH + MAX_PROVIDER_ID_LENGTH + 1) !== undefined
  );
}

function canonicalStoredModels(entry: ModelsStoreEntry | undefined): Model<Api>[] {
  if (entry === undefined) return [];
  const candidates = entry.models.filter(isStoredHuggingFaceModel);
  const ids = new Set(candidates.map((model) => model.id));
  return candidates.filter((model) => splitRouteId(model.id, ids) === undefined);
}

function remoteCatalogApplies(entry: ModelsStoreEntry | undefined, localModifiedAt: number | undefined): boolean {
  if (entry === undefined) return false;
  if (localModifiedAt === undefined) return true;
  return entry.lastModified !== undefined && entry.lastModified > localModifiedAt;
}

function mergeCanonicalModels(entry: ModelsStoreEntry | undefined, localModifiedAt: number | undefined): Model<Api>[] {
  const merged = [...baselineModels()];
  if (!remoteCatalogApplies(entry, localModifiedAt)) return merged;
  for (const model of canonicalStoredModels(entry)) {
    const index = merged.findIndex((candidate) => candidate.id === model.id);
    const copy = { ...model, input: [...model.input], cost: copyCost(model.cost) };
    if (index >= 0) merged[index] = copy;
    else merged.push(copy);
  }
  return merged;
}

function combineModels(
  canonical: readonly Model<Api>[],
  routes: readonly ProviderModelConfig[],
): ProviderModelConfig[] {
  return [...canonical.map((model) => toConfig(model, `${model.name.replace(/ · Auto$/u, "")} · Auto`)), ...routes];
}

function hasStoredProjection(entry: ModelsStoreEntry | undefined, canonical: readonly Model<Api>[]): boolean {
  if (entry === undefined) return false;
  const canonicalIds = new Set(canonical.map((model) => model.id));
  return entry.models.some(
    (model) => isStoredHuggingFaceModel(model) && canonicalIds.has(model.id) && model.name.endsWith(" · Auto"),
  );
}

function hasRestorableSnapshot(
  routes: readonly ProviderModelConfig[],
  entry: ModelsStoreEntry | undefined,
  canonical: readonly Model<Api>[],
): boolean {
  return routes.length > 0 || hasStoredProjection(entry, canonical);
}

function sharedCheckedAt(canonicalCheckedAt: number | undefined, routeCheckedAt: number): number {
  if (canonicalCheckedAt === undefined) return routeCheckedAt;
  return Math.min(canonicalCheckedAt, routeCheckedAt);
}

async function writeCombinedCatalog(
  context: RefreshModelsContext,
  stored: ModelsStoreEntry | undefined,
  models: readonly ProviderModelConfig[],
  checkedAt: number | undefined,
): Promise<void> {
  await context.store.write({
    models: models.map(toStoredModel),
    ...(checkedAt === undefined ? {} : { checkedAt }),
    ...(stored?.lastModified === undefined ? {} : { lastModified: stored.lastModified }),
  });
}

function defaultLocalCatalogModifiedAt(): Promise<number | undefined> {
  return Promise.resolve(getBuiltinModelDataGeneratedAt());
}

type ModelRefresh = NonNullable<ProviderConfig["refreshModels"]>;

async function fetchCatalogPreservingCache(
  context: RefreshModelsContext,
  options: ModelCatalogOptions,
  stored: ModelsStoreEntry | undefined,
  current: readonly ProviderModelConfig[],
  hasRetainedSnapshot: boolean,
  retainedCheckedAt: number | undefined,
): Promise<RouterCatalog> {
  try {
    return await fetchCatalog(options, context.signal);
  } catch (error) {
    if (hasRetainedSnapshot) {
      await writeCombinedCatalog(context, stored, current, retainedCheckedAt);
    }
    throw error;
  }
}

export function createHuggingFaceModelRefresh(options: ModelCatalogOptions = {}): ModelRefresh {
  const now = options.now ?? Date.now;
  const localCatalogModifiedAt = options.localCatalogModifiedAt ?? defaultLocalCatalogModifiedAt;
  let retainedRoutes: ProviderModelConfig[] = [];
  let hasRetainedSnapshot = false;
  let retainedCheckedAt: number | undefined;

  return async (context): Promise<ProviderModelConfig[]> => {
    const stored = await context.store.read();
    const canonical = mergeCanonicalModels(stored, await localCatalogModifiedAt());
    const restored = cachedRoutes(stored, canonical);
    if (hasRestorableSnapshot(restored, stored, canonical)) {
      retainedRoutes = restored;
      hasRetainedSnapshot = true;
      retainedCheckedAt = stored?.checkedAt;
    }
    const current = combineModels(canonical, retainedRoutes);
    if (!context.allowNetwork || signalAborted(context.signal)) return current;
    if (useCachedSnapshot(context, hasRetainedSnapshot, retainedCheckedAt, now())) return current;

    const catalog = await fetchCatalogPreservingCache(
      context,
      options,
      stored,
      current,
      hasRetainedSnapshot,
      retainedCheckedAt,
    );
    if (signalAborted(context.signal)) throw new Error("Hugging Face model catalog refresh was cancelled.");
    retainedRoutes = deriveProviderModelOptions(catalog, canonical).filter((model) => model.id.includes(":"));
    hasRetainedSnapshot = true;
    retainedCheckedAt = now();
    const refreshed = combineModels(canonical, retainedRoutes);
    await writeCombinedCatalog(context, stored, refreshed, sharedCheckedAt(stored?.checkedAt, retainedCheckedAt));
    return refreshed;
  };
}
