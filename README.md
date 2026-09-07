# @datar-platform/better-auth-dynamodb

A generic [DynamoDB](https://aws.amazon.com/dynamodb/) adapter for [Better Auth](https://better-auth.com).

- **Works out of the box** with any Better Auth model or plugin — the built-in
  single-table store derives its indexes from your schema (`unique` fields and
  foreign keys), so two-factor, passkey, API-key, organization, etc. just work.
- **Bring your own store.** The adapter talks to a small `DynamoStore` seam, so
  you can back it with an existing single-table design (ElectroDB, custom key
  encoding, a shared table) without changing the adapter.
- **Atomic uniqueness.** `unique` fields are enforced by DynamoDB itself, in the
  same transaction as the row — not by a check-then-insert two concurrent
  sign-ups can both pass.
- **Safe under concurrency.** Every row carries a revision that guards updates,
  deletes, and single-use consumes against lost writes.
- **No hidden scans, no silent truncation.** A query no index can serve fails
  loudly instead of quietly reading the whole model, and pagination that hits
  its cap throws rather than returning part of an answer.
- **Passes Better Auth's official adapter conformance suites** against real
  DynamoDB.
- Zero dependencies beyond the AWS SDK.

## Install

```bash
npm install @datar-platform/better-auth-dynamodb @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb
```

## Quick start (built-in single-table store)

```ts
import { dynamoAdapter } from "@datar-platform/better-auth-dynamodb";
import { betterAuth } from "better-auth";

export const auth = betterAuth({
  database: dynamoAdapter({
    tableName: "better-auth", // or set DYNAMODB_TABLE_NAME
    region: "us-east-1",
  }),
  emailAndPassword: { enabled: true },
});
```

### Provision the table

The store uses one table with a `byType` GSI (to list a model) plus one generic
lookup GSI per index a model needs. Create it once at startup or in setup:

```ts
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  assignSlots,
  deriveIndexMap,
  ensureSchema,
} from "@datar-platform/better-auth-dynamodb";

// `schema` is your Better Auth instance's resolved DB schema.
const indexMap = deriveIndexMap(schema);
await ensureSchema({
  client: new DynamoDBClient({ region: "us-east-1" }),
  tableName: "better-auth",
  lookupSlots: assignSlots(indexMap).maxSlots,
});
```

You can also generate a CloudFormation template via the Better Auth CLI
(`npx @better-auth/cli generate`) — the adapter's `createSchema` emits one sized
to your access patterns.

### Expiring sessions and verifications

Nothing expires on its own. Point the adapter at your expiry field and DynamoDB
reaps expired rows for free:

```ts
dynamoAdapter({
  tableName: "better-auth",
  ttl: { defaultField: "expiresAt" },
});
```

Pass the same attribute to `ensureSchema({ ..., ttlAttribute: "__ba_ttl" })` —
the adapter writes the attribute, but only the table setting makes AWS act on
it. Reads treat it as _logical_ expiry too: DynamoDB reaps lazily, often a day
or two late, so without that an expired session would keep working until AWS got
round to deleting it.

### Upgrading from 0.1.x

0.2.0 changed the physical key format, so rows written by 0.1.x survive but are
no longer found by any lookup. Recreating the table is fine in development; if
it holds real users, migrate it instead:

```ts
import {
  deriveIndexMap,
  migrateKeys,
} from "@datar-platform/better-auth-dynamodb";
import { getAuthTables } from "better-auth/db";

const indexMap = deriveIndexMap(getAuthTables(betterAuthOptions));

// Look before you leap: a dry run writes nothing, and names any duplicate that
// would block the migration.
console.log(await migrateKeys({ tableName, indexMap, client, dryRun: true }));

await migrateKeys({ tableName, indexMap, client });
```

It rewrites each row into the current format and backfills the uniqueness
markers 0.1.x never wrote, so existing rows end up protected rather than merely
readable. Nothing happens automatically on upgrade — rewriting an auth table on
first boot is not a decision this package makes for you — and running it on a
table with nothing to migrate is a no-op, so it is safe in a deploy step and
safe to run twice.

If two old rows claim the same `unique` value, it stops before writing anything
and reports their ids. 0.1.x enforced uniqueness in Better Auth's application
layer, which two concurrent sign-ups could both pass; deciding which row keeps
the email is yours to make, not the migration's.

### Uniqueness

Fields the Better Auth schema marks `unique` — `user.email`, `session.token`,
`organization.slug` — get a marker row written in the same
`TransactWriteItems` as the row itself, conditional on the marker not already
existing. That makes uniqueness a property of the database: of two concurrent
sign-ups for the same email, exactly one commits.

Better Auth's own enforcement is a check-then-insert, which both racers can
pass. Set `atomicUniqueness: false` to fall back to it and halve the write cost
of creates.

Two caveats worth knowing:

- Markers are created by writes made on 0.2.0+. Upgrading an existing table
  enforces uniqueness going forward; it does not find duplicates already there.
- Do not write Better Auth rows into the table with a raw `PutItem`. Entity
  rows, index keys, markers, and TTL attributes have to move together.

## Bring your own store

Implement `DynamoStore` to run the same adapter against your own table layout.
The adapter drives it purely through **logical index names + field values** — it
never touches physical `PK`/`SK` strings, so your store owns all key encoding.

```ts
import { dynamoAdapter } from "@datar-platform/better-auth-dynamodb";

import type {
  DynamoStore,
  IndexMap,
} from "@datar-platform/better-auth-dynamodb";

const store: DynamoStore = {
  put(model, item) {
    /* ... */
  },
  getById(model, id) {
    /* ... */
  },
  update(model, id, patch) {
    /* ... */
  },
  deleteById(model, id) {
    /* ... */
  },
  queryIndex({ model, index, key }) {
    /* map (model, index, key) -> a GSI query */
  },
  listByType({ model }) {
    /* list all rows of a model */
  },
  // optional: count(), createSchema()
};

// Describe which fields each model is looked up by:
const indexMap: IndexMap = {
  user: [{ index: "byEmail", pk: ["email"] }],
  account: [
    { index: "byUser", pk: ["userId"], sk: ["providerId"] },
    { index: "byAccountId", pk: ["accountId"], sk: ["providerId"] },
  ],
  // ...
};

betterAuth({ database: dynamoAdapter({ store, indexMap }) });
```

Given a `where`, the adapter picks the first access pattern whose partition-key
fields are all present (attaching any leading sort-key fields), then filters any
remaining predicates in memory. Provide an `indexMap` to match your table, or
omit it to auto-derive from the schema.

## Configuration

| Option             | Default                               | Description                                                                                                                 |
| ------------------ | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `store`            | built-in single-table store           | Storage backend (`DynamoStore`).                                                                                            |
| `indexMap`         | derived from schema                   | Access-pattern map.                                                                                                         |
| `tableName`        | `DYNAMODB_TABLE_NAME` → `better-auth` | Table name (built-in store).                                                                                                |
| `region`           | SDK default                           | AWS region (built-in store).                                                                                                |
| `endpoint`         | SDK default                           | Endpoint override for DynamoDB Local / LocalStack, e.g. `http://localhost:8000` (built-in store).                           |
| `documentClient`   | created internally                    | Pre-built `DynamoDBDocumentClient`. Preferred in production, so your app owns credentials, region, middleware, and tracing. |
| `atomicUniqueness` | `true`                                | Enforce `unique` fields with transactional marker rows.                                                                     |
| `ttl`              | disabled                              | Adapter-managed DynamoDB TTL, e.g. `{ defaultField: "expiresAt" }`.                                                         |
| `maxPages`         | `25`                                  | Cap on pages drained per query. Throws at the cap rather than returning a partial result.                                   |
| `pageSize`         | SDK default                           | Per-request DynamoDB `Limit`. Changes request sizing only, not logical results.                                             |
| `unsafeAllowScan`  | `false`                               | Allow queries no index can serve, which read every row of the model and filter in memory.                                   |
| `debugLogs`        | `false`                               | Better Auth debug logging.                                                                                                  |

## Notes & limitations

- IDs are strings (Better Auth generates them); `supportsNumericIds` is `false`.
- Dates are stored as ISO strings and re-hydrated on read (`supportsDates: false`).
- No interactive transactions — DynamoDB has no such API, so the adapter
  reports `transaction: false`. `TransactWriteItems` is used internally for
  single-row atomic operations; multi-row ops run sequentially in small batches.
- Case-insensitive equality (`mode: "insensitive"`) cannot come from an index,
  because DynamoDB compares keys byte-for-byte. Those clauses are matched in
  memory, so they need `unsafeAllowScan: true` unless another clause in the same
  `where` can be served by an index.
- Better Auth's verification cleanup issues a range-only
  `deleteMany(expiresAt < now)`, which has no key to work from. Configure `ttl`
  and set `verification: { disableCleanup: true }` — that is the
  DynamoDB-shaped answer to the same problem.
- The built-in store's derived index map keys on schema field names; custom
  `fieldName` mappings are not yet resolved in derivation (pass an explicit
  `indexMap` if you rename fields).
- Key values longer than 256 bytes are SHA-256 hashed into the key. Lookups are
  unaffected — both sides hash identically — but a key is no longer always
  readable as plain text when debugging.

## License

MIT
