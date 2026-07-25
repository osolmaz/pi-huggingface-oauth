import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      include: ["index.ts", "src/**/*.ts"],
      provider: "v8",
      reporter: ["text", "json", "json-summary"],
      thresholds: {
        branches: 85,
        functions: 85,
        lines: 85,
        statements: 85,
      },
    },
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
  },
});
