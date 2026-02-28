import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals:     true,
    environment: "node",
    include:     ["tests/**/*.test.ts"],
    // Run tests serially — SQLite is file-based and tests share in-memory state
    pool:        "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
