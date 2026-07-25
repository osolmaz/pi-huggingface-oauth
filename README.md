# Hugging Face OAuth for Pi

Hugging Face OAuth for Pi is a Pi provider extension. It adds browser-based Hugging Face login to Pi's built-in Inference Providers integration while keeping token login available.

The package uses Hugging Face's device authorization flow, which works in local terminals and remote shells. After authorization, Pi stores and refreshes the OAuth credential through its existing authentication system.

## Status

The behavior is specified, but the extension has not been implemented or released. The repository is ready for implementation review.

## Intended use

Once released, install the package with Pi:

```bash
pi install npm:pi-huggingface-oauth@<version>
```

Then run `/login`, choose Hugging Face, and select browser login. Pi will display a Hugging Face URL and a short code. The resulting credential will authorize requests through `https://router.huggingface.co/v1`.

The extension will preserve Pi's existing `HF_TOKEN` support and manual token entry. It will request only the Hugging Face `inference-api` OAuth scope.

## Design

The [specification](SPEC.md) defines login and refresh behavior together with error handling and compatibility. [Motivation](docs/2026-07-25-motivation.md) explains why a standalone extension is useful, and the [implementation plan](docs/2026-07-25-implementation-plan.md) records the work needed before the first release.

## Security

The OAuth application will be public and use no client secret. Device codes, access tokens, and refresh tokens must never appear in logs or diagnostics. Pi remains responsible for credential persistence in `~/.pi/agent/auth.json`.

See [SECURITY.md](SECURITY.md) for reporting instructions and the package's security boundaries.

## License

[MIT](LICENSE)
