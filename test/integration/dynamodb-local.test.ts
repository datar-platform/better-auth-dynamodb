import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { betterAuth } from "better-auth";
import { getAuthTables } from "better-auth/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { DynamoStore } from "../../src/index";
import {
  assignSlots,
  createSingleTableStore,
  deriveIndexMap,
  dynamoAdapter,
  ensureSchema,
  migrateKeys,
  UniqueConstraintError,
} from "../../src/index";
import { startDynamoLocal, type DynamoLocal } from "../support/dynamodb-local";

/**
 * Exercises the built-in single-table store against a *real* DynamoDB (AWS's
 * own DynamoDB Local, started by Testcontainers). The in-memory doubles used
 * elsewhere cannot prove the parts that only exist once a real GSI and a real
 * transaction engine are involved: physical key encoding, slot assignment,
 * `Select: "COUNT"`, `LastEvaluatedKey` draining across a genuine page
 * boundary, and `TransactWriteItems` actually rejecting a duplicate.
 *
 *   pnpm test:integration
 */
const TABLE = `better-auth-e2e-${process.pid}`;

const AUTH_OPTIONS = {
  secret: "test-secret-that-is-at-least-32-chars-long",
  emailAndPassword: { enabled: true },
} as const;

let dynamo: DynamoLocal;

/** Built through a factory so `auth`'s inferred option type survives. */
const createAuth = () =>
  betterAuth({
    ...AUTH_OPTIONS,
    database: dynamoAdapter({
      tableName: TABLE,
      documentClient: dynamo.documentClient,
    }),
  });

