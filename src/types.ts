import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
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
 * Adapter-managed DynamoDB TTL.
 *
 * A configured date field (e.g. `session.expiresAt`) is projected into a
 * numeric epoch-seconds attribute that DynamoDB's own TTL reaper understands,
 * so expired auth rows are deleted for free instead of accumulating.
 *
 * Reads treat the same attribute as *logical* expiry. DynamoDB reaps lazily —
 * often a day or two late — so without that, an expired session would keep
 * working until AWS got round to deleting it.
 */
export interface TtlOptions {
  /** DynamoDB TTL attribute to write. Defaults to `__ba_ttl`. */
  attributeName?: string;
  /** Per-model date field, e.g. `{ session: "expiresAt" }`. */
  fields?: Record<string, string>;
  /** Date field used for any model not named in `fields`, e.g. `"expiresAt"`. */
  defaultField?: string;
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
  /**
   * Pre-built DynamoDB document client (used only by the built-in store).
   * Preferred in production: your application keeps ownership of credentials,
   * region, middleware, tracing, and marshalling behaviour.
   */
  documentClient?: DynamoDBDocumentClient;
  /**
   * Enforce `unique` schema fields with transactional marker rows (used only
   * by the built-in store). Default `true`.
   */
  atomicUniqueness?: boolean;
  /**
   * Maximum DynamoDB pages drained for one logical query. Default 25. When a
   * query still has pages left at the cap, the adapter throws rather than
   * returning a silently truncated result — a partial answer to an auth query
   * is worse than a loud failure.
   */
  maxPages?: number;
  /**
   * Per-request DynamoDB `Limit` (used only by the built-in store). Pagination
   * is still drained up to `maxPages`, so this changes request sizing only.
   */
  pageSize?: number;
  /** Adapter-managed DynamoDB TTL. Omit (or `false`) to disable entirely. */
  ttl?: TtlOptions | false;
  /**
   * Allow queries that no index can serve, which fall back to draining every
   * row of the model and filtering in memory. Default `false`, so an access
   * pattern nobody designed for fails at development time instead of quietly
   * costing a full model read on every call.
   *
   * Native `count` is unaffected: it is a keyed `Select: COUNT` query, bounded
   * by `maxPages`, and returns a number rather than every row.
   */
  unsafeAllowScan?: boolean;
  /** Better Auth debug logging, forwarded to the adapter factory. */
  debugLogs?: DBAdapterDebugLogOption;
}
