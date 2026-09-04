import type { DBAdapterDebugLogOption } from "@better-auth/core/db/adapter";

import type { IndexMap } from "./index-map";

/** A single record as stored/returned. Better Auth handles field-level typing. */
export type StoreItem = Record<string, any>;

/** One page of a paginated query. `cursor` is opaque and store-defined. */
export interface QueryPage {
  items: StoreItem[];
  cursor?: unknown;
}

/**
 * The storage seam. A `DynamoStore` knows how to persist and query records for
 * a given model; it owns all physical key encoding. The generic adapter core
 * drives it purely through logical index names + field values, so any store —
 * the built-in single-table store or a custom one — plugs in the same way.
 *
 * Implementations should return the full item (including generated fields) from
 * `put`/`update` so the adapter can hand it back to Better Auth.
 */
export interface DynamoStore {
  /** Persist a new record and return it (with any store-generated fields). */
  put(model: string, item: StoreItem): Promise<StoreItem>;

  /** Fetch a single record by its primary `id`, or `null` if absent. */
  getById(model: string, id: string): Promise<StoreItem | null>;

  /** Patch the named fields on the record with the given `id` and return the new item. */
  update(
    model: string,
    id: string,
    patch: StoreItem,
  ): Promise<StoreItem | null>;

  /** Delete the record with the given `id`. No-op if it does not exist. */
  deleteById(model: string, id: string): Promise<void>;

  /**
   * Query a logical index. `key` holds the partition-key field values plus any
   * leading sort-key field values the caller resolved. Returns one page; the
   * core drains pages via `cursor` until exhausted.
   */
  queryIndex(req: {
    model: string;
    index: string;
    key: StoreItem;
    limit?: number;
    cursor?: unknown;
  }): Promise<QueryPage>;

  /**
   * List every record of a model (the substitute for a full table scan when no
   * index matches a query). Returns one page; the core drains via `cursor`.
   */
  listByType(req: {
    model: string;
    limit?: number;
    cursor?: unknown;
  }): Promise<QueryPage>;

  /**
   * Optional fast count. Only used by the core when the query has no residual
   * (in-memory) predicates. Return `null` to signal "no fast path, fall back to
   * draining + counting".
   */
  count?(req: {
    model: string;
    index?: string;
    key?: StoreItem;
  }): Promise<number | null>;

  /**
   * Optional atomic single-use consume: delete the record with the given `id`
   * and return what was deleted (or `null` if it was already gone), in one
   * operation. Better Auth's email-OTP/verification-token flows require this
   * for correctness under concurrent verify attempts. When a store doesn't
   * provide it, the adapter falls back to a non-atomic get-then-delete.
   */
  consumeOne?(model: string, id: string): Promise<StoreItem | null>;

  /**
   * Optional atomic increment/set: apply `increment` (field -> delta) and
   * `set` (field -> value) to the record with the given `id` in one operation
   * and return the updated record (or `null` if it doesn't exist). Better
   * Auth's guarded-counter flows (e.g. rate-limit style attempt counters)
   * require this for correctness under concurrent updates. When a store
   * doesn't provide it, the adapter falls back to a non-atomic
   * get-then-merge-then-update.
   */
  incrementOne?(
    model: string,
    id: string,
    req: { increment: Record<string, number>; set?: StoreItem },
  ): Promise<StoreItem | null>;

  /**
   * Optional schema generator, wired to the Better Auth CLI `generate` command.
   * The built-in store emits a portable CloudFormation template; a custom store
   * may emit whatever provisioning artifact fits its physical layout.
   */
  createSchema?(opts: {
    file?: string;
    tables: unknown;
  }): Promise<{ code: string; path: string; overwrite?: boolean }>;
}

/**
 * Public configuration for {@link dynamoAdapter}.
 *
 * Omit `store` to use the built-in single-table store (needs `tableName`).
 * Omit `indexMap` to auto-derive access patterns from the Better Auth schema
 * (`unique` fields -> lookup indexes, `references` fields -> by-parent indexes).
 */
export interface DynamoAdapterConfig {
  /** Storage backend. Defaults to the built-in single-table store. */
  store?: DynamoStore;
  /** Access-pattern map. Defaults to schema-derived patterns. */
  indexMap?: IndexMap;
  /** DynamoDB table name (used only by the built-in store). */
  tableName?: string;
  /** AWS region (used only by the built-in store). */
  region?: string;
  /**
   * Override the DynamoDB endpoint (used only by the built-in store). Point this
   * at DynamoDB Local or LocalStack, e.g. `http://localhost:4566`.
   */
  endpoint?: string;
  /** Better Auth debug logging, forwarded to the adapter factory. */
  debugLogs?: DBAdapterDebugLogOption;
}
