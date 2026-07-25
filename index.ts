import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import { createHuggingFaceOAuth } from "./src/oauth.js";
import type { OAuthAdapterOptions } from "./src/oauth.js";

export function createHuggingFaceProviderOverride(options: OAuthAdapterOptions = {}): ProviderConfig {
  return { oauth: createHuggingFaceOAuth(options) };
}

export type ProviderRegistrar = {
  registerProvider(name: string, config: ProviderConfig): void;
};

export default function registerHuggingFaceOAuth(pi: ProviderRegistrar): void {
  pi.registerProvider("huggingface", createHuggingFaceProviderOverride());
}
