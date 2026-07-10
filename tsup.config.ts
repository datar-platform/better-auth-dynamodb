import { defineConfig } from "tsup";

/**
 * Publish build for @datar-platform/better-auth-dynamodb.
 *
 * The source uses extensionless relative imports, which a plain `tsc`
 * (module: Preserve) would emit verbatim — producing a dist that only bundlers
 * can resolve, not raw Node ESM. tsup bundles the whole package into a single
 * self-contained `dist/index.js` (no relative imports in the output at all),
 * so the published artifact is valid Node ESM regardless of how the source
 * imports are written. Runtime deps (@aws-sdk/*) and peer deps (better-auth)
 * are left external.
 */
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node22",
});
