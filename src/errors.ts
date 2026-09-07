/**
 * Error types raised by this adapter.
 *
 * Everything thrown from the adapter core or the built-in store derives from
 * {@link DynamoDBAdapterError}, so a consumer can distinguish "the adapter
 * refused/failed" from a raw AWS SDK error escaping the seam.
 */
export class DynamoDBAdapterError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DynamoDBAdapterError";
  }
}

/**
 * A write lost a race against a uniqueness constraint — another row already
 * holds the value for a `unique` field (e.g. `user.email`, `organization.slug`).
 */
export class UniqueConstraintError extends DynamoDBAdapterError {
  constructor(
    readonly model: string,
    readonly fields: string[],
    options?: ErrorOptions,
  ) {
    super(
      `better-auth-dynamodb: unique constraint violation on "${model}" ` +
        `(duplicate value for ${fields.join(", ")})`,
      options,
    );
    this.name = "UniqueConstraintError";
  }
}

/**
 * The requested access pattern cannot be served without a table/model scan, and
 * scans have not been explicitly enabled.
 */
export class UnsupportedQueryError extends DynamoDBAdapterError {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedQueryError";
  }
}

/**
 * A guarded write was rejected because the row changed between the adapter's
 * read and its write. Better Auth's own retry/null semantics decide what
 * happens next; this exists so the cause is legible rather than an opaque
 * `TransactionCanceledException`.
 */
export class OptimisticLockError extends DynamoDBAdapterError {
  constructor(model: string, id: string, options?: ErrorOptions) {
    super(
      `better-auth-dynamodb: concurrent modification of "${model}" row "${id}" ` +
        `— the record changed between read and write`,
      options,
    );
    this.name = "OptimisticLockError";
  }
}

const named = (error: unknown, name: string): boolean =>
  typeof error === "object" &&
  error !== null &&
  "name" in error &&
  (error as { name?: unknown }).name === name;

/** True for a bare `ConditionalCheckFailedException` from a non-transactional write. */
export const isConditionalCheckFailed = (error: unknown): boolean =>
  named(error, "ConditionalCheckFailedException");

/** True for any cancelled `TransactWriteItems`, whatever the reason. */
export const isTransactionCanceled = (error: unknown): boolean =>
  named(error, "TransactionCanceledException");

/**
 * The per-action cancellation codes AWS attaches to a cancelled transaction
 * (e.g. `ConditionalCheckFailed`, `TransactionConflict`, `ThrottlingError`,
 * `ValidationError`, or `None` for actions that were fine).
 */
export function transactionCancellationCodes(error: unknown): string[] {
  if (
    typeof error !== "object" ||
    error === null ||
    !("CancellationReasons" in error)
  ) {
    return [];
  }
  const reasons = (error as { CancellationReasons?: unknown })
    .CancellationReasons;
  if (!Array.isArray(reasons)) return [];
  return reasons
    .map((reason) =>
      typeof reason === "object" && reason !== null && "Code" in reason
        ? (reason as { Code?: unknown }).Code
        : undefined,
    )
    .filter((code): code is string => typeof code === "string");
}

/**
 * True only when a transaction was cancelled *because a condition failed* —
 * not because of throttling, a transaction conflict, or a validation error.
 *
 * This distinction matters: reporting a throttled write as "email already
 * taken" is a user-visible lie, and it is the failure mode of any code that
 * treats `TransactionCanceledException` as a uniqueness violation wholesale.
 */
export const isConditionalTransactionCanceled = (error: unknown): boolean =>
  isTransactionCanceled(error) &&
  transactionCancellationCodes(error).includes("ConditionalCheckFailed");

/**
 * True when a transaction was cancelled because another transaction was
 * touching the same item. Transient contention, not a decision about the data —
 * so the right response is to try again, not to give up.
 */
export const isTransactionConflict = (error: unknown): boolean =>
  isTransactionCanceled(error) &&
  transactionCancellationCodes(error).includes("TransactionConflict");
