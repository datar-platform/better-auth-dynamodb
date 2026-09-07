import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "better-auth-dynamodb",
    globals: true,
    environment: "node",
    testTimeout: 60000,
    hookTimeout: 60000,
    include: ["src/**/*.{test,spec}.{js,ts}", "test/**/*.{test,spec}.{js,ts}"],
    // Docker-backed suites live in their own config (`pnpm test:integration`)
    // so the default gate needs nothing but Node.
    exclude: ["**/node_modules/**", "**/dist/**", "test/integration/**"],
  },
});
