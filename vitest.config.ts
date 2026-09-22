import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
    environment: "node",
    // Two workers keep a fanless MacBook Air cool.
    maxWorkers: 2,
  },
});
