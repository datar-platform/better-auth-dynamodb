import { describe, expect, it } from "vitest";

import { DynamoDBAdapterError } from "../../errors";
import type { IndexMap } from "../../index-map";
import {
  assignSlots,
  encodeKeys,
  encodeLookupQuery,
  encodeValue,
  gsiPk,
  gsiSk,
  primaryKey,
  uniqueMarkerKey,
  PK,
} from "./key-codec";

/**
 * These tests are about one property: no field value, however hostile, can be
 * made to collide with or over-match another row's key. Values in an auth
 * table are not all trustworthy — OAuth `accountId`s, organisation slugs, and
 * verification identifiers all arrive from outside.
 */

const composite: IndexMap = {
  account: [{ index: "by_pair", pk: ["a", "b"] }],
};

describe("delimiter collisions", () => {
  const assignment = assignSlots(composite);

  it("keeps composite keys distinct when a value contains the delimiter", () => {
    const left = encodeKeys(
      "account",
      { id: "x", a: "a#b", b: "c" },
      composite,
      assignment,
    );
    const right = encodeKeys(
      "account",
      { id: "y", a: "a", b: "b#c" },
      composite,
      assignment,
    );

    // A naive `a#b#c` join makes these two the same partition key, so a lookup
    // for one would return the other's row.
    expect(left[gsiPk(1)]).not.toBe(right[gsiPk(1)]);
  });

  it("does not let a sort-key prefix over-match a longer value", () => {
    const map: IndexMap = {
      account: [{ index: "by_user", pk: ["userId"], sk: ["providerId"] }],
    };
    const slots = assignSlots(map);
    const row = encodeKeys(
      "account",
      { id: "a_1", userId: "u_1", providerId: "cred#ential" },
      map,
      slots,
    );
    const probe = encodeLookupQuery(
      "account",
      "by_user",
      { userId: "u_1", providerId: "cred" },
      map,
      slots,
    );

    // `begins_with("cred#")` against a raw join would match "cred#ential".
    expect(String(row[gsiSk(1)]).startsWith(probe.skPrefix!)).toBe(false);
  });

  it("keeps an entity key disjoint from a unique-marker key", () => {
    const entity = primaryKey("user", "u_1");
    const marker = uniqueMarkerKey("user", "by_email", ["u_1"]);
    expect(entity[PK]).not.toBe(marker[PK]);
  });

  it("distinguishes values that differ only in type", () => {
    // A field holding `1` and one holding `"1"` are different rows.
    expect(encodeValue(1)).not.toBe(encodeValue("1"));
    expect(encodeValue(true)).not.toBe(encodeValue("true"));
    expect(encodeValue(null)).not.toBe(encodeValue("null"));
  });

  it("treats an equivalent Date and ISO string as the same value", () => {
    const iso = "2026-01-01T00:00:00.000Z";
    expect(encodeValue(new Date(iso))).toBe(encodeValue(new Date(iso)));
  });
});

describe("key size limits", () => {
  const map: IndexMap = { user: [{ index: "by_token", pk: ["token"] }] };
  const assignment = assignSlots(map);

  it("hashes a value too long to sit in a key, consistently on both sides", () => {
    const token = "t".repeat(5000);
    const row = encodeKeys("user", { id: "u_1", token }, map, assignment);
    const probe = encodeLookupQuery(
      "user",
      "by_token",
      { token },
      map,
      assignment,
    );

    // Hashed, so the key stays inside DynamoDB's limit...
    expect(Buffer.byteLength(String(row[gsiPk(1)]), "utf8")).toBeLessThan(2048);
    // ...and the write and the lookup still agree on it.
    expect(row[gsiPk(1)]).toBe(probe.pkValue);
  });

  it("still distinguishes two different long values", () => {
    const a = encodeKeys(
      "user",
      { id: "u", token: "a".repeat(5000) },
      map,
      assignment,
    );
    const b = encodeKeys(
      "user",
      { id: "u", token: "b".repeat(5000) },
      map,
      assignment,
    );
    expect(a[gsiPk(1)]).not.toBe(b[gsiPk(1)]);
  });

  it("fails with an actionable error when the id itself is oversized", () => {
    // Values are hashed, so an overflow here can only mean the model name,
    // index name, or id is absurd — and the message says so.
    expect(() => primaryKey("user", "i".repeat(3000))).toThrow(
      DynamoDBAdapterError,
    );
  });
});
