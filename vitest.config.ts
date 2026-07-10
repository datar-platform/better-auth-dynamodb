import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "better-auth-dynamodb",
    globals: true,
    environment: "node",
    testTimeout: 60000,
    hookTimeout: 60000,
    include: ["src/**/*.{test,spec}.{js,ts}", "test/**/*.{test,spec}.{js,ts}"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
