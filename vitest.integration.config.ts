import { defineConfig } from "vitest/config";

/**
 * Docker-backed suites, kept out of the default `pnpm test` run so the unit
 * gate stays fast and needs nothing installed. Each file owns a container and
 * a uniquely named table, so they must not race each other for the daemon.
 */
export default defineConfig({
  test: {
    name: "better-auth-dynamodb-integration",
    globals: true,
    environment: "node",
    include: ["test/integration/**/*.test.ts"],
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
