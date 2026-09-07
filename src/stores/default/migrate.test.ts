import { beforeEach, describe, expect, it } from "vitest";

import {
  createFakeDynamo,
  type FakeDynamo,
} from "../../../test/support/fake-dynamo";
import type { IndexMap } from "../../index-map";
import { migrateKeys } from "./migrate";
import { createSingleTableStore } from "./single-table-store";

const indexMap: IndexMap = {
  user: [
    { index: "by_email", pk: ["email"], unique: true },
    { index: "by_orgId", pk: ["orgId"] },
  ],
  session: [{ index: "by_token", pk: ["token"], unique: true }],
};

/**
 * A row exactly as 0.1.x wrote it: keys joined on a bare `#`, no row-kind
 * prefix, no revision, and — the reason the migration exists at all — no
 * uniqueness marker anywhere in the table.
 */
const legacyRow = (model: string, item: Record<string, any>) => ({
  ...item,
  __ba_pk: `${model}#${item.id}`,
  __ba_sk: "#",
  __ba_tpk: model,
  __ba_tsk: `${item.createdAt ?? ""}#${item.id}`,
  __ba_g1pk: item.email
    ? `${model}#by_email#${item.email}`
    : item.token
      ? `${model}#by_token#${item.token}`
      : undefined,
  __ba_g1sk: `${item.id}`,
});

const store = (fake: FakeDynamo, overrides = {}) =>
  createSingleTableStore({
    tableName: "t",
    indexMap,
    documentClient: fake.client,
    ...overrides,
  });

const migrate = (fake: FakeDynamo, overrides = {}) =>
  migrateKeys({
    tableName: "t",
    indexMap,
    documentClient: fake.client,
    ...overrides,
  });

describe("migrateKeys", () => {
  let fake: FakeDynamo;
  beforeEach(() => {
    fake = createFakeDynamo();
  });

  it("does nothing to a table that was created on this version", async () => {
    const s = store(fake);
    await s.put("user", { id: "u_1", email: "ada@example.com" });

    const report = await migrate(fake);
    expect(report.noop).toBe(true);
    expect(report.migrated).toBe(0);
    // The row it already knew how to read is still readable.
    expect(await s.getById("user", "u_1")).toMatchObject({ id: "u_1" });
  });

  it("does nothing to an empty table", async () => {
    const report = await migrate(fake);
    expect(report).toMatchObject({ noop: true, scanned: 0, migrated: 0 });
  });

  it("makes a 0.1.x row readable again", async () => {
    fake.seed(legacyRow("user", { id: "u_1", email: "ada@example.com" }));
    const s = store(fake);

    // The whole problem in one assertion: the row is present, but the new key
    // format cannot find it.
    expect(await s.getById("user", "u_1")).toBeNull();

    const report = await migrate(fake);
    expect(report.migrated).toBe(1);
    expect(await s.getById("user", "u_1")).toMatchObject({
      id: "u_1",
      email: "ada@example.com",
    });
  });

  it("backfills the uniqueness markers 0.1.x never wrote", async () => {
    fake.seed(legacyRow("user", { id: "u_1", email: "ada@example.com" }));

    const report = await migrate(fake);
    expect(report.markersCreated).toBe(1);

    // Which means the migrated row is now actually protected, not just readable.
    await expect(
      store(fake).put("user", { id: "u_2", email: "ada@example.com" }),
    ).rejects.toThrow(/unique constraint/i);
  });

  it("leaves no duplicate of the old row behind", async () => {
    fake.seed(legacyRow("user", { id: "u_1", email: "ada@example.com" }));
    await migrate(fake);

    const entities = fake.rowsWithPrefix("E#");
    expect(entities).toHaveLength(1);
    expect(fake.rows().filter((r) => r.__ba_pk === "user#u_1")).toHaveLength(0);
  });

  it("drains every page of a table larger than one scan page", async () => {
    for (let i = 0; i < 7; i++) {
      fake.seed(
        legacyRow("user", { id: `u_${i}`, email: `u${i}@example.com` }),
      );
    }
    const report = await migrate(fake);
    expect(report.migrated).toBe(7);
    expect(fake.rowsWithPrefix("E#")).toHaveLength(7);
  });

  it("migrates several models in one pass", async () => {
    fake.seed(legacyRow("user", { id: "u_1", email: "ada@example.com" }));
    fake.seed(legacyRow("session", { id: "s_1", token: "tok" }));

    const report = await migrate(fake);
    expect(report.migrated).toBe(2);
    const s = store(fake);
    expect(await s.getById("session", "s_1")).toMatchObject({ token: "tok" });
  });

  it("is safe to run twice", async () => {
    fake.seed(legacyRow("user", { id: "u_1", email: "ada@example.com" }));
    await migrate(fake);
    const second = await migrate(fake);

    expect(second.noop).toBe(true);
    expect(fake.rowsWithPrefix("E#")).toHaveLength(1);
    expect(fake.rowsWithPrefix("U#")).toHaveLength(1);
  });

  it("refuses to run when two old rows claim the same unique value", async () => {
    // 0.1.x enforced uniqueness in Better Auth's application layer, which two
    // concurrent sign-ups could both pass. Choosing which one keeps the email
    // is not a migration's decision.
    fake.seed(legacyRow("user", { id: "u_1", email: "ada@example.com" }));
    fake.seed(legacyRow("user", { id: "u_2", email: "ada@example.com" }));

    const report = await migrate(fake);
    expect(report.migrated).toBe(0);
    expect(report.conflicts).toEqual([
      { model: "user", index: "by_email", ids: ["u_1", "u_2"] },
    ]);
    // And it stopped before touching anything.
    expect(fake.rowsWithPrefix("E#")).toHaveLength(0);
  });

  it("reports what a dry run would do without writing", async () => {
    fake.seed(legacyRow("user", { id: "u_1", email: "ada@example.com" }));

    const report = await migrate(fake, { dryRun: true });
    expect(report).toMatchObject({ migrated: 1, markersCreated: 1 });
    expect(fake.rowsWithPrefix("E#")).toHaveLength(0);
    expect(fake.rowsWithPrefix("U#")).toHaveLength(0);
  });

  it("surfaces a dry run's conflicts, so they are found before writing", async () => {
    fake.seed(legacyRow("user", { id: "u_1", email: "ada@example.com" }));
    fake.seed(legacyRow("user", { id: "u_2", email: "ada@example.com" }));

    const report = await migrate(fake, { dryRun: true });
    expect(report.conflicts).toHaveLength(1);
  });

  it("carries TTL onto migrated rows when configured", async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    fake.seed(legacyRow("session", { id: "s_1", token: "tok", expiresAt }));

    await migrate(fake, { ttl: { defaultField: "expiresAt" } });
    const row = fake.rowsWithPrefix("E#")[0]!;
    expect(row.__ba_ttl).toBeCloseTo(
      Math.floor(Date.parse(expiresAt) / 1000),
      0,
    );
  });

  it("skips marker backfill when uniqueness enforcement is off", async () => {
    fake.seed(legacyRow("user", { id: "u_1", email: "ada@example.com" }));

    const report = await migrate(fake, { atomicUniqueness: false });
    expect(report.migrated).toBe(1);
    expect(report.markersCreated).toBe(0);
  });

  it("needs a client to talk to", async () => {
    await expect(migrateKeys({ tableName: "t", indexMap })).rejects.toThrow(
      /documentClient/,
    );
  });
});
