---
title: "Hugging Face OAuth implementation plan"
author: "Onur Solmaz <2453968+osolmaz@users.noreply.github.com>"
date: "2026-07-25"
---

# Hugging Face OAuth implementation plan

This plan implements browser login for Pi's built-in Hugging Face provider as a standalone package. Completion requires protocol tests, a real device-flow smoke test, package checks, and a documented security review.

## Implementation status

The protocol, Pi adapter, fake-server tests, package checks and security documentation are implemented. The project OAuth application is registered, its public client ID is bundled, and a real browser authorization has completed successfully. Provider-specific model routes are now discovered through Pi's model-refresh API; end-to-end routed inference remains the release gate.

## Prerequisite

The project uses a dedicated Hugging Face public OAuth application owned by the project maintainer. It allows only the `inference-api` scope and has no client secret. The package bundles its public client ID so users need no application setup. `PI_HUGGINGFACE_OAUTH_CLIENT_ID` remains available as a development override.

Do not use the Hugging Face CLI client ID. Do not put an OAuth secret in the repository or release environment.

## Package foundation

Add the Pi extension entry point and publishable package metadata.

- Set `pi.extensions` to `./index.ts`.
- Declare the supported Node and Pi versions.
- Keep runtime dependencies empty unless the standard library and Pi APIs prove insufficient.
- Include the source together with `README.md`, `SPEC.md`, `SECURITY.md` and `LICENSE` in the npm artifact.
- Keep the package private until the OAuth client and end-to-end login have been verified.

Verification at this stage includes `npm pack --dry-run` and a manifest test that loads the package through Pi's resource loader.

## Protocol module

Implement device authorization and token refresh in modules that do not import Pi.

The protocol layer will accept injected `fetch` plus clock and sleep boundaries for deterministic tests. It will expose typed functions for requesting a device code, polling for the first token, and refreshing an access token.

Validation begins from `unknown` and produces small domain objects. Response readers will enforce a byte limit before parsing JSON. URL validation will allow HTTPS URLs on `huggingface.co` and reject cross-origin redirects.

The polling loop will use a monotonic deadline, wait before its first request, honor `slow_down`, and stop promptly on abort. Each request will combine the caller's abort signal with a bounded timeout.

## Pi adapter

Implement the extension with Pi's documented native-provider registration. Build the provider from Pi's public canonical Hugging Face models, standard token-auth helper, OpenAI Completions transport, OAuth adapter, and dynamic route fetcher.

The adapter translates Pi callbacks into the protocol operations. It passes device information through `onDeviceCode`, returns OAuth credentials, preserves rotated refresh tokens, and exposes only the current access token through the provider auth layer.

The provider-specific overlay contains only validated suffixed routes. The canonical catalog, router URL, `HF_TOKEN` support, and inference transport retain Pi's built-in behavior.

## Test suite

Use mocked HTTP responses and fake time for protocol tests. Cover at least these cases:

- successful device authorization and token issue
- missing optional verification URL and polling interval
- `authorization_pending` followed by success
- `slow_down` interval growth
- cancellation during the wait and during an HTTP request
- device expiration after repeated transient failures
- denial and expired-code responses
- malformed JSON, oversized bodies, invalid URLs, and invalid field types
- token responses with missing or empty secrets
- refresh-token rotation and preservation
- `invalid_grant` on refresh
- error redaction for every secret field
- provider composition preserving built-in models and API-key login

An integration test will load the package against the minimum supported Pi version and confirm that `huggingface` exposes both API-key and OAuth authentication.

## Documentation and security review

Update the README with installation and login instructions only after the feature works. Keep protocol details in `SPEC.md` and maintainer procedures in `CONTRIBUTING.md`.

Review the implementation for token leakage, unbounded waits, redirect handling, unexpected persistence, and hidden credential reads. The package must not read Hugging Face CLI state or report telemetry.

## Manual verification

Use a dedicated test account or revocable test authorization.

1. Install the packed artifact into a temporary Pi config directory.
2. Run `/login`, choose Hugging Face browser login, and authorize the device code.
3. Confirm that Pi stores an OAuth credential without printing either token.
4. Select a built-in Hugging Face model and complete a tool-calling turn.
5. Force the stored expiry into the refresh window in the temporary config and verify one serialized refresh.
6. Run `/logout` and confirm the provider credential is removed.
7. Verify that `HF_TOKEN` still works when no OAuth credential is stored.

Delete the temporary Pi config and revoke the test authorization afterward.

## Release readiness

Before the first release:

- `npm run check` passes.
- Slophammer reports no findings and coverage is at least 85 percent.
- `git diff --check` passes.
- `npm pack --dry-run` contains only intended files.
- CI passes on Linux, macOS and Windows.
- A fresh Pi installation completes browser login and one inference request.
- The npm publish workflow uses a published GitHub Release and trusted publishing.
- The package remains unpublished until the OAuth application's ownership and recovery contacts are documented privately by the maintainer.

## Contract impact

Normal Pi session history is unchanged. The package adds no settings or session schema. Pi writes the OAuth credential to its existing auth store and caches validated routes in its existing provider model store. The implementation uses only documented provider registration, model refresh, model store, and OAuth callback APIs.
