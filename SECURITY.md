# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub's security advisory form for this repository. Do not open a public issue for token exposure, OAuth flow bypasses, redirect problems, or credential-storage defects.

Include the affected commit or release, reproduction steps, and the impact you observed. Do not include live access tokens, refresh tokens, device codes, or authorization headers.

## Security boundaries

The package adds OAuth to Pi's built-in `huggingface` provider. It must request only the `inference-api` scope and must not read Hugging Face CLI credentials, Pi sessions, prompts, model responses, or repository data.

Pi owns credential persistence and request authentication. The package handles credentials only while exchanging, refreshing, or returning the current access token to Pi's provider layer.

## Supported versions

Security fixes will target the latest released version. Until the first release, the repository contains design material only and should not be used as an authentication component.