describe("built-in single-table store against real DynamoDB", () => {
  let store: DynamoStore;
  let client: DynamoDBClient;
  let auth: ReturnType<typeof createAuth>;

  beforeAll(async () => {
    dynamo = await startDynamoLocal();
    client = dynamo.client;

    // Provision using the package's own exports — the same index map the
    // adapter derives internally, so the table matches the access patterns.
    const indexMap = deriveIndexMap(getAuthTables(AUTH_OPTIONS));
    await ensureSchema({
      client,
      tableName: TABLE,
      lookupSlots: assignSlots(indexMap).maxSlots,
    });

    store = createSingleTableStore({
      tableName: TABLE,
      documentClient: dynamo.documentClient,
      indexMap,
    });

    auth = createAuth();
  }, 180_000);

  afterAll(async () => {
    await dynamo?.stop();
  });

  it("runs a real sign-up -> sign-in -> session flow", async () => {
    const email = `e2e-${Date.now()}@example.com`;

    const signUp = await auth.api.signUpEmail({
      body: { email, password: "correct-horse-battery", name: "E2E User" },
    });
    expect(signUp.user.email).toBe(email);

    const signIn = await auth.api.signInEmail({
      body: { email, password: "correct-horse-battery" },
      asResponse: true,
    });
    expect(signIn.status).toBe(200);

    // Wrong password must be rejected — proves we read back the real hash.
    await expect(
      auth.api.signInEmail({ body: { email, password: "wrong-password" } }),
    ).rejects.toThrow();
  }, 30_000);

  it("finds a user by its derived unique index (real GSI query)", async () => {
    const email = `lookup-${Date.now()}@example.com`;
    await auth.api.signUpEmail({
      body: { email, password: "correct-horse-battery", name: "Lookup" },
    });

    const page = await store.queryIndex({
      model: "user",
      index: "by_email",
      key: { email },
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.email).toBe(email);
    // Physical key attributes must not leak back to the caller.
    expect(page.items[0]).not.toHaveProperty("pk");
    expect(page.items[0]).not.toHaveProperty("gsi1pk");
  }, 30_000);

  it("drains LastEvaluatedKey across a real page boundary", async () => {
    // DynamoDB caps a Query response at 1MB. Write rows padded so that a single
    // page cannot hold them all, then assert count/listByType see every row.
    const model = "verification";
    const padding = "x".repeat(300 * 1024); // ~300KB -> 1MB page holds ~3
    const written = 8;

    for (let i = 0; i < written; i++) {
      await store.put(model, {
        id: `page-probe-${i}`,
        identifier: `probe-${i}`,
        value: padding,
        expiresAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

    // listByType must drain, not stop at the first 1MB page.
    let seen = 0;
    let cursor: unknown = undefined;
    let pages = 0;
    do {
      const page = await store.listByType({ model, cursor });
      seen += page.items.length;
      cursor = page.cursor;
      pages++;
    } while (cursor);

    expect(pages).toBeGreaterThan(1); // the boundary is genuinely exercised
    expect(seen).toBe(written);

    // The store's native COUNT fast-path must agree, and must also drain.
    expect(await store.count?.({ model })).toBe(written);
  }, 120_000);

  it("adapter.findMany drains every page, then sorts and windows", async () => {
    // The adapter's own drainPages must see rows beyond the first 1MB page
    // before applySort/applyWindow run — otherwise sort+offset silently operate
    // on a truncated set. Reuses the padded rows written above.
    // `unsafeAllowScan` because listing a whole model with no `where` is
    // exactly the access pattern the guard exists to make explicit.
    const adapter = dynamoAdapter({
      tableName: TABLE,
      documentClient: dynamo.documentClient,
      unsafeAllowScan: true,
    })(AUTH_OPTIONS);

    const all = await adapter.findMany<{ id: string }>({
      model: "verification",
      limit: 100,
      sortBy: { field: "identifier", direction: "asc" },
    });
    const probes = all.filter((r) => r.id.startsWith("page-probe-"));
    expect(probes).toHaveLength(8);

    // Sort must be global across pages, not per-page.
    const asc = await adapter.findMany<{ id: string; identifier: string }>({
      model: "verification",
      limit: 3,
      sortBy: { field: "identifier", direction: "asc" },
    });
    const desc = await adapter.findMany<{ id: string; identifier: string }>({
      model: "verification",
      limit: 3,
      sortBy: { field: "identifier", direction: "desc" },
    });
    expect(asc[0]?.identifier).toBe("probe-0");
    expect(desc[0]?.identifier).toBe("probe-7");

    // offset walks the fully-drained, globally-sorted set.
    const offset = await adapter.findMany<{ identifier: string }>({
      model: "verification",
      limit: 2,
      offset: 2,
      sortBy: { field: "identifier", direction: "asc" },
    });
    expect(offset.map((r) => r.identifier)).toEqual(["probe-2", "probe-3"]);

    expect(await adapter.count({ model: "verification" })).toBe(8);
  }, 120_000);

  it("supports update, count and delete round-trips", async () => {
    const email = `crud-${Date.now()}@example.com`;
    const { user } = await auth.api.signUpEmail({
      body: { email, password: "correct-horse-battery", name: "Before" },
    });

    const updated = await store.update("user", user.id, { name: "After" });
    expect(updated?.name).toBe("After");
    expect((await store.getById("user", user.id))?.name).toBe("After");

    await store.deleteById("user", user.id);
    expect(await store.getById("user", user.id)).toBeNull();

    // The unique-email index must no longer resolve the deleted row.
    const page = await store.queryIndex({
      model: "user",
      index: "by_email",
      key: { email },
    });
    expect(page.items).toHaveLength(0);
  }, 30_000);

  it("consumeOne atomically deletes-and-returns, and won't double-consume", async () => {
    const id = `verify-${Date.now()}`;
    await store.put("verification", {
      id,
      identifier: id,
      value: "otp-value",
      expiresAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const consumed = await store.consumeOne!("verification", id);
    expect(consumed?.value).toBe("otp-value");

    // Second consume of the same id finds nothing — it was really deleted.
    expect(await store.consumeOne!("verification", id)).toBeNull();
    expect(await store.getById("verification", id)).toBeNull();
  }, 30_000);

  it("incrementOne atomically adds and sets in one round-trip", async () => {
    const id = `counter-${Date.now()}`;
    await store.put("verification", {
      id,
      identifier: id,
      value: "0",
      attempts: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const bumped = await store.incrementOne!("verification", id, {
      increment: { attempts: 1 },
      set: { value: "bumped" },
    });
    expect(bumped?.attempts).toBe(2);
    expect(bumped?.value).toBe("bumped");

    const bumpedAgain = await store.incrementOne!("verification", id, {
      increment: { attempts: 3 },
    });
    expect(bumpedAgain?.attempts).toBe(5);
  }, 30_000);

  it("rejects a duplicate unique value at the database, not the app layer", async () => {
    const email = `dupe-${Date.now()}@example.com`;
    await store.put("user", {
      id: `dupe-a-${Date.now()}`,
      email,
      name: "First",
      emailVerified: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // This is the case Better Auth's check-then-insert cannot close: the
    // constraint has to live in DynamoDB for a concurrent second writer to lose.
    await expect(
      store.put("user", {
        id: `dupe-b-${Date.now()}`,
        email,
        name: "Second",
        emailVerified: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    ).rejects.toBeInstanceOf(UniqueConstraintError);
  }, 30_000);

  it("lets exactly one of two concurrent sign-ups win the same email", async () => {
    const email = `race-${Date.now()}@example.com`;
    const attempt = () =>
      auth.api.signUpEmail({
        body: { email, password: "correct-horse-battery", name: "Racer" },
      });

    const results = await Promise.allSettled([attempt(), attempt()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);

    // And exactly one row survives, not two.
    const page = await store.queryIndex({
      model: "user",
      index: "by_email",
      key: { email },
    });
    expect(page.items).toHaveLength(1);
  }, 60_000);

  it("frees a unique value when its row is deleted, and reuses it", async () => {
    const email = `recycle-${Date.now()}@example.com`;
    const { user } = await auth.api.signUpEmail({
      body: { email, password: "correct-horse-battery", name: "First" },
    });
    await store.deleteById("user", user.id);

    await expect(
      auth.api.signUpEmail({
        body: { email, password: "correct-horse-battery", name: "Second" },
      }),
    ).resolves.toBeTruthy();
  }, 60_000);

  it("refuses to overwrite an existing row through create", async () => {
    const id = `create-twice-${Date.now()}`;
    const row = {
      id,
      identifier: id,
      value: "v",
      expiresAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await store.put("verification", row);
    await expect(store.put("verification", row)).rejects.toThrow(
      /already exists/,
    );
  }, 30_000);

  it("stores a value containing the key delimiter without collision", async () => {
    // Provider-supplied values reach these keys verbatim; a `#` in one must not
    // let it be read back as another row.
    const now = new Date().toISOString();
    const base = { createdAt: now, updatedAt: now, providerId: "credential" };
    await store.put("account", {
      ...base,
      id: `hash-a-${Date.now()}`,
      userId: "u#1",
      accountId: "acc-2",
    });
    await store.put("account", {
      ...base,
      id: `hash-b-${Date.now()}`,
      userId: "u",
      accountId: "acc#1-2",
    });

    const page = await store.queryIndex({
      model: "account",
      index: "by_userId",
      key: { userId: "u#1" },
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.accountId).toBe("acc-2");
  }, 30_000);

  it("round-trips a value far longer than a DynamoDB key allows", async () => {
    const identifier = `long-${"x".repeat(4000)}`;
    const id = `long-${Date.now()}`;
    await store.put("verification", {
      id,
      identifier,
      value: "v",
      expiresAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Hashed into the key, so the write succeeds and the lookup still finds it.
    const page = await store.queryIndex({
      model: "verification",
      index: "by_identifier",
      key: { identifier },
    });
    expect(page.items.map((i) => i.id)).toContain(id);
  }, 30_000);

  it("migrates a 0.1.x row back into service, markers and all", async () => {
    // Written exactly as 0.1.x did: keys joined on a bare "#", no row-kind
    // prefix, no uniqueness marker. Hand-built through the raw client, because
    // the point is that the current store would never produce this.
    const id = `legacy-${Date.now()}`;
    const email = `legacy-${Date.now()}@example.com`;
    const now = new Date().toISOString();
    await dynamo.documentClient.send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          id,
          email,
          name: "Legacy User",
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
          __ba_pk: `user#${id}`,
          __ba_sk: "#",
          __ba_tpk: "user",
          __ba_tsk: `${now}#${id}`,
          __ba_g1pk: `user#by_email#${email}`,
          __ba_g1sk: id,
        },
      }),
    );

    // The row is physically there, and completely invisible to this version.
    expect(await store.getById("user", id)).toBeNull();

    const indexMap = deriveIndexMap(getAuthTables(AUTH_OPTIONS));
    const dry = await migrateKeys({
      tableName: TABLE,
      indexMap,
      documentClient: dynamo.documentClient,
      dryRun: true,
    });
    expect(dry.migrated).toBeGreaterThanOrEqual(1);
    expect(dry.conflicts).toEqual([]);
    // A dry run really is dry.
    expect(await store.getById("user", id)).toBeNull();

    const report = await migrateKeys({
      tableName: TABLE,
      indexMap,
      documentClient: dynamo.documentClient,
    });
    expect(report.conflicts).toEqual([]);
    expect(report.migrated).toBeGreaterThanOrEqual(1);

    // Readable by id...
    expect(await store.getById("user", id)).toMatchObject({ id, email });
    // ...and by the real GSI, which is what a sign-in actually uses.
    const page = await store.queryIndex({
      model: "user",
      index: "by_email",
      key: { email },
    });
    expect(page.items.map((i) => i.id)).toContain(id);

    // And the backfilled marker now protects a value 0.1.x left unguarded.
    await expect(
      store.put("user", {
        id: `${id}-clash`,
        email,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      }),
    ).rejects.toBeInstanceOf(UniqueConstraintError);

    // Running it again finds nothing left to do.
    const second = await migrateKeys({
      tableName: TABLE,
      indexMap,
      documentClient: dynamo.documentClient,
    });
    expect(second.noop).toBe(true);
  }, 60_000);
});
