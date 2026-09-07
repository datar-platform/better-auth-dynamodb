import { beforeEach, describe, expect, it } from "vitest";

import {
  createFakeDynamo,
  type FakeDynamo,
} from "../../../test/support/fake-dynamo";
import {
  DynamoDBAdapterError,
  OptimisticLockError,
  UniqueConstraintError,
} from "../../errors";
import type { IndexMap } from "../../index-map";
import { REVISION } from "./key-codec";
import { createSingleTableStore } from "./single-table-store";

const indexMap: IndexMap = {
  user: [
    { index: "by_email", pk: ["email"], unique: true },
    { index: "by_org", pk: ["orgId"] },
  ],
  session: [{ index: "by_token", pk: ["token"], unique: true }],
  // No unique fields, so writes take the cheap non-transactional path.
  audit: [{ index: "by_userId", pk: ["userId"] }],
};

const store = (fake: FakeDynamo, overrides = {}) =>
  createSingleTableStore({
    tableName: "t",
    indexMap,
    documentClient: fake.client,
    ...overrides,
  });

/** Marker rows are the ones under the unique-constraint key prefix. */
const markers = (fake: FakeDynamo) => fake.rowsWithPrefix("U#");

describe("uniqueness markers", () => {
  let fake: FakeDynamo;
  beforeEach(() => {
    fake = createFakeDynamo();
  });

  it("writes one marker per unique field alongside the row", async () => {
    await store(fake).put("user", {
      id: "u_1",
      email: "ada@example.com",
      orgId: "o_1",
    });

    expect(markers(fake)).toHaveLength(1);
    expect(markers(fake)[0]!.__ba_owner).toBe("u_1");
    // `orgId` is an ordinary lookup index, not a constraint — no marker.
    expect(markers(fake).map((m) => m.__ba_owner)).toEqual(["u_1"]);
  });

  it("rejects a second row claiming the same unique value", async () => {
    const s = store(fake);
    await s.put("user", { id: "u_1", email: "ada@example.com" });

    await expect(
      s.put("user", { id: "u_2", email: "ada@example.com" }),
    ).rejects.toBeInstanceOf(UniqueConstraintError);

    // The losing row is not left behind: the transaction was all-or-nothing.
    expect(await s.getById("user", "u_2")).toBeNull();
  });

  it("reports a throttled transaction as itself, not as a duplicate", async () => {
    const s = store(fake);
    fake.failNextWrites(1); // cancels with TransactionConflict, not a condition

    // The whole point of classifying by cancellation code: telling a user
    // "that email is taken" when DynamoDB was merely busy is a lie.
    await expect(
      s.put("user", { id: "u_1", email: "ada@example.com" }),
    ).rejects.not.toBeInstanceOf(UniqueConstraintError);
  });

  it("frees the value when the owning row is deleted", async () => {
    const s = store(fake);
    await s.put("user", { id: "u_1", email: "ada@example.com" });
    await s.deleteById("user", "u_1");

    expect(markers(fake)).toHaveLength(0);
    await expect(
      s.put("user", { id: "u_2", email: "ada@example.com" }),
    ).resolves.toBeTruthy();
  });

  it("moves the marker when the unique value changes", async () => {
    const s = store(fake);
    await s.put("user", { id: "u_1", email: "ada@example.com" });
    await s.update("user", "u_1", { email: "grace@example.com" });

    expect(markers(fake)).toHaveLength(1);
    // The old value is released, so somebody else may take it.
    await expect(
      s.put("user", { id: "u_2", email: "ada@example.com" }),
    ).resolves.toBeTruthy();
  });

  it("leaves the marker untouched when the update does not move it", async () => {
    const s = store(fake);
    await s.put("user", { id: "u_1", email: "ada@example.com" });
    // Deleting and re-putting the same marker key in one transaction is a
    // self-conflict DynamoDB rejects, so an unchanged value must be skipped.
    await expect(
      s.update("user", "u_1", { name: "Ada" }),
    ).resolves.toMatchObject({ name: "Ada" });
    expect(markers(fake)).toHaveLength(1);
  });

  it("refuses an update that would take another row's value", async () => {
    const s = store(fake);
    await s.put("user", { id: "u_1", email: "ada@example.com" });
    await s.put("user", { id: "u_2", email: "grace@example.com" });

    await expect(
      s.update("user", "u_2", { email: "ada@example.com" }),
    ).rejects.toBeInstanceOf(UniqueConstraintError);
  });

  it("skips markers entirely when atomicUniqueness is off", async () => {
    const s = store(fake, { atomicUniqueness: false });
    await s.put("user", { id: "u_1", email: "ada@example.com" });
    await s.put("user", { id: "u_2", email: "ada@example.com" });

    expect(markers(fake)).toHaveLength(0);
    expect(
      fake.commands().every((c) => c.type !== "TransactWriteCommand"),
    ).toBe(true);
  });

  it("uses a plain conditional put for a model with no unique fields", async () => {
    const s = store(fake);
    await s.put("audit", { id: "a_1", userId: "u_1" });
    expect(fake.commands().at(-1)!.type).toBe("PutCommand");
  });
});

