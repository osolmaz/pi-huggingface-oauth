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
  it("keeps package publication disabled until implementation", () => {
    const manifest = parseRecord(readText("package.json"));
    expect(manifest["name"]).toBe("pi-huggingface-oauth");
    expect(manifest["version"]).toBe("0.0.0");
    expect(manifest["private"]).toBe(true);
    expect(manifest["pi"]).toEqual({ extensions: ["./index.ts"] });
  });

  it("documents the provider and persistence boundaries", () => {
    const spec = readText("SPEC.md");
    expect(spec).toContain('pi.registerProvider("huggingface"');
    expect(spec).toContain("inference-api");
    expect(spec).toContain("adds no session entries");
  });

  it("keeps the README license link as its final section", () => {
    expect(readText("README.md").trimEnd()).toMatch(/## License\n\n\[MIT\]\(LICENSE\)$/u);
  });
});
