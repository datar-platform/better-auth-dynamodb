import type { IndexMap } from "../../index-map";
import type { StoreItem } from "../../types";

/**
 * Physical key encoding for the built-in single-table store.
 *
 * All reserved attributes are namespaced under `__ba_` so they never collide
 * with Better Auth field names, and are stripped before items are returned. The
 * table has a `PK`/`SK` primary key, one `byType` GSI (to list a whole model),
 * and N generic lookup GSIs — one physical slot per logical index a model uses.
 */
export const PK = "__ba_pk";
export const SK = "__ba_sk";
export const TYPE_PK = "__ba_tpk";
export const TYPE_SK = "__ba_tsk";
export const TYPE_INDEX = "byType";
const SK_CONST = "#";
const RESERVED_PREFIX = "__ba_";

export const gsiName = (slot: number): string => `lookup${slot}`;
export const gsiPk = (slot: number): string => `__ba_g${slot}pk`;
export const gsiSk = (slot: number): string => `__ba_g${slot}sk`;

const enc = (v: unknown): string => String(v);
const joinValues = (values: unknown[]): string => values.map(enc).join("#");

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
  [PK]: `${model}#${id}`,
  [SK]: SK_CONST,
});

const lookupPkValue = (model: string, index: string, values: unknown[]) =>
  `${model}#${index}#${joinValues(values)}`;

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
    [TYPE_SK]: `${enc(item.createdAt ?? "")}#${id}`,
  };

  for (const pattern of indexMap[model] ?? []) {
    const pkValues = pattern.pk.map((f) => item[f]);
    if (pkValues.some((v) => v == null)) continue; // index doesn't apply to this row
    const slot = assignment.slots[model]?.[pattern.index];
    if (!slot) continue;
    keys[gsiPk(slot)] = lookupPkValue(model, pattern.index, pkValues);
    const skValues = (pattern.sk ?? []).map((f) => item[f]);
    keys[gsiSk(slot)] = skValues.some((v) => v == null)
      ? `${id}`
      : `${joinValues(skValues)}#${id}`;
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
    throw new Error(
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