describe("create is create, not upsert", () => {
  it("refuses to overwrite an existing id", async () => {
    const fake = createFakeDynamo();
    const s = store(fake);
    await s.put("audit", { id: "a_1", userId: "u_1" });

    await expect(
      s.put("audit", { id: "a_1", userId: "u_2" }),
    ).rejects.toBeInstanceOf(DynamoDBAdapterError);
  });
});

describe("optimistic revision guard", () => {
  let fake: FakeDynamo;
  beforeEach(() => {
    fake = createFakeDynamo();
  });

  it("stamps a fresh revision on every write", async () => {
    const s = store(fake);
    await s.put("user", { id: "u_1", email: "ada@example.com" });
    const first = fake.rowsWithPrefix("E#")[0]![REVISION];

    await s.update("user", "u_1", { name: "Ada" });
    const second = fake.rowsWithPrefix("E#")[0]![REVISION];

    expect(first).toBeTruthy();
    expect(second).not.toBe(first);
  });

  it("hides the revision from returned data", async () => {
    const s = store(fake);
    await s.put("user", { id: "u_1", email: "ada@example.com" });
    expect(await s.getById("user", "u_1")).not.toHaveProperty(REVISION);
  });

  it("retries a lost race rather than failing the caller", async () => {
    const s = store(fake);
    await s.put("audit", { id: "a_1", userId: "u_1" });
    fake.failNextWrites(1);

    await expect(
      s.update("audit", "a_1", { note: "x" }),
    ).resolves.toMatchObject({ note: "x" });
  });

  it("gives up loudly once the retries are exhausted", async () => {
    const s = store(fake);
    await s.put("audit", { id: "a_1", userId: "u_1" });
    fake.failNextWrites(5);

    await expect(
      s.update("audit", "a_1", { note: "x" }),
    ).rejects.toBeInstanceOf(OptimisticLockError);
  });

  it("returns null when updating a row that does not exist", async () => {
    await expect(
      store(fake).update("user", "nope", { a: 1 }),
    ).resolves.toBeNull();
  });
});

