# Hugging Face OAuth for Pi specification

This specification defines a Pi extension that adds Hugging Face OAuth and provider-specific model routes to Pi's existing `huggingface` provider. The extension contributes one TypeScript entry point, keeps Pi's canonical Hugging Face models and inference transport, and adds validated route variants through Pi's model-refresh API.

## Package shape

```text
pi-huggingface-oauth/
├── index.ts
├── src/
│   ├── http.ts
│   ├── model-catalog.ts
│   ├── oauth.ts
│   ├── protocol.ts
│   ├── redaction.ts
│   └── validation.ts
├── package.json
└── README.md
```

`index.ts` is the Pi extension entry point. The files under `src/` implement protocol handling without depending on Pi's TUI.

## Provider registration

The extension must compose Pi's existing provider through the documented provider-overlay API:

```ts
pi.registerProvider("huggingface", {
  oauth: huggingFaceOAuth,
  refreshModels: refreshHuggingFaceModelsAndRoutes,
});
```

The extension must not register a replacement native provider. Pi's built-in provider continues to own the bundled and remote canonical catalogs, standard `HF_TOKEN` authentication, router base URL, and OpenAI Completions transport. The refresh overlay projects the current canonical models together with validated provider-specific route entries.

## OAuth application

The package uses a dedicated Hugging Face public OAuth application.

The application must meet these requirements:

- It has no client secret.
- Its allowed scope is `inference-api`.
- It supports the OAuth 2.0 Device Authorization Grant.
- Its public client ID is bundled with the package.
- `PI_HUGGINGFACE_OAUTH_CLIENT_ID` can override the bundled client ID for development and testing.

The client ID is public configuration. The package must not reuse the Hugging Face CLI client ID or require a client secret in settings, environment variables, or source control.

## Endpoints

The extension uses two fixed endpoints:

| Purpose                 | Method | URL                                   |
| ----------------------- | ------ | ------------------------------------- |
| Device authorization    | `POST` | `https://huggingface.co/oauth/device` |
| Token issue and refresh | `POST` | `https://huggingface.co/oauth/token`  |

Requests must use `application/x-www-form-urlencoded`. Redirects to another origin must be rejected.

## Device authorization request

The device authorization request contains the public client ID and least-privilege scope:

```text
client_id=<public-client-id>
scope=inference-api
```

A successful response must contain:

| Field                       | Type   | Rules                                                       |
| --------------------------- | ------ | ----------------------------------------------------------- |
| `device_code`               | string | Non-empty and never displayed or logged.                    |
| `user_code`                 | string | Non-empty and safe to display.                              |
| `verification_uri`          | string | Absolute HTTPS URL on `huggingface.co` or `hf.co`.          |
| `verification_uri_complete` | string | Optional absolute HTTPS URL on `huggingface.co` or `hf.co`. |
| `expires_in`                | number | Positive duration in seconds.                               |
| `interval`                  | number | Optional positive polling interval in seconds.              |

If `interval` is absent, the extension uses five seconds. If `verification_uri_complete` is absent, it uses `verification_uri`.

Unknown response fields are ignored. Invalid required fields cause login to fail before any browser URL is shown.

## User interaction

The extension reports the device flow through Pi's documented OAuth callbacks. It supplies the user code, verification URL, polling interval, and expiration duration to `onDeviceCode`. Pi renders one persistent waiting row after that callback, so routine polls must not emit `onProgress` events that append duplicate rows.

The login function must not create a local HTTP listener, start a background process, or write its own credential file. Cancellation through Pi's `AbortSignal` stops polling promptly.

## Token polling

After showing the authorization details, the extension waits for the current interval before the first token request. Each request contains:

```text
grant_type=urn:ietf:params:oauth:grant-type:device_code
device_code=<private-device-code>
client_id=<public-client-id>
```

Polling stops when a token is issued, the user cancels, or the device code expires.

The following OAuth errors have defined behavior:

| Error                   | Behavior                                               |
| ----------------------- | ------------------------------------------------------ |
| `authorization_pending` | Wait for the current interval and poll again.          |
| `slow_down`             | Add five seconds to the interval before polling again. |
| `access_denied`         | Stop and report that authorization was denied.         |
| `expired_token`         | Stop and report that the device code expired.          |

Network failures, rate limits, and server errors may be retried while the device code remains valid. Every HTTP operation must have its own timeout. Polling must remain bounded by `expires_in` even when the network repeatedly fails.

Unexpected OAuth errors and malformed successful responses are fatal. Error messages may include a bounded OAuth error code and description, but must not include raw response bodies.

## Token response

A successful device-token response must contain:

| Field           | Type   | Rules                                                           |
| --------------- | ------ | --------------------------------------------------------------- |
| `access_token`  | string | Required secret that must be non-empty.                         |
| `refresh_token` | string | Required secret that must be non-empty.                         |
| `expires_in`    | number | Required positive duration in seconds.                          |
| `token_type`    | string | Optional; when present, it must be `bearer` case-insensitively. |

The extension maps the response to Pi's `OAuthCredentials`:

```ts
{
  access: accessToken,
  refresh: refreshToken,
  expires: Date.now() + expiresInMilliseconds - refreshSkew,
}
```

