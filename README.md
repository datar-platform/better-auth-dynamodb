# @datar-platform/better-auth-dynamodb

A generic [DynamoDB](https://aws.amazon.com/dynamodb/) adapter for [Better Auth](https://better-auth.com).

- **Works out of the box** with any Better Auth model or plugin — the built-in
  single-table store derives its indexes from your schema (`unique` fields and
  foreign keys), so two-factor, passkey, API-key, organization, etc. just work.
- **Bring your own store.** The adapter talks to a small `DynamoStore` seam, so
  you can back it with an existing single-table design (ElectroDB, custom key
  encoding, a shared table) without changing the adapter.
- **Correct pagination.** `findMany`/`count` drain every page — no silent row cap.
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

| Option      | Default                               | Description                                                                                       |
| ----------- | ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `store`     | built-in single-table store           | Storage backend (`DynamoStore`).                                                                  |
| `indexMap`  | derived from schema                   | Access-pattern map.                                                                               |
| `tableName` | `DYNAMODB_TABLE_NAME` → `better-auth` | Table name (built-in store).                                                                      |
| `region`    | SDK default                           | AWS region (built-in store).                                                                      |
| `endpoint`  | SDK default                           | Endpoint override for DynamoDB Local / LocalStack, e.g. `http://localhost:4566` (built-in store). |
| `debugLogs` | `false`                               | Better Auth debug logging.                                                                        |

## Notes & limitations

- IDs are strings (Better Auth generates them); `supportsNumericIds` is `false`.
- Dates are stored as ISO strings and re-hydrated on read (`supportsDates: false`).
- No native transactions — multi-row ops run sequentially in small batches.
- The built-in store's derived index map keys on schema field names; custom
  `fieldName` mappings are not yet resolved in derivation (pass an explicit
  `indexMap` if you rename fields).

## License

MIT
