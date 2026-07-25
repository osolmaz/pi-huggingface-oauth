# pi-huggingface-oauth

- Read the installed Pi provider and extension documentation before changing provider behavior.
- Use only documented Pi APIs. Do not patch Pi internals or replace the built-in Hugging Face model catalog or transport.
- Keep OAuth protocol code separate from Pi integration and inject network and time boundaries in tests.
- Use strict TypeScript. Do not use explicit `any`, unchecked casts, or unvalidated network input.
- Never log, snapshot, or commit access tokens, refresh tokens, device codes, authorization headers, or live OAuth responses.
- Add tests for every behavior change. Unit tests must not contact Hugging Face.
- Avoid runtime dependencies when Node and Pi APIs suffice.
- Before finishing, run `npm run check` and `npm run slophammer`, then run `git diff --check`.
- Apply Slophammer guidance from https://github.com/osolmaz/slophammer/blob/main/docs/AGENT_ENTRYPOINT.md.