describe("consumeOne", () => {
  let fake: FakeDynamo;
  beforeEach(() => {
    fake = createFakeDynamo();
  });

  it("returns the row it removed and clears its markers", async () => {
    const s = store(fake);
    await s.put("session", { id: "s_1", token: "tok" });

    await expect(s.consumeOne!("session", "s_1")).resolves.toMatchObject({
      id: "s_1",
    });
    expect(markers(fake)).toHaveLength(0);
    // Freed, so the same token can be issued again.
    await expect(
      s.put("session", { id: "s_2", token: "tok" }),
    ).resolves.toBeTruthy();
  });

  it("lets exactly one of two racing consumers win", async () => {
    const s = store(fake);
    await s.put("session", { id: "s_1", token: "tok" });

    // Both read the same revision; the second write finds the row gone.
    const [a, b] = await Promise.all([
      s.consumeOne!("session", "s_1"),
      s.consumeOne!("session", "s_1"),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it("takes the single-command path when there are no markers to move", async () => {
    const s = store(fake);
    await s.put("audit", { id: "a_1", userId: "u_1" });
    await s.consumeOne!("audit", "a_1");
    expect(fake.commands().at(-1)!.type).toBe("DeleteCommand");
  });

  it("returns null for a row that is already gone", async () => {
    await expect(
      store(fake).consumeOne!("session", "nope"),
    ).resolves.toBeNull();
  });
});

describe("incrementOne", () => {
  let fake: FakeDynamo;
  beforeEach(() => {
    fake = createFakeDynamo();
  });

  it("adds to an existing counter", async () => {
    const s = store(fake);
    await s.put("audit", { id: "a_1", userId: "u_1", count: 2 });

    await expect(
      s.incrementOne!("audit", "a_1", { increment: { count: 3 } }),
    ).resolves.toMatchObject({ count: 5 });
  });

  it("refuses to conjure the row it was told to increment", async () => {
    // Without a guard, DynamoDB's `ADD` would create the row from nothing,
    // turning "increment an existing counter" into an upsert.
    await expect(
      store(fake).incrementOne!("audit", "nope", { increment: { count: 1 } }),
    ).resolves.toBeNull();
  });

  it("re-encodes index keys when `set` moves an indexed field", async () => {
    const s = store(fake);
    await s.put("audit", { id: "a_1", userId: "u_1", count: 0 });
    await s.incrementOne!("audit", "a_1", {
      increment: { count: 1 },
      set: { userId: "u_2" },
    });

    // A native ADD cannot rewrite a GSI key, so this must have gone the
    // read-modify-write route — otherwise the by_userId index is now stale.
    expect(fake.commands().at(-1)!.type).toBe("TransactWriteCommand");
    expect(await s.getById("audit", "a_1")).toMatchObject({
      userId: "u_2",
      count: 1,
    });
  });

  it("treats a non-numeric counter as zero", async () => {
    const s = store(fake);
    await s.put("audit", { id: "a_1", userId: "u_1", count: "oops" });

    await expect(
      s.incrementOne!("audit", "a_1", { increment: { count: 2 } }),
    ).resolves.toMatchObject({ count: 2 });
  });
});

describe("TTL", () => {
  const ttl = { defaultField: "expiresAt" };
  const future = new Date(Date.now() + 60_000).toISOString();
  const past = new Date(Date.now() - 60_000).toISOString();

  it("projects the configured date field into an epoch-seconds attribute", async () => {
    const fake = createFakeDynamo();
    await store(fake, { ttl }).put("session", {
      id: "s_1",
      token: "tok",
      expiresAt: future,
    });

    const row = fake.rowsWithPrefix("E#")[0]!;
    expect(row.__ba_ttl).toBeCloseTo(Math.floor(Date.parse(future) / 1000), 0);
  });

  it("hides an expired row before DynamoDB gets round to reaping it", async () => {
    const fake = createFakeDynamo();
    const s = store(fake, { ttl });
    await s.put("session", { id: "s_1", token: "tok", expiresAt: past });

    // The row is physically present — AWS reaps lazily, often a day or two
    // late — so only logical expiry stops an expired session being usable.
    expect(fake.rowsWithPrefix("E#")).toHaveLength(1);
    expect(await s.getById("session", "s_1")).toBeNull();
  });

  it("keeps an unexpired row visible", async () => {
    const fake = createFakeDynamo();
    const s = store(fake, { ttl });
    await s.put("session", { id: "s_1", token: "tok", expiresAt: future });
    expect(await s.getById("session", "s_1")).toMatchObject({ id: "s_1" });
  });

  it("writes no TTL attribute when TTL is not configured", async () => {
    const fake = createFakeDynamo();
    await store(fake).put("session", {
      id: "s_1",
      token: "tok",
      expiresAt: past,
    });
    expect(fake.rowsWithPrefix("E#")[0]!.__ba_ttl).toBeUndefined();
  });
});

describe("transaction limits", () => {
  it("fails with a usable message rather than DynamoDB's 100-action error", async () => {
    // 100 unique fields on one model: entity + 100 markers = 101 actions.
    const wide: IndexMap = {
      wide: Array.from({ length: 100 }, (_, i) => ({
        index: `by_f${i}`,
        pk: [`f${i}`],
        unique: true,
      })),
    };
    const fake = createFakeDynamo();
    const s = createSingleTableStore({
      tableName: "t",
      indexMap: wide,
      documentClient: fake.client,
    });
    const row: Record<string, unknown> = { id: "w_1" };
    for (let i = 0; i < 100; i++) row[`f${i}`] = `v${i}`;

    await expect(s.put("wide", row)).rejects.toThrow(/100-action limit/);
  });
});
