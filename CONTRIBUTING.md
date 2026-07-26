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

## Releases

npm releases are published from GitHub Releases through `.github/workflows/publish.yml`. Before publishing a release:

1. Update `package.json` and `package-lock.json` to the intended version.
2. Merge the release commit into `main` and wait for CI to pass.
3. Confirm npm trusts the GitHub Actions publisher for user `osolmaz`, repository `pi-huggingface-oauth`, workflow `publish.yml`, and the `npm publish` action.
4. Publish a GitHub Release whose tag is exactly `vX.Y.Z` for the package version.

The workflow checks the package metadata, tag, default-branch ancestry, unpublished version, tests, coverage, Slophammer, package contents, and Git diff before publishing with npm provenance. It then verifies that the version reached the registry.
