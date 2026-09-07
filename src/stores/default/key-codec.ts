import { createHash } from "node:crypto";

import { DynamoDBAdapterError } from "../../errors";
import type { IndexMap } from "../../index-map";
import type { StoreItem } from "../../types";

/**
 * Physical key encoding for the built-in single-table store.
 *
 * All reserved attributes are namespaced under `__ba_` so they never collide
 * with Better Auth field names, and are stripped before items are returned. The
 * table has a `PK`/`SK` primary key, one `byType` GSI (to list a whole model),
 * and N generic lookup GSIs — one physical slot per logical index a model uses.
 *
 * ## Why keys are length-prefixed
 *
 * Every variable component of a key is written as `s<byteLength>:<value>`. A
 * naive `a#b#c` join lets a value containing the delimiter forge a different
 * key: with composite partition keys, `("a#b", "c")` and `("a", "b#c")` encode
 * identically, and a sort-key `begins_with("cred#")` probe matches a row whose
 * value is literally `cred#ential`. Length prefixes make that structurally
 * impossible — `s4:cred#` can never be a prefix of `s10:credential#` — so no
 * field value, whatever a provider or a user puts in it, can be made to collide
 * with or over-match another row's key.
 */
export const PK = "__ba_pk";
export const SK = "__ba_sk";
export const TYPE_PK = "__ba_tpk";
export const TYPE_SK = "__ba_tsk";
export const TYPE_INDEX = "byType";
/** Hidden per-row revision, used as the optimistic-write guard. */
export const REVISION = "__ba_rev";
/** Default DynamoDB TTL attribute (epoch seconds). Configurable per store. */
export const DEFAULT_TTL_ATTRIBUTE = "__ba_ttl";
const SK_CONST = "#";
const RESERVED_PREFIX = "__ba_";

/** Row-kind discriminators. Fixed literals, never derived from user data. */
const ENTITY_PREFIX = "E";
const LOOKUP_PREFIX = "L";
const UNIQUE_PREFIX = "U";

/** DynamoDB's own key size limits. */
const MAX_PARTITION_KEY_BYTES = 2048;
const MAX_SORT_KEY_BYTES = 1024;

/**
 * Byte budget for a single encoded field value before it is hashed instead.
 *
 * The threshold is fixed rather than derived from the assembled key, because a
 * value must encode identically no matter which key it lands in — otherwise a
 * write and its matching lookup would disagree.
 */
const MAX_VALUE_COMPONENT_BYTES = 256;

export const gsiName = (slot: number): string => `lookup${slot}`;
export const gsiPk = (slot: number): string => `__ba_g${slot}pk`;
export const gsiSk = (slot: number): string => `__ba_g${slot}sk`;

const byteLength = (value: string): number => Buffer.byteLength(value, "utf8");

/** `s<byteLength>:<value>` — the self-delimiting component encoding. */
const component = (value: string): string => `s${byteLength(value)}:${value}`;

/**
 * Type-tagged rendering of a field value, so `1`, `"1"`, and `true` cannot
 * share a key. Dates normalise to ISO-8601 so an equivalent `Date` and string
 * agree.
 */
export function encodeValue(value: unknown): string {
  if (value === null || value === undefined) return "null:";
  if (value instanceof Date) return `date:${value.toISOString()}`;
  switch (typeof value) {
    case "string":
      return `string:${value}`;
    case "number":
      return `number:${value}`;
    case "boolean":
      return `boolean:${value}`;
    case "bigint":
      return `bigint:${value}`;
    case "symbol":
      return `symbol:${value.description ?? ""}`;
    case "function":
      return "function:";
    default:
      // Objects have no meaningful key form; JSON at least keeps them distinct
      // rather than collapsing every one of them to "[object Object]".
      return `object:${JSON.stringify(value)}`;
  }
}

/**
 * Encode one field value as a key component, hashing it when it is too long to
 * sit in a DynamoDB key. `hs:` and `s<digits>:` are disjoint prefixes, so a
 * hashed component can never be confused with a literal one.
 */
function valueComponent(value: unknown): string {
  const typed = encodeValue(value);
  if (byteLength(typed) > MAX_VALUE_COMPONENT_BYTES) {
    return `hs:${createHash("sha256").update(typed).digest("hex")}`;
  }
  return component(typed);
}

const joinValues = (values: unknown[]): string =>
  values.map(valueComponent).join("#");

function checkedKey(
  value: string,
  label: string,
  maxBytes: number,
  keyType: "partition" | "sort",
): string {
  if (byteLength(value) <= maxBytes) return value;
  throw new DynamoDBAdapterError(
    `better-auth-dynamodb: ${label} exceeds DynamoDB's ${maxBytes}-byte ` +
      `${keyType} key limit. Field values are hashed past ` +
      `${MAX_VALUE_COMPONENT_BYTES} bytes, so this means the model name, ` +
      `index name, or record id is itself too long.`,
  );
}

const partitionKey = (value: string, label: string): string =>
  checkedKey(value, label, MAX_PARTITION_KEY_BYTES, "partition");

const sortKey = (value: string, label: string): string =>
  checkedKey(value, label, MAX_SORT_KEY_BYTES, "sort");

