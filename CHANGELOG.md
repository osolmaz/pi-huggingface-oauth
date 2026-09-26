# Changelog

## 0.4.0

- Fetch the router catalog on every refresh that may reach the network, so a new release changes the picker on the next refresh instead of waiting for a cache window to expire.
- Keep the stored catalog as an offline copy for startup without network access and as the fallback after a failed fetch.
- Send no request validator, because a `304 Not Modified` answer would leave only the previously derived route list to show.
- Copy Pi's `checkedAt`, `lastModified`, and `etag` unchanged, so an extension refresh never advances Pi's own remote-catalog freshness window.
- Show one `· Auto` label on a route whose canonical model already carries it, instead of repeating the label.

## 0.3.0

- Keep live, tool-capable routes that Hugging Face publishes without a price, instead of hiding them.
- Label such a route ` (price not published)` and give it zero rates, and keep the label through the model cache.

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
