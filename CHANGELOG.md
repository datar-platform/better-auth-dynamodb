# @datar-platform/better-auth-dynamodb

## 0.1.1

### Patch Changes

- Implemented `consumeOne` and `incrementOne` on the adapter and the built-in
  single-table store. Better Auth's core adapter factory (`@better-auth/core`
  1.7.x) requires `consumeOne` for atomic single-use credential consumption —
  used by the email-OTP verify flow — and `incrementOne` for atomic guarded
  counter updates. Without them, any consumer on better-auth >=1.7 hit
  `BetterAuthError: Adapter "dynamodb" must implement consumeOne for atomic
single-use credential consumption` the first time a plugin exercised that
  path (e.g. `emailOTP().signIn`).
- `consumeOne` is implemented on the built-in store as a native
  `DeleteCommand` with `ReturnValues: "ALL_OLD"` (atomic delete-and-return);
  `incrementOne` as a native `UpdateCommand` with `ADD`/`SET` expressions and
  `ReturnValues: "ALL_NEW"`.
- Both are optional on the `DynamoStore` interface — a custom store that
  doesn't implement them still works via a non-atomic get-then-write fallback
  in the adapter, so this is not a breaking change for existing custom
  stores.
- Added LocalStack e2e coverage for both.

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
