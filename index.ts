import type { Provider } from "@earendil-works/pi-ai";
import { createProviderAwareHuggingFace } from "./src/model-catalog.js";
import type { ModelCatalogOptions } from "./src/model-catalog.js";
import { createNativeHuggingFaceOAuth } from "./src/oauth.js";
import type { OAuthAdapterOptions } from "./src/oauth.js";

export type HuggingFaceProviderOptions = OAuthAdapterOptions & {
  readonly modelCatalog?: ModelCatalogOptions;
};

export function createHuggingFaceProvider(options: HuggingFaceProviderOptions = {}): Provider<"openai-completions"> {
  return createProviderAwareHuggingFace(createNativeHuggingFaceOAuth(options), options.modelCatalog);
}

export type ProviderRegistrar = {
  registerProvider(provider: Provider): void;
};

export default function registerHuggingFaceOAuth(pi: ProviderRegistrar): void {
  pi.registerProvider(createHuggingFaceProvider());
}
