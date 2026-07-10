# @datar-platform/better-auth-dynamodb

## 0.1.0

First stable release. No code changes since `0.1.0-alpha.1` — the adapter, the
built-in single-table store, the query planner, and draining pagination are all
covered by unit and real-DynamoDB (LocalStack) end-to-end tests. Published with
npm provenance.

## 0.1.0-alpha.1

### Patch Changes

- Declared `@better-auth/core` as an optional peer dependency so the published
  type declarations (which reference `@better-auth/core/db`) resolve cleanly
  under strict package managers.
- Releases are now published with npm provenance.
- No runtime behavior changes.

## 0.1.0-alpha.0

### Minor Changes

- Initial release. A generic DynamoDB adapter for Better Auth, built on a
  pluggable `DynamoStore` seam.
  - `dynamoAdapter()` implements the full Better Auth adapter contract via
    `createAdapterFactory`, with a declarative where→index planner (`planQuery`)
    driven by an `IndexMap`.
  - Ships a zero-dependency built-in single-table store whose index map is
    auto-derived from the Better Auth schema, so any model or plugin works out of
    the box. `ensureSchema()` / `generateSchemaFile()` provision the table.
  - Bring your own store by implementing `DynamoStore` — the seam is expressed in
    logical index names and field values only, never physical PK/SK.
  - Correct draining pagination, so `count` and `findMany` are not silently
    capped at a single DynamoDB page.
