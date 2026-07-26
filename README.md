# Hugging Face OAuth for Pi

Hugging Face OAuth for Pi adds browser login and provider-specific Inference Provider routes to Pi's built-in Hugging Face integration.

The package keeps Pi's Hugging Face transport and token support. It adds device authorization for browser login and discovers live routes such as Novita and Fireworks from Hugging Face's public router catalog. Together and DeepInfra routes appear when available too.

## Status

The browser authorization flow has been verified with the project's registered public OAuth application. The package is installed from GitHub while provider-route behavior is finalized; it has not been released to npm.

## Install and log in

This package requires Pi 0.81.1 or newer.

```bash
pi install git:github.com/osolmaz/pi-huggingface-oauth@main
```

Restart Pi, run `/login`, choose Hugging Face, and select **Hugging Face Inference Providers**. Pi displays a browser URL and a short code. After approval, Pi stores the OAuth credential in its existing auth file.

The package includes its dedicated public Hugging Face OAuth client ID, so login needs no extra configuration. The application has no client secret and requests only the `inference-api` scope.

Developers can test another compatible public application by setting:

```bash
export PI_HUGGINGFACE_OAUTH_CLIENT_ID=<client-id>
```

The client ID is public configuration, not a secret. Do not use the Hugging Face CLI's client ID.

Pi's existing `HF_TOKEN` and pasted-token login remain available.

## Choose an inference provider

Open `/model` and select a Hugging Face entry. The same picker contains the automatic route and provider-specific routes:

```text
GLM-5.2 · Auto
GLM-5.2 · Novita
GLM-5.2 · Together
GLM-5.2 · Fireworks
GLM-5.2 · DeepInfra
```

Provider-specific entries use Hugging Face's exact suffixed model IDs. They can also be selected from the command line:

```bash
pi --provider huggingface --model 'zai-org/GLM-5.2:fireworks-ai'
```

The unsuffixed model remains Hugging Face's automatic fastest route. A pinned provider entry does not silently change providers.

The package lists live, tool-capable routes only when Hugging Face supplies their context limits and prices. It refreshes the public catalog when Pi refreshes models and keeps the validated result in Pi's provider model store for offline startup.

## Design

The package composes one `huggingface` provider through Pi's documented provider API. It uses Pi's canonical catalog, standard token authentication, and OpenAI-compatible transport. The extension adds OAuth and projects live provider routes into ordinary Pi model entries. Pi then records the selected suffixed model ID through its normal model selection and session behavior.

The [specification](SPEC.md) defines OAuth and catalog validation, including route filters, cache behavior, and compatibility. [Motivation](docs/2026-07-25-motivation.md) explains why the standalone package exists.

## Security

The OAuth application is public and uses no client secret. Device codes and OAuth tokens never appear in logs or diagnostics. Pi remains responsible for credential persistence in `~/.pi/agent/auth.json`.

Model discovery uses Hugging Face's public `https://router.huggingface.co/v1/models` endpoint and sends no authorization header. The extension validates the response and its redirect behavior before checking body limits, deadlines, and model fields.

See [SECURITY.md](SECURITY.md) for reporting instructions and the package's security boundaries.

## License

[MIT](LICENSE)
