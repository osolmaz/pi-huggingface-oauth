---
title: "Model catalog revalidation plan"
author: "Onur Solmaz <2453968+osolmaz@users.noreply.github.com>"
date: "2026-09-26"
---

# Model catalog revalidation plan

A user upgraded the extension from 0.2.0 to 0.3.0, restarted Pi, and still could not see a live
route that the new version adds. The stored catalog was fetched by the old version minutes earlier,
so the extension reused its own four-hour freshness window and never fetched the route.

This plan records the decision that removes that failure, before the implementation lands.

## Purpose

The stored catalog is an offline copy of the route list. It must never be the reason to skip the
network, and the route list must always be derived by the code that is running now.

## Requirements

- Fetch the router catalog whenever Pi allows network access, and derive routes from that response.
- Keep the stored entry for offline startup and for failed fetches. Never use it as a timer.
- Keep the stored entry in Pi's provider-scoped model store. Add no sidecar file, settings field, or
  session entry.
- Copy Pi's `checkedAt`, `lastModified`, and `etag` unchanged, because Pi's remote-catalog provider
  shares the entry and owns those fields. An extension refresh must never advance Pi's window.
- Send no validator or conditional request, because a `304 Not Modified` response would force the
  extension to reuse the old derived list, which is the failure this plan removes.
- Keep the unnamed `· Auto` entries and every validated provider route unchanged.
- Show one automatic label on a route whose canonical entry already carries one. Live verification
  found that Pi stores remote canonical names with the `· Auto` suffix, so route names repeated it.

## Non-goals

- No change to Pi source, Pi private APIs, or Pi's stored entry fields.
- No new cache file, no request validator, and no version marker in the stored entry.
- No change to route eligibility, prices, or OAuth behavior. Only the repeated automatic label in a
  route name changed with this plan.

## Implementation status

Implemented in 0.4.0. Local checks pass, and a live check over the stored snapshot from
`~/.pi/agent/models-store.json` returned `zai-org/GLM-5.3-Flash:fireworks-ai` as
`GLM-5.3-Flash · Fireworks (price not published)` with zero rates. That check also showed a repeated
`· Auto` label in route names, which this release fixed.

Review found one P1: the first version wrote a new `checkedAt` on every fetch, which renewed Pi's own
four-hour window for the shared entry and stopped Pi from revalidating its canonical catalog. The
implementation now copies Pi's freshness fields unchanged.

## Assumptions and open questions

- Pi calls the refresh twice per cycle: once without network access to restore cached state, then
  once with network access. Only the second call reaches the network.
- A failed fetch keeps the last good list, because Pi applies the returned list only after the
  refresh resolves. No open questions remain.

## Acceptance criteria

- A stored catalog with a recent `checked_at` does not stop a fetch when Pi allows network access.
- A stored route that the new version adds appears on the first refresh after an upgrade, with no
  wait and no manual cache step.
- Without network access, the extension returns the stored routes and makes no request.
- A failed fetch leaves the last successful stored entry unchanged.
- A route derived from a stored canonical name shows one automatic label, not two.
- `npm run check`, `npm run slophammer`, and `git diff --check` pass.

## Verification

```bash
npm run check
npm run slophammer
git diff --check
```

Unit tests cover the stored-entry path, the upgrade path, and the offline path. A live check against
`https://router.huggingface.co/v1/models` confirms that the Fireworks route for
`zai-org/GLM-5.3-Flash` appears after one refresh and needs no cache edit.
