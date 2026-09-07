# @datar-platform/better-auth-dynamodb

## 0.2.0

### Breaking

- **The physical key format changed.** Every variable component of a key is now
  written length-prefixed (`s<byteLength>:<value>`) and type-tagged, and a
  value longer than 256 bytes is SHA-256 hashed into the key. Existing tables
  written by 0.1.x will not be found by 0.2.0 and must be recreated. See
  "Delimiter safety" below for why this was worth a break.
- **Queries no index can serve now throw** instead of silently reading every
  row of the model and filtering in memory. Set `unsafeAllowScan: true` to
  restore the old behaviour, or give the field an index (`unique`,
  `references`, or `index: true` in the Better Auth schema). Native `count` is
  unaffected — it is a keyed `Select: COUNT` query, not a scan.
- **`create` no longer overwrites.** `put` is conditional on the row not
  already existing, so a colliding id fails loudly rather than replacing data.
- **Peer range raised to `better-auth >= 1.7.0`**, which is what the adapter is
  now built and conformance-tested against.
- Draining is capped at `maxPages` (default 25). A query with pages remaining
  at the cap throws rather than returning a partial result — silently dropping
  rows from an auth query is worse than failing.

### Added

- **Atomic uniqueness.** `unique` schema fields (`user.email`, `session.token`,
  `organization.slug`, …) are enforced by DynamoDB itself, via marker rows
  written in the same `TransactWriteItems` as the row they describe. Better
  Auth's own enforcement is a check-then-insert, which two concurrent sign-ups
  can both pass. Opt out with `atomicUniqueness: false`.
  - Note for existing tables: markers are only created by writes made on
    0.2.0+. Uniqueness is enforced going forward; pre-existing duplicates are
    not detected retroactively.
- **Optimistic concurrency.** Every row carries a hidden revision that guards
  `update`, `delete`, `consumeOne`, and `incrementOne`. A write that lost a
  race retries against the fresh row, then fails with `OptimisticLockError`
  rather than silently clobbering a concurrent change. Rows written before
  0.2.0 are matched on the revision being absent, so they migrate in place on
  first write.
- **Adapter-managed TTL** (`ttl: { defaultField: "expiresAt" }`). The
  configured date field is projected into a DynamoDB TTL attribute so expired
  sessions and verifications are reaped for free, and the same attribute is
  treated as _logical_ expiry on read — DynamoDB reaps lazily, so without that
  an expired session would keep working until AWS got round to it.
  `ensureSchema`/`generateSchemaFile` provision the TTL setting.
- **Client injection.** `documentClient` on the adapter config, so your
  application owns credentials, region, middleware, tracing, and marshalling.
- `pageSize` for per-request `Limit` tuning.
- Typed errors, all exported and all extending `DynamoDBAdapterError`:
  `UniqueConstraintError`, `OptimisticLockError`, `UnsupportedQueryError`.

### Fixed

- **Delimiter safety.** Keys were joined with a bare `#`, so a value containing
  the delimiter could forge another key: with a composite partition key,
  `("a#b", "c")` and `("a", "b#c")` encoded identically, and a sort-key
  `begins_with("cred#")` probe matched a row whose value was literally
  `cred#ential`. Auth tables hold plenty of values that arrive from outside —
  OAuth `accountId`s, organisation slugs, verification identifiers — so this is
  now structurally impossible rather than merely unlikely.
- **Oversized key values** produced an opaque DynamoDB `ValidationException`.
  Long values are hashed; an overflow can now only come from an absurd model,
  index, or id name, and says so.
- **Cancelled transactions were all read as uniqueness violations.** DynamoDB
  cancels for throttling, item contention, and validation failures too, so a
  throttled write could be reported to a user as "that email is taken".
  Cancellations are now classified by their per-action code; contention is
  retried, and only a genuine `ConditionalCheckFailed` becomes
  `UniqueConstraintError`.
- **`incrementOne` could create the row it was told to increment.** DynamoDB's
  `ADD` is an upsert; the write is now conditional on the row existing and
  returns `null` when it does not.
- **`incrementOne` left stale index rows** when its `set` moved an indexed or
  TTL field, because a native `ADD` cannot re-encode GSI keys. Those cases now
  take the read-modify-write path.
- **A `where` naming `id` alongside other predicates ignored the others**, so a
  guarded `update`/`delete` could fire against a row that did not qualify.
- **`select` was ignored** by `findOne`/`findMany`, and needed mapping through
  the schema's `fieldName` overrides.
- **`id in [...]` fell through to a model scan.** Better Auth batch-loads rows
  it already has ids for (an organisation's members, for one), which DynamoDB
  serves as a bounded multi-get. It is now planned as one.
- **`count` used the native fast path for id lookups**, which counts a whole
  model or index — answering "how many of these three ids exist" with the size
  of the table.
- **Case-insensitive equality was served from an index**, which byte-compares
  keys and so missed every row whose casing differed. Those clauses are now
  matched in memory.

### Testing

- Better Auth's **official adapter conformance suites** (`normal`, `uuid`,
  `caseInsensitive`, `authFlow`) now run against real DynamoDB. They found four
  of the bugs listed above.
- The e2e suite moved from LocalStack + docker-compose to AWS's own DynamoDB
  Local, started per-run by Testcontainers — nothing to start by hand, no port
  collisions, no container surviving a crashed run.
- New unit suites cover key-collision resistance, transaction-cancellation
  classification, the page cap, the scan guard, and the store's write paths
  against an in-memory DynamoDB double.

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