/** Physical slot assignment: model -> (logical index name -> GSI slot number). */
export interface SlotAssignment {
  slots: Record<string, Record<string, number>>;
  maxSlots: number;
}

/**
 * Assign each logical index to a physical GSI slot. Because indexes on
 * different models never coexist on one item, a model's Nth index always maps
 * to slot N — so the table needs only `max(indexes per model)` lookup GSIs.
 */
export function assignSlots(indexMap: IndexMap): SlotAssignment {
  const slots: Record<string, Record<string, number>> = {};
  let maxSlots = 0;
  for (const [model, patterns] of Object.entries(indexMap)) {
    const modelSlots: Record<string, number> = {};
    patterns.forEach((pattern, i) => {
      modelSlots[pattern.index] = i + 1;
    });
    slots[model] = modelSlots;
    maxSlots = Math.max(maxSlots, patterns.length);
  }
  return { slots, maxSlots };
}

export const primaryKey = (model: string, id: string) => ({
  [PK]: partitionKey(
    `${ENTITY_PREFIX}#${component(model)}#${component(id)}`,
    "entity partition key",
  ),
  [SK]: SK_CONST,
});

/**
 * One marker row per (model, unique index, value) tuple. Written in the same
 * transaction as the entity row with `attribute_not_exists`, which is what
 * makes uniqueness a property of the database rather than of Better Auth's
 * check-then-insert.
 */
export const uniqueMarkerKey = (
  model: string,
  index: string,
  values: unknown[],
) => ({
  [PK]: partitionKey(
    `${UNIQUE_PREFIX}#${component(model)}#${component(index)}#${joinValues(values)}`,
    "unique marker partition key",
  ),
  [SK]: SK_CONST,
});

const lookupPkValue = (model: string, index: string, values: unknown[]) =>
  partitionKey(
    `${LOOKUP_PREFIX}#${component(model)}#${component(index)}#${joinValues(values)}`,
    "lookup partition key",
  );

/**
 * Compute the reserved key attributes to store alongside an item: the primary
 * key, the type-index key, and a lookup key for every index whose partition
 * fields are all present on the item.
 */
export function encodeKeys(
  model: string,
  item: StoreItem,
  indexMap: IndexMap,
  assignment: SlotAssignment,
): StoreItem {
  const id = String(item.id);
  const keys: StoreItem = {
    ...primaryKey(model, id),
    [TYPE_PK]: model,
    // Deliberately *not* length-prefixed: this sort key exists to order a
    // model's rows by creation time, and a byte-length prefix would sort
    // lexicographically by length instead of chronologically. It is never used
    // for `begins_with` lookups, so it carries no collision risk.
    [TYPE_SK]: sortKey(
      `${String(item.createdAt ?? "")}#${id}`,
      "type sort key",
    ),
  };

  for (const pattern of indexMap[model] ?? []) {
    const pkValues = pattern.pk.map((f) => item[f]);
    if (pkValues.some((v) => v == null)) continue; // index doesn't apply to this row
    const slot = assignment.slots[model]?.[pattern.index];
    if (!slot) continue;
    keys[gsiPk(slot)] = lookupPkValue(model, pattern.index, pkValues);
    const skValues = (pattern.sk ?? []).map((f) => item[f]);
    keys[gsiSk(slot)] = sortKey(
      skValues.some((v) => v == null)
        ? component(id)
        : `${joinValues(skValues)}#${component(id)}`,
      "lookup sort key",
    );
  }

  return keys;
}

/** A resolved lookup query against one GSI slot. */
export interface LookupQuery {
  indexName: string;
  pkAttr: string;
  pkValue: string;
  skAttr: string;
  /** When set, narrow with `begins_with(skAttr, skPrefix)`. */
  skPrefix?: string;
}

/**
 * Translate a logical index query into a concrete GSI query. Uses the
 * partition key always, and a `begins_with` sort-key prefix when the caller
 * supplied any leading sort-key field values.
 */
export function encodeLookupQuery(
  model: string,
  index: string,
  key: StoreItem,
  indexMap: IndexMap,
  assignment: SlotAssignment,
): LookupQuery {
  const slot = assignment.slots[model]?.[index];
  if (!slot) {
    throw new DynamoDBAdapterError(
      `No physical slot for index "${index}" on model "${model}". ` +
        `Ensure the index is present in the adapter's index map.`,
    );
  }
  const pattern = (indexMap[model] ?? []).find((p) => p.index === index)!;
  const pkValues = pattern.pk.map((f) => key[f]);
  const skPresent = (pattern.sk ?? [])
    .map((f) => key[f])
    .filter((v) => v != null);

  return {
    indexName: gsiName(slot),
    pkAttr: gsiPk(slot),
    pkValue: lookupPkValue(model, index, pkValues),
    skAttr: gsiSk(slot),
    skPrefix: skPresent.length > 0 ? `${joinValues(skPresent)}#` : undefined,
  };
}

/** Remove all reserved (`__ba_`) attributes, yielding clean Better Auth data. */
export function stripReserved(
  item: StoreItem | undefined | null,
): StoreItem | null {
  if (!item) return null;
  const clean: StoreItem = {};
  for (const [k, v] of Object.entries(item)) {
    if (!k.startsWith(RESERVED_PREFIX)) clean[k] = v;
  }
  return clean;
}
