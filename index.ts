import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import { createHuggingFaceModelRefresh } from "./src/model-catalog.js";
import type { ModelCatalogOptions } from "./src/model-catalog.js";
import { createHuggingFaceOAuth } from "./src/oauth.js";
import type { OAuthAdapterOptions } from "./src/oauth.js";

export type HuggingFaceProviderOptions = OAuthAdapterOptions & {
  readonly modelCatalog?: ModelCatalogOptions;
};

export function createHuggingFaceProviderConfig(options: HuggingFaceProviderOptions = {}): ProviderConfig {
  return {
    oauth: createHuggingFaceOAuth(options),
    refreshModels: createHuggingFaceModelRefresh(options.modelCatalog),
  };
}

export type ProviderRegistrar = {
  registerProvider(name: string, config: ProviderConfig): void;
};

export default function registerHuggingFaceOAuth(pi: ProviderRegistrar): void {
  pi.registerProvider("huggingface", createHuggingFaceProviderConfig());
}
