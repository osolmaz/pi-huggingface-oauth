---
title: "Motivation"
author: "Onur Solmaz <2453968+osolmaz@users.noreply.github.com>"
date: "2026-07-25"
---

# Motivation

Pi already sends model requests through Hugging Face Inference Providers. Authentication currently asks the user to create a token, choose permissions, copy the token into Pi, and replace it manually when needed.

That process is awkward on a new machine and encourages broad, long-lived tokens. It also makes Hugging Face feel different from Pi providers such as Codex, where `/login` starts a browser authorization flow and Pi handles the resulting credential.

Hugging Face now supports public OAuth clients and the OAuth 2.0 device flow. A client can request only the `inference-api` scope, show a short code, and receive a renewable credential after the user approves access in a browser. The flow works over SSH and Mosh because the terminal never needs to receive a browser redirect.

## Standalone package

The feature belongs in a small package because Pi's provider API can add OAuth without changing Pi itself. A partial override of the built-in `huggingface` provider preserves Pi's model catalog and request implementation. The package owns only the authorization protocol.

This boundary keeps review focused. The code should never see prompts or responses, and removing the package should restore Pi's original provider unchanged. It also gives the implementation a release cycle independent of the larger OnurPi workspace.

## User experience

The intended flow starts from Pi's existing `/login` command. The user selects Hugging Face and browser login, visits the displayed URL, and confirms a short code. Pi then uses and refreshes the credential through its normal auth store.

Manual token login and `HF_TOKEN` remain useful for automation and constrained environments. Browser login adds a safer interactive option without removing those paths.

## Scope choice

The OAuth application requests only `inference-api`. It does not need profile, email, repository, organization, billing, Jobs, or webhook access. Hugging Face charges routed inference to the account that approved the request, so the authorization screen should make that narrow purpose clear.

## Device authorization

A loopback callback can provide a smooth local experience, but it fails in common coding-agent environments where the browser and Pi run on different machines. Device authorization avoids port binding, callback forwarding, and browser-to-terminal routing. The user code is enough to connect the two devices.

## Long-term direction

The package should use only Pi's documented provider extension surface. If Pi later includes Hugging Face OAuth in its built-in provider, users can remove this package and use the built-in flow. The package does not need a compatibility layer or migration format because Pi already owns the stored provider credential.
