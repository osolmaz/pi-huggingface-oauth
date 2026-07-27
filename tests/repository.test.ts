import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function readText(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

function parseRecord(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected a JSON object");
  }
  return value as Record<string, unknown>;
}

describe("repository contract", () => {
  it("defines the public npm package", () => {
    const manifest = parseRecord(readText("package.json"));
    expect(manifest["name"]).toBe("pi-huggingface-oauth");
    expect(manifest["version"]).toBe("0.1.1");
    expect(manifest["private"]).toBeUndefined();
    expect(manifest["publishConfig"]).toEqual({ access: "public" });
    expect(manifest["files"]).toContain("CHANGELOG.md");
    expect(manifest["pi"]).toEqual({ extensions: ["./index.ts"] });
    expect(manifest["peerDependencies"]).toEqual({
      "@earendil-works/pi-ai": ">=0.82.1",
      "@earendil-works/pi-coding-agent": ">=0.82.1",
    });
  });

  it("publishes from a version-matched GitHub Release through npm OIDC", () => {
    const workflow = readText(".github/workflows/publish.yml");
    expect(workflow).toContain("release:");
    expect(workflow).toContain("types: [published]");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain('node-version: "24"');
    expect(workflow).toContain("package.json version");
    expect(workflow).toContain("merge-base");
    expect(workflow).toContain("npm publish --access public --provenance");
    expect(workflow).not.toContain("NPM_TOKEN");
    expect(workflow).not.toContain("workflow_dispatch");
  });

  it("documents the provider and persistence boundaries", () => {
    const spec = readText("SPEC.md");
    expect(spec).toContain("pi.registerProvider(");
    expect(spec).toContain('pi.registerProvider("huggingface", {');
    expect(spec).toContain("must not register a replacement native provider");
    expect(spec).toContain("inference-api");
    expect(spec).toContain("adds no session entries");
    expect(spec).toContain("provider model store");
  });

  it("keeps the README license link as its final section", () => {
    expect(readText("README.md").trimEnd()).toMatch(/## License\n\n\[MIT\]\(LICENSE\)$/u);
  });
});
