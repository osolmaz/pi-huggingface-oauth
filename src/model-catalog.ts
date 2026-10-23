import type { Api, Model, ModelsStoreEntry, RefreshModelsContext } from "@earendil-works/pi-ai";
import { getBuiltinModelDataGeneratedAt, getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import type { ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { FetchLike } from "./types.js";

export const HUGGING_FACE_MODELS_URL = "https://router.huggingface.co/v1/models";
export const HUGGING_FACE_HUB_MODELS_URL = "https://huggingface.co/api/models";
export const DEFAULT_MODEL_CATALOG_TIMEOUT_MS = 15_000;
export const MAX_MODEL_CATALOG_BYTES = 4 * 1024 * 1024;
const MAX_CATALOG_MODELS = 2_048;
const HUB_PAGE_SIZE = 1_000;
const MAX_PROVIDERS_PER_MODEL = 128;
const MAX_MODEL_ID_LENGTH = 512;
const MAX_PROVIDER_ID_LENGTH = 64;
const MAX_CONTEXT_TOKENS = 16 * 1024 * 1024;
const MAX_PRICE_PER_MILLION_TOKENS = 1_000_000;
const MAX_ROUTE_NAME_LENGTH = 512;
const PRICE_UNPUBLISHED_LABEL = " (price not published)";
const AUTOMATIC_LABEL = " · Auto";
const HUGGING_FACE_PROVIDER = "huggingface";
const HUGGING_FACE_API = "openai-completions";
const HUGGING_FACE_BASE_URL = "https://router.huggingface.co/v1";

/**
 * Providers that serve Hugging Face chat routes, with their display names. A refresh asks the Hub
 * about each of them that the router listing leaves out entirely.
 */
const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  baseten: "Baseten",
  cerebras: "Cerebras",
  cohere: "Cohere",
  deepinfra: "DeepInfra",
  "featherless-ai": "Featherless AI",
  "fireworks-ai": "Fireworks",
  groq: "Groq",
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
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly localCatalogModifiedAt?: () => Promise<number | undefined>;
  /** Providers to look up on the Hub when the router listing omits them. Defaults to the named providers. */
  readonly knownProviders?: readonly string[];
};

type RouterRoutePricing = {
  readonly inputPrice: number;
  readonly outputPrice: number;
};

type RouterProvider = {
  readonly id: string;
  readonly contextWindow: number;
  /** Absent when the router publishes no complete input and output price pair for the route. */
  readonly pricing?: RouterRoutePricing;
};

type RouterModel = {
  readonly id: string;
  readonly providers: readonly RouterProvider[];
};

export type RouterCatalog = {
  readonly models: readonly RouterModel[];
  /** Every provider the listing names, including providers whose routes are not eligible. */
  readonly listedProviders: ReadonlySet<string>;
};

type BaseRoute = RouterProvider & { readonly baseId: string };

type ProviderParser = (value: unknown) => RouterProvider | undefined;

const EMPTY_CATALOG: RouterCatalog = { models: [], listedProviders: new Set() };

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

function routePricing(source: Readonly<Record<string, unknown>>): RouterRoutePricing | undefined {
  const inputPrice = providerPrice(source, "input");
  const outputPrice = providerPrice(source, "output");
  if (inputPrice === undefined) return undefined;
  if (outputPrice === undefined) return undefined;
  return { inputPrice, outputPrice };
}

function routeEntry(
  provider: unknown,
  contextLength: unknown,
  pricingSource: Readonly<Record<string, unknown>>,
): RouterProvider | undefined {
  const id = providerId(provider);
  const contextWindow = positiveInteger(contextLength, MAX_CONTEXT_TOKENS);
  if (id === undefined) return undefined;
  if (contextWindow === undefined) return undefined;
  const pricing = routePricing(pricingSource);
  return pricing === undefined ? { id, contextWindow } : { id, contextWindow, pricing };
}

function parseProvider(value: unknown): RouterProvider | undefined {
  const source = record(value);
  if (source?.["status"] !== "live") return undefined;
  if (source["supports_tools"] !== true) return undefined;
  return routeEntry(source["provider"], source["context_length"], source);
}

function isLiveHubChatRoute(source: Readonly<Record<string, unknown>>): boolean {
  if (source["status"] !== "live") return false;
  if (source["task"] !== "conversational") return false;
  return record(source["features"])?.["toolCalling"] === true;
}

/**
 * A Hub provider mapping carries the router listing's eligibility data under other field names:
 * `features.toolCalling`, `providerDetails.context_length`, and `providerDetails.pricing`.
 */
function parseHubProvider(value: unknown): RouterProvider | undefined {
  const source = record(value);
  if (source === undefined || !isLiveHubChatRoute(source)) return undefined;
  const details = record(source["providerDetails"]) ?? {};
  return routeEntry(source["provider"], details["context_length"], details);
}

function parseProviders(values: readonly unknown[], parse: ProviderParser): RouterProvider[] {
  const seen = new Set<string>();
  const providers: RouterProvider[] = [];
  for (const value of values) {
    const provider = parse(value);
    if (provider === undefined || seen.has(provider.id)) continue;
    seen.add(provider.id);
    providers.push(provider);
  }
  return providers;
}

function parseModelEntry(value: unknown, field: string, parse: ProviderParser): RouterModel {
  const source = record(value);
  const id = boundedString(source?.["id"], MAX_MODEL_ID_LENGTH);
  const providers = source?.[field];
  if (id === undefined || !Array.isArray(providers) || providers.length > MAX_PROVIDERS_PER_MODEL) {
    throw new Error("Hugging Face model catalog contains an invalid model entry.");
  }
  return { id, providers: parseProviders(providers, parse) };
}

function namedProviders(value: unknown): string[] {
  const providers = record(value)?.["providers"];
  if (!Array.isArray(providers)) return [];
  return providers.map((provider) => providerId(record(provider)?.["provider"])).filter((id) => id !== undefined);
}

export function parseRouterCatalog(value: unknown): RouterCatalog {
  const data = record(value)?.["data"];
  if (!Array.isArray(data) || data.length > MAX_CATALOG_MODELS) {
    throw new Error("Hugging Face model catalog has an invalid data field.");
  }
  const seen = new Set<string>();
  const models: RouterModel[] = [];
  const listedProviders = new Set<string>();
  for (const item of data) {
    const model = parseModelEntry(item, "providers", parseProvider);
    for (const id of namedProviders(item)) listedProviders.add(id);
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  return { models, listedProviders };
}

/** The live chat routes that the Hub maps for the given providers, one entry per model and provider. */
export function parseHubRoutes(value: unknown, providers: ReadonlySet<string>): BaseRoute[] {
  if (!Array.isArray(value) || value.length > MAX_CATALOG_MODELS) {
    throw new Error("Hugging Face Hub model list is invalid.");
  }
  const routes: BaseRoute[] = [];
  for (const item of value) {
    const model = parseModelEntry(item, "inferenceProviderMapping", parseHubProvider);
    for (const route of model.providers) {
      if (providers.has(route.id)) routes.push({ ...route, baseId: model.id });
    }
  }
  return routes;
}

/** Adds routes to a catalog. A route the catalog already has for the same model keeps its catalog entry. */
function withRoutes(catalog: RouterCatalog, routes: readonly BaseRoute[]): RouterCatalog {
  const providersById = new Map(catalog.models.map((model) => [model.id, [...model.providers]]));
  for (const { baseId, ...route } of routes) {
    const providers = providersById.get(baseId) ?? [];
    if (!providers.some((existing) => existing.id === route.id)) providers.push(route);
    providersById.set(baseId, providers);
  }
  const models = [...providersById].map(([id, providers]) => ({ id, providers }));
  return { models, listedProviders: catalog.listedProviders };
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

/**
 * The canonical label without the automatic suffix. Pi stores remote canonical models with that
 * suffix, and a route derived from one of them must not repeat it.
 */
function canonicalLabel(model: Model<Api>): string {
  return model.name.endsWith(AUTOMATIC_LABEL) ? model.name.slice(0, -AUTOMATIC_LABEL.length) : model.name;
}

/**
 * A route keeps its place when the router publishes no price for it. The label states that the
 * zero rates below are unknown rather than free, and Pi stores it with the route, so a restored
 * cached route keeps the same name and rates.
 */
function routeName(base: Model<Api>, routeId: string, pricing: RouterRoutePricing | undefined): string {
  const provider = friendlyProviderName(routeId);
  const name = `${canonicalLabel(base)} · ${provider}`;
  return pricing === undefined ? `${name}${PRICE_UNPUBLISHED_LABEL}` : name;
}

function routeCost(pricing: RouterRoutePricing | undefined): Model<Api>["cost"] {
  return { input: pricing?.inputPrice ?? 0, output: pricing?.outputPrice ?? 0, cacheRead: 0, cacheWrite: 0 };
}

function routeConfig(base: Model<Api>, route: RouterProvider): ProviderModelConfig {
  return {
    ...toConfig(base, routeName(base, route.id, route.pricing)),
    id: `${base.id}:${route.id}`,
    cost: routeCost(route.pricing),
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

function isStoredHuggingFaceRoute(source: Readonly<Record<string, unknown>>): boolean {
  return (
    source["provider"] === HUGGING_FACE_PROVIDER &&
    source["api"] === HUGGING_FACE_API &&
    source["baseUrl"] === HUGGING_FACE_BASE_URL
  );
}

type StoredRouteShape = {
  readonly baseId: string;
  readonly routeId: string;
  readonly contextWindow: number;
};

function storedRouteShape(
  source: Readonly<Record<string, unknown>>,
  knownBaseIds: ReadonlySet<string>,
): StoredRouteShape | undefined {
  const id = boundedString(source["id"], MAX_MODEL_ID_LENGTH + MAX_PROVIDER_ID_LENGTH + 1);
  if (id === undefined) return undefined;
  const split = splitRouteId(id, knownBaseIds);
  if (split === undefined) return undefined;
  const contextWindow = positiveInteger(source["contextWindow"], MAX_CONTEXT_TOKENS);
  if (contextWindow === undefined) return undefined;
  return { baseId: split.baseId, routeId: split.routeId, contextWindow };
}

function storedRoutePricing(source: Readonly<Record<string, unknown>>): RouterRoutePricing | undefined {
  const cost = record(source["cost"]);
  const inputPrice = finiteNumber(cost?.["input"], MAX_PRICE_PER_MILLION_TOKENS);
  const outputPrice = finiteNumber(cost?.["output"], MAX_PRICE_PER_MILLION_TOKENS);
  if (inputPrice === undefined) return undefined;
  if (outputPrice === undefined) return undefined;
  return { inputPrice, outputPrice };
}

function cachedRouteMetadata(
  source: Readonly<Record<string, unknown>>,
  knownBaseIds: ReadonlySet<string>,
): BaseRoute | undefined {
  const shape = storedRouteShape(source, knownBaseIds);
  if (shape === undefined) return undefined;
  const name = boundedString(source["name"], MAX_ROUTE_NAME_LENGTH);
  if (name === undefined) return undefined;
  const { baseId, routeId, contextWindow } = shape;
  if (name.endsWith(PRICE_UNPUBLISHED_LABEL)) return { baseId, id: routeId, contextWindow };
  const pricing = storedRoutePricing(source);
  return pricing === undefined ? undefined : { baseId, id: routeId, contextWindow, pricing };
}

function restoreCachedRoute(stored: unknown, knownBaseIds: ReadonlySet<string>): BaseRoute | undefined {
  const source = record(stored);
  if (source === undefined) return undefined;
  if (!isStoredHuggingFaceRoute(source)) return undefined;
  return cachedRouteMetadata(source, knownBaseIds);
}

function cachedRoutes(entry: ModelsStoreEntry | undefined, bases: readonly Model<Api>[]): BaseRoute[] {
  if (entry === undefined || !Array.isArray(entry.models)) return [];
  const knownBaseIds = new Set(bases.map((model) => model.id));
  const seen = new Set<string>();
  const routes: BaseRoute[] = [];
  for (const stored of entry.models) {
    const route = restoreCachedRoute(stored, knownBaseIds);
    if (route === undefined) continue;
    const key = `${route.baseId}:${route.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
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

function validateCatalogResponse(response: Response, url: string, maximumBytes: number): void {
  if (response.status >= 300 && response.status < 400) {
    throw new Error("Hugging Face model catalog returned an unexpected redirect.");
  }
  if (response.url.length > 0 && new URL(response.url).origin !== new URL(url).origin) {
    throw new Error("Hugging Face model catalog redirected to another origin.");
  }
  if (!response.ok)
    throw new Error(`Hugging Face model catalog request failed with status ${String(response.status)}.`);
  if (oversizedContentLength(response, maximumBytes)) throw new ModelCatalogTooLargeError();
}

function parseCatalogText(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    throw new Error("Hugging Face model catalog returned malformed JSON.");
  }
}

type CatalogPage = {
  readonly value: unknown;
  readonly hasNextPage: boolean;
};

function hasNextPage(response: Response): boolean {
  return (response.headers.get("link") ?? "").includes('rel="next"');
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

async function fetchCatalogPage(
  url: string,
  options: ModelCatalogOptions,
  signal: AbortSignal | undefined,
): Promise<CatalogPage> {
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
      resolved.fetch(url, {
        headers: { Accept: "application/json" },
        redirect: "manual",
        signal: controller.signal,
      }),
      stopped.promise,
    ]);
    validateCatalogResponse(response, url, resolved.maximumBytes);
    const text = await Promise.race([collectBody(response, resolved.maximumBytes), stopped.promise]);
    return { value: parseCatalogText(text), hasNextPage: hasNextPage(response) };
  } catch (error) {
    throw normalizedCatalogError(error, state.cause);
  } finally {
    clearTimeout(timer);
    stopListening();
    cancelResponse(response);
  }
}

async function fetchRouterCatalog(
  options: ModelCatalogOptions,
  signal: AbortSignal | undefined,
): Promise<RouterCatalog> {
  const page = await fetchCatalogPage(HUGGING_FACE_MODELS_URL, options, signal);
  return parseRouterCatalog(page.value);
}

function hubModelsUrl(providers: readonly string[]): string {
  const query = `inference_provider=${providers.join(",")}&expand%5B%5D=inferenceProviderMapping`;
  return `${HUGGING_FACE_HUB_MODELS_URL}?${query}&limit=${String(HUB_PAGE_SIZE)}`;
}

/** Known providers and providers with stored routes that the router listing does not name at all. */
function omittedProviders(
  catalog: RouterCatalog,
  knownProviders: readonly string[],
  stored: readonly BaseRoute[],
): string[] {
  const expected = new Set([...knownProviders, ...stored.map((route) => route.id)]);
  return [...expected].filter((id) => providerId(id) !== undefined && !catalog.listedProviders.has(id)).sort();
}

/**
 * The router listing can leave out every route of a provider that the Hub still maps and the router
 * still serves. One Hub request returns the live chat routes of the omitted providers. When that
 * request fails or its answer has a further page, the omitted providers keep their stored routes.
 */
async function omittedProviderRoutes(
  omitted: readonly string[],
  stored: readonly BaseRoute[],
  options: ModelCatalogOptions,
  signal: AbortSignal | undefined,
): Promise<BaseRoute[]> {
  if (omitted.length === 0) return [];
  const providers = new Set(omitted);
  const kept = stored.filter((route) => providers.has(route.id));
  try {
    const page = await fetchCatalogPage(hubModelsUrl(omitted), options, signal);
    return page.hasNextPage ? kept : parseHubRoutes(page.value, providers);
  } catch (error) {
    if (signalAborted(signal)) throw error;
    return kept;
  }
}

function providerRoutes(catalog: RouterCatalog, canonical: readonly Model<Api>[]): ProviderModelConfig[] {
  return deriveProviderModelOptions(catalog, canonical).filter((model) => model.id.includes(":"));
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
  return [...canonical.map((model) => toConfig(model, `${canonicalLabel(model)}${AUTOMATIC_LABEL}`)), ...routes];
}

/**
 * Pi's own remote-catalog provider shares this provider entry and owns its freshness metadata. The
 * extension copies `checkedAt`, `lastModified`, and `etag` unchanged, so an extension refresh never
 * advances Pi's freshness window and never drops Pi's request validator.
 */
async function writeCombinedCatalog(
  context: RefreshModelsContext,
  stored: ModelsStoreEntry | undefined,
  models: readonly ProviderModelConfig[],
): Promise<void> {
  await context.publish({
    persist: {
      models: models.map(toStoredModel),
      ...(stored?.checkedAt === undefined ? {} : { checkedAt: stored.checkedAt }),
      ...(stored?.lastModified === undefined ? {} : { lastModified: stored.lastModified }),
      ...(stored?.etag === undefined ? {} : { etag: stored.etag }),
    },
  });
}

function defaultLocalCatalogModifiedAt(): Promise<number | undefined> {
  return Promise.resolve(getBuiltinModelDataGeneratedAt());
}

type ModelRefresh = NonNullable<ProviderConfig["refreshModels"]>;

/**
 * The stored entry is an offline copy of the route list, never a reason to skip the network. Every
 * refresh that may reach the network fetches the router catalog and derives routes with the running
 * code, so a new release changes the picker without waiting for any cache window to expire. The
 * request carries no validator, because a `304 Not Modified` response would leave the extension
 * with only the previously derived list to show. A provider that the listing omits entirely is
 * looked up on the Hub, so a gap in the listing does not remove routes that the router still serves.
 */
export function createHuggingFaceModelRefresh(options: ModelCatalogOptions = {}): ModelRefresh {
  const localCatalogModifiedAt = options.localCatalogModifiedAt ?? defaultLocalCatalogModifiedAt;
  const knownProviders = options.knownProviders ?? Object.keys(PROVIDER_NAMES);

  return async (context): Promise<ProviderModelConfig[]> => {
    const stored = context.stored;
    const canonical = mergeCanonicalModels(stored, await localCatalogModifiedAt());
    const restored = cachedRoutes(stored, canonical);
    if (!context.allowNetwork || signalAborted(context.signal)) {
      return combineModels(canonical, providerRoutes(withRoutes(EMPTY_CATALOG, restored), canonical));
    }

    const catalog = await fetchRouterCatalog(options, context.signal);
    const omitted = omittedProviders(catalog, knownProviders, restored);
    const added = await omittedProviderRoutes(omitted, restored, options, context.signal);
    if (signalAborted(context.signal)) throw new Error("Hugging Face model catalog refresh was cancelled.");
    const refreshed = combineModels(canonical, providerRoutes(withRoutes(catalog, added), canonical));
    await writeCombinedCatalog(context, stored, refreshed);
    return refreshed;
  };
}
