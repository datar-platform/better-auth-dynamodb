import type { BetterAuthDBSchema } from "@better-auth/core/db";
import { describe, expect, it } from "vitest";

import type { IndexMap } from "../../index-map";
import { deriveIndexMap } from "./derive-index-map";
import {
  assignSlots,
  encodeKeys,
  encodeLookupQuery,
  gsiName,
  gsiPk,
  gsiSk,
  primaryKey,
  stripReserved,
  TYPE_PK,
} from "./key-codec";
import { buildTableDefinition } from "./schema";

const indexMap: IndexMap = {
  user: [{ index: "byEmail", pk: ["email"] }],
  account: [
    { index: "byUser", pk: ["userId"], sk: ["providerId"] },
    { index: "byAccountId", pk: ["accountId"], sk: ["providerId"] },
  ],
};

describe("assignSlots", () => {
  it("assigns each model's indexes to slots 1..n and reports the max", () => {
    const { slots, maxSlots } = assignSlots(indexMap);
    expect(slots.user).toEqual({ byEmail: 1 });
    expect(slots.account).toEqual({ byUser: 1, byAccountId: 2 });
    expect(maxSlots).toBe(2);
  });
});

describe("encodeKeys", () => {
  const assignment = assignSlots(indexMap);

  it("writes primary, type, and applicable lookup keys", () => {
    const keys = encodeKeys(
      "account",
      {
        id: "a_1",
        userId: "u_1",
        accountId: "acc_1",
        providerId: "credential",
        createdAt: "2026",
      },
      indexMap,
      assignment,
    );
    expect(keys).toMatchObject(primaryKey("account", "a_1"));
    expect(keys[TYPE_PK]).toBe("account");
    expect(keys[gsiPk(1)]).toBe("account#byUser#u_1");
    expect(keys[gsiSk(1)]).toBe("credential#a_1");
    expect(keys[gsiPk(2)]).toBe("account#byAccountId#acc_1");
  });

  it("skips a lookup index when a partition field is missing", () => {
    const keys = encodeKeys("user", { id: "u_1" }, indexMap, assignment);
    expect(keys[gsiPk(1)]).toBeUndefined(); // no email -> no byEmail key
  });
});

describe("encodeLookupQuery", () => {
  const assignment = assignSlots(indexMap);

  it("builds a partition-only query when no sort field is given", () => {
    const q = encodeLookupQuery(
      "account",
      "byUser",
      { userId: "u_1" },
      indexMap,
      assignment,
    );
    expect(q).toMatchObject({
      indexName: gsiName(1),
      pkAttr: gsiPk(1),
      pkValue: "account#byUser#u_1",
    });
    expect(q.skPrefix).toBeUndefined();
  });

  it("adds a begins_with sort prefix when a sort field is present", () => {
    const q = encodeLookupQuery(
      "account",
      "byUser",
      { userId: "u_1", providerId: "credential" },
      indexMap,
      assignment,
    );
    expect(q.skPrefix).toBe("credential#");
  });
});

describe("stripReserved", () => {
  it("removes __ba_ attributes and returns null for nullish input", () => {
    expect(stripReserved({ id: "x", __ba_pk: "p", name: "Ada" })).toEqual({
      id: "x",
      name: "Ada",
    });
    expect(stripReserved(null)).toBeNull();
  });
});

describe("deriveIndexMap", () => {
  const schema: BetterAuthDBSchema = {
    user: {
      modelName: "user",
      fields: {
        email: { type: "string", unique: true },
        name: { type: "string" },
      },
    },
    account: {
      modelName: "account",
      fields: {
        userId: { type: "string", references: { model: "user", field: "id" } },
        providerId: { type: "string" },
      },
    },
    twoFactor: {
      modelName: "twoFactor",
      fields: {
        secret: { type: "string", index: true },
      },
    },
  };

  it("derives lookup indexes from unique, references, and index fields", () => {
    const map = deriveIndexMap(schema);
    expect(map.user).toEqual([{ index: "by_email", pk: ["email"] }]);
    expect(map.account).toEqual([{ index: "by_userId", pk: ["userId"] }]);
    // An unknown plugin model gets an index too — works out of the box.
    expect(map.twoFactor).toEqual([{ index: "by_secret", pk: ["secret"] }]);
  });
});

describe("buildTableDefinition", () => {
  it("provisions PK/SK + byType + one GSI per lookup slot", () => {
    const def = buildTableDefinition("auth", 2);
    const gsiNames = (def.GlobalSecondaryIndexes ?? []).map((g) => g.IndexName);
    expect(gsiNames).toEqual(["byType", gsiName(1), gsiName(2)]);
    expect(def.TableName).toBe("auth");
    expect(def.BillingMode).toBe("PAY_PER_REQUEST");
  });
});
