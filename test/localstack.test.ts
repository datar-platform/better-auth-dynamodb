import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { betterAuth } from "better-auth";
import { getAuthTables } from "better-auth/db";
import { beforeAll, describe, expect, it } from "vitest";

import type { DynamoStore } from "../src/index";
import {
  assignSlots,
  createSingleTableStore,
  deriveIndexMap,
  dynamoAdapter,
  ensureSchema,
} from "../src/index";

/**
 * Exercises the built-in single-table store against a *real* DynamoDB (LocalStack
 * or DynamoDB Local). The in-memory store used elsewhere cannot prove the parts
 * that only exist once a real GSI is involved: physical key encoding, slot
 * assignment, `Select: "COUNT"`, and — critically — `LastEvaluatedKey` draining
 * across a real page boundary.
 *
 * Opt-in, because it needs a running DynamoDB:
 *
 *   docker compose up -d
 *   AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test pnpm test:e2e
 */
const ENDPOINT = process.env.DYNAMODB_ENDPOINT ?? "http://localhost:4566";
const REGION = process.env.AWS_REGION ?? "us-east-1";

const describeE2E = process.env.DYNAMO_E2E === "1" ? describe : describe.skip;

/** A fresh table per run, so repeated runs never see each other's rows. */
const TABLE = `better-auth-e2e-${process.pid}`;

const AUTH_OPTIONS = {
  secret: "test-secret-that-is-at-least-32-chars-long",
  emailAndPassword: { enabled: true },
} as const;

/** Built through a factory so `auth`'s inferred option type survives. */
const createAuth = () =>
  betterAuth({
    ...AUTH_OPTIONS,
    database: dynamoAdapter({
      tableName: TABLE,
      region: REGION,
      endpoint: ENDPOINT,
    }),
  });

describeE2E("built-in single-table store against real DynamoDB", () => {
  let store: DynamoStore;
  let auth: ReturnType<typeof createAuth>;

  beforeAll(async () => {
    const client = new DynamoDBClient({
      region: REGION,
      endpoint: ENDPOINT,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
      },
    });

    // Provision using the package's own exports — the same index map the adapter
    // derives internally, so the table matches the access patterns exactly.
    const indexMap = deriveIndexMap(getAuthTables(AUTH_OPTIONS));
    await ensureSchema({
      client,
      tableName: TABLE,
      lookupSlots: assignSlots(indexMap).maxSlots,
    });

    store = createSingleTableStore({
      tableName: TABLE,
      region: REGION,
      endpoint: ENDPOINT,
      indexMap,
    });

    auth = createAuth();
  }, 90_000);

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
    const adapter = dynamoAdapter({
      tableName: TABLE,
      region: REGION,
      endpoint: ENDPOINT,
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
});
