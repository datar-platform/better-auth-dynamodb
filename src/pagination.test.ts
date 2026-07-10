import type { CleanedWhere } from "@better-auth/core/db/adapter";
import { describe, expect, it } from "vitest";

import {
  applySort,
  applyWindow,
  drainPages,
  matchesResidual,
} from "./pagination";

const w = (
  field: string,
  value: CleanedWhere["value"],
  operator: CleanedWhere["operator"] = "eq",
  connector: CleanedWhere["connector"] = "AND",
): CleanedWhere => ({ field, value, operator, connector });

describe("matchesResidual", () => {
  const item = { name: "Ada", age: 36, role: "admin", tags: ["x", "y"] };

  it("passes an empty residual", () => {
    expect(matchesResidual(item, [])).toBe(true);
  });

  it("evaluates each operator", () => {
    expect(matchesResidual(item, [w("age", 30, "gt")])).toBe(true);
    expect(matchesResidual(item, [w("age", 36, "gte")])).toBe(true);
    expect(matchesResidual(item, [w("age", 36, "lt")])).toBe(false);
    expect(matchesResidual(item, [w("role", "admin", "ne")])).toBe(false);
    expect(matchesResidual(item, [w("role", ["admin", "owner"], "in")])).toBe(
      true,
    );
    expect(matchesResidual(item, [w("role", ["owner"], "not_in")])).toBe(true);
    expect(matchesResidual(item, [w("name", "d", "contains")])).toBe(true);
    expect(matchesResidual(item, [w("name", "Ad", "starts_with")])).toBe(true);
    expect(matchesResidual(item, [w("name", "da", "ends_with")])).toBe(true);
  });

  it("requires all AND clauses", () => {
    expect(matchesResidual(item, [w("role", "admin"), w("age", 36)])).toBe(
      true,
    );
    expect(matchesResidual(item, [w("role", "admin"), w("age", 99)])).toBe(
      false,
    );
  });

  it("requires at least one OR clause when present", () => {
    const or = [w("role", "owner", "eq", "OR"), w("role", "admin", "eq", "OR")];
    expect(matchesResidual(item, or)).toBe(true);
    expect(
      matchesResidual(item, [
        w("role", "owner", "eq", "OR"),
        w("role", "guest", "eq", "OR"),
      ]),
    ).toBe(false);
  });

  it("combines AND and OR (all AND, then any OR)", () => {
    const clauses = [
      w("name", "Ada"),
      w("role", "owner", "eq", "OR"),
      w("role", "admin", "eq", "OR"),
    ];
    expect(matchesResidual(item, clauses)).toBe(true);
    expect(matchesResidual({ ...item, name: "Bob" }, clauses)).toBe(false);
  });
});

describe("applySort / applyWindow", () => {
  const rows = [{ n: 3 }, { n: 1 }, { n: 2 }];

  it("sorts ascending and descending", () => {
    expect(
      applySort(rows, { field: "n", direction: "asc" }).map((r) => r.n),
    ).toEqual([1, 2, 3]);
    expect(
      applySort(rows, { field: "n", direction: "desc" }).map((r) => r.n),
    ).toEqual([3, 2, 1]);
  });

  it("returns input unchanged with no sortBy", () => {
    expect(applySort(rows).map((r) => r.n)).toEqual([3, 1, 2]);
  });

  it("applies offset and limit (limit 0 means no cap)", () => {
    expect(applyWindow(rows, 1).map((r) => r.n)).toEqual([1, 2]);
    expect(applyWindow(rows, 0, 2).map((r) => r.n)).toEqual([3, 1]);
    expect(applyWindow(rows, 0, 0)).toHaveLength(3);
  });
});

describe("drainPages", () => {
  it("concatenates pages until the cursor is exhausted", async () => {
    const pages = [
      { items: [{ id: 1 }, { id: 2 }], cursor: "a" },
      { items: [{ id: 3 }], cursor: "b" },
      { items: [{ id: 4 }], cursor: undefined },
    ];
    let call = 0;
    const all = await drainPages(async () => pages[call++]!);
    expect(all.map((i) => i.id)).toEqual([1, 2, 3, 4]);
    expect(call).toBe(3);
  });
});
