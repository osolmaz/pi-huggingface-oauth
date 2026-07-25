export default {
  checkers: ["typescript"],
  coverageAnalysis: "perTest",
  mutate: ["src/**/*.ts", "!src/**/*.test.ts"],
  reporters: ["clear-text", "progress"],
  thresholds: { break: 85, high: 90, low: 85 },
  testRunner: "vitest",
  tsconfigFile: "tsconfig.json",
};
