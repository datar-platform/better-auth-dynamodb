import type { CleanedWhere } from "@better-auth/core/db/adapter";
import { describe, expect, it } from "vitest";

import type { IndexMap } from "./index-map";
import { planQuery } from "./planner";

/** Build a CleanedWhere with sensible defaults. */
const w = (
  field: string,
  value: CleanedWhere["value"],
  operator: CleanedWhere["operator"] = "eq",
  connector: CleanedWhere["connector"] = "AND",
): CleanedWhere => ({ field, value, operator, connector, mode: "sensitive" });

// A representative access-pattern map: partial keys, sort-key prefixes, order.
const indexMap: IndexMap = {
  user: [{ index: "byEmail", pk: ["email"] }],
  account: [
    { index: "byUser", pk: ["userId"], sk: ["providerId"] },
    { index: "byAccountId", pk: ["accountId"], sk: ["providerId"] },
  ],
  member: [
    { index: "byOrganization", pk: ["organizationId"], sk: ["userId"] },
    { index: "byUser", pk: ["userId"], sk: ["organizationId"] },
  ],
  role: [{ index: "bySlug", pk: ["slug"], sk: ["organizationId"] }],
};

describe("planQuery", () => {
  it("prefers a direct id lookup over any index", () => {
    const plan = planQuery(
      "user",
      [w("id", "u_1"), w("email", "a@b.co")],
      indexMap,
    );
    expect(plan).toMatchObject({ kind: "byId", id: "u_1" });
    // The non-id clause is left to residual filtering.
    expect(plan.residual.map((r) => r.field)).toEqual(["email"]);
  });

  it("selects a single-field index and leaves nothing residual", () => {
    const plan = planQuery("user", [w("email", "a@b.co")], indexMap);
    expect(plan).toMatchObject({
      kind: "index",
      index: "byEmail",
      key: { email: "a@b.co" },
      residual: [],
    });
  });

  it("attaches a sort-key field when present (account by user + provider)", () => {
    const plan = planQuery(
      "account",
      [w("userId", "u_1"), w("providerId", "credential")],
      indexMap,
    );
    expect(plan).toMatchObject({
      kind: "index",
      index: "byUser",
      key: { userId: "u_1", providerId: "credential" },
      residual: [],
    });
  });

  it("uses only the partition key when the sort-key field is absent", () => {
    const plan = planQuery("account", [w("userId", "u_1")], indexMap);
    expect(plan).toMatchObject({
      kind: "index",
      index: "byUser",
      key: { userId: "u_1" },
    });
    expect((plan as any).key.providerId).toBeUndefined();
  });

  it("falls through to a later pattern when the first pk is absent", () => {
    const plan = planQuery(
      "account",
      [w("accountId", "acc_1"), w("providerId", "google")],
      indexMap,
    );
    expect(plan).toMatchObject({ kind: "index", index: "byAccountId" });
  });

  it("takes the first matching pattern in declaration order (member org wins)", () => {
    const plan = planQuery(
      "member",
      [w("organizationId", "org_1"), w("userId", "u_1")],
      indexMap,
    );
    expect(plan).toMatchObject({
      kind: "index",
      index: "byOrganization",
      key: { organizationId: "org_1", userId: "u_1" },
    });
  });

  it("keeps non-eq clauses as residual even when an index matches", () => {
    const plan = planQuery(
      "role",
      [w("slug", "admin"), w("organizationId", "org_1", "ne")],
      indexMap,
    );
    expect(plan).toMatchObject({
      kind: "index",
      index: "bySlug",
      key: { slug: "admin" },
    });
    expect(plan.residual.map((r) => r.operator)).toEqual(["ne"]);
  });

  it("does not use an index for OR-connected clauses", () => {
    const plan = planQuery(
      "user",
      [w("email", "a@b.co", "eq", "OR")],
      indexMap,
    );
    expect(plan.kind).toBe("listByType");
    expect(plan.residual).toHaveLength(1);
  });

  it("plans `id in [...]` as a bounded set of primary-key gets", () => {
    // Better Auth batch-loads rows it already has ids for (an organisation's
    // members, say). That is a multi-get, not a scan, and must not be one.
    const plan = planQuery("user", [w("id", ["u_1", "u_2"], "in")], indexMap);
    expect(plan).toMatchObject({ kind: "byIds", ids: ["u_1", "u_2"] });
    expect(plan.residual).toHaveLength(0);
  });

  it("keeps other predicates residual alongside an `id in`", () => {
    const plan = planQuery(
      "user",
      [w("id", ["u_1"], "in"), w("banned", true)],
      indexMap,
    );
    expect(plan.kind).toBe("byIds");
    expect(plan.residual).toHaveLength(1);
  });

  it("refuses to serve a case-insensitive equality from an index", () => {
    // DynamoDB compares keys byte-for-byte, so an index lookup would silently
    // miss every row whose casing differs. The clause stays residual instead.
    const plan = planQuery(
      "user",
      [{ ...w("email", "ADA@EXAMPLE.COM"), mode: "insensitive" }],
      indexMap,
    );
    expect(plan.kind).toBe("listByType");
    expect(plan.residual).toHaveLength(1);
  });

  it("falls back to listByType when nothing matches", () => {
    const plan = planQuery("user", [w("name", "Ada")], indexMap);
    expect(plan).toMatchObject({ kind: "listByType" });
    expect(plan.residual).toHaveLength(1);
  });
});
