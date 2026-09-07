import { describe, expect, it } from "vitest";

import {
  isConditionalCheckFailed,
  isConditionalTransactionCanceled,
  isTransactionCanceled,
  isTransactionConflict,
  transactionCancellationCodes,
} from "./errors";

/**
 * DynamoDB reports "your condition failed", "another writer got there first",
 * and "I am too busy" as the same exception class. Only the cancellation codes
 * tell them apart — and conflating them is how an adapter ends up telling a
 * user their email is taken when the table was merely throttled.
 */
const cancelled = (...codes: string[]) =>
  Object.assign(new Error("Transaction cancelled"), {
    name: "TransactionCanceledException",
    CancellationReasons: codes.map((Code) => ({ Code })),
  });

describe("transaction cancellation classification", () => {
  it("reads the per-action codes", () => {
    expect(
      transactionCancellationCodes(cancelled("None", "ThrottlingError")),
    ).toEqual(["None", "ThrottlingError"]);
  });

  it("identifies a genuine condition failure", () => {
    expect(
      isConditionalTransactionCanceled(
        cancelled("None", "ConditionalCheckFailed"),
      ),
    ).toBe(true);
  });

  it("does not mistake throttling for a condition failure", () => {
    expect(isConditionalTransactionCanceled(cancelled("ThrottlingError"))).toBe(
      false,
    );
    expect(isConditionalTransactionCanceled(cancelled("ValidationError"))).toBe(
      false,
    );
    expect(
      isConditionalTransactionCanceled(cancelled("TransactionConflict")),
    ).toBe(false);
  });

  it("identifies item contention separately, because it is worth retrying", () => {
    expect(isTransactionConflict(cancelled("TransactionConflict"))).toBe(true);
    expect(isTransactionConflict(cancelled("ConditionalCheckFailed"))).toBe(
      false,
    );
  });

  it("recognises the exception class regardless of reason", () => {
    expect(isTransactionCanceled(cancelled("ThrottlingError"))).toBe(true);
  });

  it("handles errors carrying no cancellation reasons at all", () => {
    const bare = Object.assign(new Error("x"), {
      name: "TransactionCanceledException",
    });
    expect(transactionCancellationCodes(bare)).toEqual([]);
    expect(isConditionalTransactionCanceled(bare)).toBe(false);
  });

  it("ignores unrelated values", () => {
    for (const value of [null, undefined, "boom", new Error("plain"), {}]) {
      expect(isTransactionCanceled(value)).toBe(false);
      expect(isConditionalCheckFailed(value)).toBe(false);
      expect(transactionCancellationCodes(value)).toEqual([]);
    }
  });

  it("identifies a non-transactional conditional failure", () => {
    expect(
      isConditionalCheckFailed(
        Object.assign(new Error("x"), {
          name: "ConditionalCheckFailedException",
        }),
      ),
    ).toBe(true);
  });
});
