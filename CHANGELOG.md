# Changelog

## 0.2.0

- Require Pi 0.84.1 or newer.
- Publish refreshed model catalogs through Pi's generation-checked persistence API.

## 0.1.1

- Restore model-catalog refreshes on Pi 0.82.1 and newer.
- Keep provider-specific routes available when Pi restores a saved session model.

## 0.1.0

- Add browser OAuth login for Hugging Face Inference Providers.
- Preserve Pi's token authentication, canonical model catalog, router transport, and credential storage.
- Discover live, tool-capable provider routes and show them in Pi's model picker.
- Cache validated route metadata for offline startup.
