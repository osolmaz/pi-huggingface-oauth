# Hugging Face OAuth for Pi

Hugging Face OAuth for Pi is a Pi provider extension. It adds browser-based Hugging Face login to Pi's built-in Inference Providers integration while keeping token login available.

The package uses Hugging Face's device authorization flow, which works in local terminals and remote shells. After authorization, Pi stores and refreshes the OAuth credential through its existing authentication system.

## Status

The extension is implemented but not released to npm. A maintainer still needs to register the project's public Hugging Face OAuth application and complete the first real browser-flow test.

## OAuth application setup

Create a [Hugging Face OAuth application](https://huggingface.co/settings/applications/new) for this package. It must be a public app with no client secret and only the `inference-api` scope.

Set its public client ID before starting Pi:

```bash
export PI_HUGGINGFACE_OAUTH_CLIENT_ID=<client-id>
```

The client ID is public configuration, not a secret. Do not use the Hugging Face CLI's client ID.

## Install and log in

This package requires Pi 0.81.1 or newer.

Until an npm release is available, install the repository package:

```bash
pi install git:github.com/osolmaz/pi-huggingface-oauth@main
```

Restart Pi, run `/login`, choose Hugging Face, and select **Hugging Face Inference Providers**. Pi displays a browser URL and a short code. After approval, Pi stores the OAuth credential in its existing auth file and sends model requests through `https://router.huggingface.co/v1`.

The extension preserves Pi's existing `HF_TOKEN` support and manual token entry. It requests only the Hugging Face `inference-api` OAuth scope.

## Design

The [specification](SPEC.md) defines login and refresh behavior together with error handling and compatibility. [Motivation](docs/2026-07-25-motivation.md) explains why a standalone extension is useful, and the [implementation plan](docs/2026-07-25-implementation-plan.md) records the work needed before the first release.

## Security

The OAuth application is public and uses no client secret. Device codes and OAuth tokens never appear in logs or diagnostics. Pi remains responsible for credential persistence in `~/.pi/agent/auth.json`.

The implementation rejects cross-origin redirects, bounds response sizes and polling time, applies per-request timeouts, honors cancellation, retries transient failures, and preserves refresh-token rotation.

See [SECURITY.md](SECURITY.md) for reporting instructions and the package's security boundaries.

## License

[MIT](LICENSE)
