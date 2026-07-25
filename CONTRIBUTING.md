# Contributing

Review `SPEC.md` before changing the implementation because it defines the provider boundary and OAuth behavior.

## Development rules

Use documented Pi extension APIs and the standard library where they are sufficient. Keep OAuth protocol code independent from Pi UI code. Validate network data from `unknown`, avoid explicit `any` and unchecked casts, and never log credentials or raw token responses.

Every behavior change needs tests. Protocol tests must use fake responses and must not contact Hugging Face. A maintainer performs the real OAuth smoke test with a revocable authorization before release.

Run these commands before submitting a change:

```bash
npm run check
npm run slophammer
git diff --check
```

Mutation testing is available through `npm run mutate`, but it should run only when requested or through the manual CI job.