The refresh skew is five minutes. For a token lifetime shorter than the skew, `expires` must remain later than the current time while still forcing an early refresh.

## Refresh

Pi invokes the extension's refresh function under its provider credential lock. The refresh request contains:

```text
grant_type=refresh_token
refresh_token=<private-refresh-token>
client_id=<public-client-id>
```

The refresh response must include a new access token and positive `expires_in`. If Hugging Face returns a new refresh token, the extension stores it. If the field is absent, the extension keeps the previous refresh token.

An `invalid_grant` response is fatal and tells the user to run `/login` again. Transient refresh failures must surface as request failures without deleting the last stored credential.

## Authentication behavior

Pi owns authentication precedence and storage. Browser login writes an OAuth credential for the `huggingface` provider using Pi's normal `/login` flow. A later manual token login replaces that credential, and a later browser login replaces a stored API token.

When no credential is stored, Pi may continue to resolve `HF_TOKEN` through its built-in provider. The extension must not read Hugging Face CLI token files or copy credentials between applications.

## Inference requests

`getApiKey` returns the current OAuth access token. Pi passes it as the bearer credential to its existing Hugging Face OpenAI-compatible transport.

The extension must not inspect prompts, tool calls, model responses, billing data, or hidden routing preferences. Catalog discovery sends only an `Accept` header. Inference requests remain entirely under Pi's built-in provider transport and authentication.

## Model discovery and provider routes

Model discovery uses the public endpoint:

```text
GET https://router.huggingface.co/v1/models
```

The request sends `Accept: application/json` and no authorization header. It uses manual redirect handling, one end-to-end timeout, the caller's abort signal, and a four-mebibyte response limit.

The response begins as `unknown`. Its root must contain a bounded `data` array. Every model entry must have a bounded model ID and a bounded `providers` array. Unknown fields are ignored.

A provider-specific route is eligible only when all of these conditions hold:

- `status` is `live`;
- `supports_tools` is `true`;
- the provider identifier is a bounded lowercase router identifier;
- `context_length` is a positive bounded integer; and
- `pricing.input` and `pricing.output` are finite non-negative numbers, or `is_free` is `true`.

Malformed, unavailable, tool-incompatible, or incomplete provider entries do not enter Pi's picker. Duplicate models and providers keep their first occurrence so ordering remains deterministic.

Each canonical Pi model remains available under its unsuffixed ID and receives an `· Auto` display label. Eligible providers become ordinary model entries with exact Hugging Face suffix IDs, for example:

```text
zai-org/GLM-5.2
zai-org/GLM-5.2:novita
zai-org/GLM-5.2:fireworks-ai
```

A route entry preserves the canonical model's API, base URL, input modalities, reasoning support, compatibility flags, and maximum output tokens. Its context window and input/output rates come from the selected provider. Cache read and write rates are zero because the router catalog does not publish provider-specific cache pricing. Maximum output tokens cannot exceed the route's context window.

The provider order from Hugging Face is preserved. The extension does not add a global provider preference, rewrite model IDs before requests, or silently fail over a pinned provider suffix. The unsuffixed automatic entry retains Hugging Face's normal fastest-route behavior.

## Model cache

The extension uses only `RefreshModelsContext.store`, Pi's provider-scoped model store. Because Pi and the extension share that provider-scoped entry, the extension persists a sanitized combined snapshot containing Pi's applicable canonical catalog and validated routes. It preserves Pi's `lastModified` value and uses the older canonical or route check time so one cache cannot indefinitely postpone refresh of the other. A route snapshot is fresh for four hours, including a successful snapshot with no eligible routes, and reading a fresh snapshot does not renew its timestamp.

Pi restores the stored overlay during offline startup. The extension adds no sidecar file or settings field.

## Input validation

All network JSON begins as `unknown`. Validation must reject arrays, null values, wrong field types, empty required strings, non-finite numbers, and non-positive durations.

Protocol limits must bound response bytes, user-facing error text, polling duration, and polling interval. No validator may use an unchecked cast or explicit `any`.

## Diagnostics

User-facing failures should identify the failed stage, such as device authorization, token polling, or refresh. Diagnostics must redact:

- access and refresh tokens
- device codes
- authorization headers
- raw successful token responses

The user code may appear only in Pi's device-code prompt.

## Compatibility

The package targets Pi versions that expose documented provider registration with OAuth callbacks and provider composition. It must verify the minimum compatible Pi release before publishing.

The extension must work after authentication in every Pi mode, including TUI, print, JSON, and RPC. Interactive login requires a mode that implements Pi's OAuth interaction callbacks.

## Persistence and runtime boundaries

The extension adds no session entries and creates no sidecar files. Pi's existing auth store holds OAuth credentials, and Pi's existing provider model store holds the validated route catalog. The extension uses no Pi private APIs. Network access occurs only during OAuth operations or a Pi-authorized model refresh.

## Exclusions

This package does not manage Hugging Face repositories, local model downloads, Inference Endpoints, Spaces, Jobs, or hidden provider preference settings. It does not replace Pi's inference transport, invent models outside Pi's canonical catalog, or expose routes whose published metadata is incomplete for coding-agent use.
