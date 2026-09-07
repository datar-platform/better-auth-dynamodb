import { randomUUID } from "node:crypto";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

import {
  DynamoDBAdapterError,
  isConditionalCheckFailed,
  isConditionalTransactionCanceled,
  isTransactionConflict,
  OptimisticLockError,
  UniqueConstraintError,
} from "../../errors";
import type { AccessPattern, IndexMap } from "../../index-map";
import type {
  DynamoStore,
  QueryPage,
  StoreItem,
  TtlOptions,
} from "../../types";
import type { SlotAssignment } from "./key-codec";
import {
  assignSlots,
  DEFAULT_TTL_ATTRIBUTE,
  encodeKeys,
  encodeLookupQuery,
  PK,
  primaryKey,
  REVISION,
  stripReserved,
  TYPE_INDEX,
  TYPE_PK,
  uniqueMarkerKey,
} from "./key-codec";
import { generateSchemaFile } from "./schema";

type TransactItem = NonNullable<
  TransactWriteCommandInput["TransactItems"]
>[number];

/** DynamoDB's hard limit on actions in one `TransactWriteItems` call. */
const MAX_TRANSACT_ITEMS = 100;

/** Attempts at a guarded read-modify-write before giving up on the race. */
const MAX_WRITE_ATTEMPTS = 3;

/** Default cap on pages drained for one logical query. */
const DEFAULT_MAX_PAGES = 25;

export interface SingleTableStoreOptions {
  /** DynamoDB table name. Falls back to `DYNAMODB_TABLE_NAME`, then `"better-auth"`. */
  tableName?: string;
  /** AWS region (passed to the DynamoDB client). */
  region?: string;
  /** Endpoint override, e.g. DynamoDB Local or LocalStack (`http://localhost:4566`). */
  endpoint?: string;
  /** Resolved logical access-pattern map (derived or user-supplied). */
  indexMap: IndexMap;
  /**
   * Pre-built document client. Preferred in production, so your application
   * owns credentials, region, middleware, tracing, and marshalling.
   */
  documentClient?: DynamoDBDocumentClient;
  /**
   * Enforce `unique` schema fields with transactional marker rows. Default
   * `true`. Turning it off halves the write cost of creates and restores
   * Better Auth's application-layer check-then-insert, which can admit
   * duplicates under concurrency.
   */
  atomicUniqueness?: boolean;
  /** Max DynamoDB pages drained for one internal count. Default 25. */
  maxPages?: number;
  /** Optional per-request DynamoDB `Limit`. Does not change logical results. */
  pageSize?: number;
  /** Adapter-managed DynamoDB TTL. Omit (or `false`) to disable entirely. */
  ttl?: TtlOptions | false;
}

const epochSeconds = (value: unknown): number | undefined => {
  const date =
    value instanceof Date
      ? value
      : typeof value === "string" || typeof value === "number"
        ? new Date(value)
        : undefined;
  if (!date || Number.isNaN(date.getTime())) return undefined;
  return Math.floor(date.getTime() / 1000);
};

/**
 * A zero-dependency (beyond the AWS SDK) DynamoDB store for Better Auth.
 *
 * Uses a single table with a `byType` GSI plus generic lookup GSIs. It owns all
 * physical key encoding via the key codec, so the generic adapter core drives it
 * through logical index names only. Works with any Better Auth model or plugin
 * whose looked-up fields are described by the (typically schema-derived) index
 * map.
 *
 * Every mutation is guarded: creates are conditional on the row not already
 * existing, updates and deletes carry an optimistic revision check, and
 * uniqueness markers move in the same transaction as the row they describe.
 */
export function createSingleTableStore(
  opts: SingleTableStoreOptions,
): DynamoStore {
  const tableName =
    opts.tableName ?? process.env.DYNAMODB_TABLE_NAME ?? "better-auth";
  const doc =
    opts.documentClient ??
    DynamoDBDocumentClient.from(
      new DynamoDBClient({
        ...(opts.region ? { region: opts.region } : {}),
        ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
      }),
      { marshallOptions: { removeUndefinedValues: true } },
    );
  const indexMap = opts.indexMap;
  const assignment: SlotAssignment = assignSlots(indexMap);
  const atomicUniqueness = opts.atomicUniqueness ?? true;
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const ttl = opts.ttl === false ? undefined : opts.ttl;
  const ttlAttribute = ttl?.attributeName ?? DEFAULT_TTL_ATTRIBUTE;

  // ---------------------------------------------------------------- TTL ----

  const ttlFieldFor = (model: string): string | undefined =>
    ttl ? (ttl.fields?.[model] ?? ttl.defaultField) : undefined;

  const ttlAttributesFor = (model: string, item: StoreItem): StoreItem => {
    const field = ttlFieldFor(model);
    if (!field) return {};
    const seconds = epochSeconds(item[field]);
    return seconds === undefined ? {} : { [ttlAttribute]: seconds };
  };

  /**
   * DynamoDB reaps expired rows lazily — up to a couple of days late. Treating
   * the TTL attribute as logical expiry on read is what makes an expired
   * session unusable the moment it expires rather than whenever AWS gets round
   * to the delete.
   */
  const isExpired = (item: StoreItem | undefined | null): boolean => {
    if (!item || !ttl) return false;
    const seconds = item[ttlAttribute];
    return (
      typeof seconds === "number" && seconds <= Math.floor(Date.now() / 1000)
    );
  };

  const modelHasTtl = (model: string): boolean => Boolean(ttlFieldFor(model));

  // ----------------------------------------------------------- uniqueness --

  const uniquePatternsFor = (model: string): AccessPattern[] =>
    atomicUniqueness ? (indexMap[model] ?? []).filter((p) => p.unique) : [];

  const uniqueFieldNames = (model: string): string[] =>
    uniquePatternsFor(model).flatMap((p) => p.pk);

  const markerItem = (
    model: string,
    pattern: AccessPattern,
    values: unknown[],
    ownerId: string,
    source: StoreItem,
  ): StoreItem => ({
    ...uniqueMarkerKey(model, pattern.index, values),
    __ba_owner: ownerId,
    ...ttlAttributesFor(model, source),
  });

  const applicableValues = (
    pattern: AccessPattern,
    item: StoreItem,
  ): unknown[] | null => {
    const values = pattern.pk.map((f) => item[f]);
    return values.some((v) => v == null) ? null : values;
  };

  const uniqueMarkerPuts = (
    model: string,
    item: StoreItem,
    id: string,
  ): TransactItem[] =>
    uniquePatternsFor(model).flatMap((pattern) => {
      const values = applicableValues(pattern, item);
      if (!values) return [];
      return [
        {
          Put: {
            TableName: tableName,
            Item: markerItem(model, pattern, values, id, item),
            ConditionExpression: "attribute_not_exists(#pk)",
            ExpressionAttributeNames: { "#pk": PK },
          },
        },
      ];
    });

  const uniqueMarkerDeletes = (
    model: string,
    item: StoreItem | null,
  ): TransactItem[] => {
    if (!item) return [];
    return uniquePatternsFor(model).flatMap((pattern) => {
      const values = applicableValues(pattern, item);
      if (!values) return [];
      return [
        {
          Delete: {
            TableName: tableName,
            Key: uniqueMarkerKey(model, pattern.index, values),
          },
        },
      ];
    });
  };

  /**
   * Marker moves for an update. A pattern whose value did not change is
   * skipped: deleting and re-putting the same key inside one transaction is a
   * self-conflict DynamoDB rejects outright.
   */
  const uniqueMarkerDiff = (
    model: string,
    before: StoreItem,
    after: StoreItem,
    id: string,
  ): TransactItem[] => {
    const items: TransactItem[] = [];
    for (const pattern of uniquePatternsFor(model)) {
      const oldValues = applicableValues(pattern, before);
      const newValues = applicableValues(pattern, after);
      if (
        oldValues?.length === newValues?.length &&
        oldValues?.every((v, i) => v === newValues![i])
      ) {
        continue;
      }
      if (oldValues) {
        items.push({
          Delete: {
            TableName: tableName,
            Key: uniqueMarkerKey(model, pattern.index, oldValues),
          },
        });
      }
      if (newValues) {
        items.push({
          Put: {
            TableName: tableName,
            Item: markerItem(model, pattern, newValues, id, after),
            ConditionExpression: "attribute_not_exists(#pk)",
            ExpressionAttributeNames: { "#pk": PK },
          },
        });
      }
    }
    return items;
  };

  // ---------------------------------------------------------- transactions --

  const keyOf = (action: TransactItem): string => {
    const target =
      action.Put?.Item ?? action.Delete?.Key ?? action.Update?.Key ?? {};
    return `${String((target as StoreItem)[PK])}`;
  };

  /**
   * DynamoDB rejects a transaction that touches the same item twice, and caps
   * one at 100 actions. Both produce opaque server-side errors, so they are
   * checked here where the cause is still known.
   */
  const validateTransaction = (model: string, items: TransactItem[]): void => {
    if (items.length > MAX_TRANSACT_ITEMS) {
      throw new DynamoDBAdapterError(
        `better-auth-dynamodb: a single write to "${model}" would need ` +
          `${items.length} transaction actions, over DynamoDB's ` +
          `${MAX_TRANSACT_ITEMS}-action limit. Reduce the number of unique ` +
          `fields on this model.`,
      );
    }
    const seen = new Set<string>();
    for (const item of items) {
      const key = keyOf(item);
      if (seen.has(key)) {
        throw new DynamoDBAdapterError(
          `better-auth-dynamodb: internal error — two actions in one ` +
            `transaction target the same item on "${model}". Please report this.`,
        );
      }
      seen.add(key);
    }
  };

  const sendTransaction = async (
    model: string,
    items: TransactItem[],
  ): Promise<void> => {
    validateTransaction(model, items);
    await doc.send(
      new TransactWriteCommand({
        TransactItems: items,
        // Gives the SDK's internal retries of this one send a stable token.
        // Not cross-invocation idempotency.
        ClientRequestToken: randomUUID(),
      }),
    );
  };

  const asUniqueConflict = (model: string, err: unknown): never => {
    if (isConditionalTransactionCanceled(err)) {
      throw new UniqueConstraintError(model, uniqueFieldNames(model), {
        cause: err,
      });
    }
    throw err;
  };

  // ------------------------------------------------------ revision guards --

  /** Read the raw (reserved attributes intact) row — needed for its revision. */
  const readRaw = async (
    model: string,
    id: string,
  ): Promise<StoreItem | null> => {
    const res = await doc.send(
      new GetCommand({
        TableName: tableName,
        Key: primaryKey(model, id),
        ConsistentRead: true,
      }),
    );
    if (!res.Item || isExpired(res.Item)) return null;
    return res.Item as StoreItem;
  };

  /**
   * Condition that the row still carries the revision we read. Rows written
   * before revisions existed are matched on the revision being absent, so they
   * migrate in place on their first write rather than becoming unmutatable.
   */
  const revisionGuard = (existing: StoreItem) => {
    const revision = existing[REVISION];
    return revision === undefined
      ? {
          ConditionExpression:
            "attribute_exists(#pk) AND attribute_not_exists(#rev)",
          ExpressionAttributeNames: { "#pk": PK, "#rev": REVISION },
        }
      : {
          ConditionExpression: "attribute_exists(#pk) AND #rev = :rev",
          ExpressionAttributeNames: { "#pk": PK, "#rev": REVISION },
          ExpressionAttributeValues: { ":rev": revision },
        };
  };

  /** The write was refused by a condition we set, rather than failing outright. */
  const rejectedByGuard = (err: unknown): boolean =>
    isConditionalCheckFailed(err) || isConditionalTransactionCanceled(err);

  // ---------------------------------------------------------------- reads --

  const query = async (
    input: Omit<
      ConstructorParameters<typeof QueryCommand>[0],
      "TableName" | "ExclusiveStartKey"
    >,
    cursor?: unknown,
    countOnly = false,
  ): Promise<{ items: StoreItem[]; count: number; cursor?: unknown }> => {
    const res = await doc.send(
      new QueryCommand({
        TableName: tableName,
        ExclusiveStartKey: cursor as Record<string, unknown> | undefined,
        ...(countOnly ? { Select: "COUNT" } : {}),
        ...(opts.pageSize ? { Limit: opts.pageSize } : {}),
        ...input,
      }),
    );
    return {
      items: countOnly
        ? []
        : (res.Items ?? [])
            .filter((item) => !isExpired(item as StoreItem))
            .map((i) => stripReserved(i)!),
      count: res.Count ?? 0,
      cursor: res.LastEvaluatedKey,
    };
  };

  // --------------------------------------------------------------- writes --

  const putEntity = (model: string, item: StoreItem): TransactItem => ({
    Put: {
      TableName: tableName,
      Item: {
        ...item,
        ...encodeKeys(model, item, indexMap, assignment),
        ...ttlAttributesFor(model, item),
        [REVISION]: randomUUID(),
      },
      ConditionExpression: "attribute_not_exists(#pk)",
      ExpressionAttributeNames: { "#pk": PK },
    },
  });

  /**
   * Guarded read-modify-write. `build` turns the current raw row into the
   * transaction that replaces it; a lost race re-reads and tries again rather
   * than surfacing a spurious failure for what is usually a benign interleave.
   */
  const guardedWrite = async <T>(
    model: string,
    id: string,
    build: (existing: StoreItem) => { items: TransactItem[]; result: T },
    onMissing: () => T,
  ): Promise<T> => {
    for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt++) {
      const existing = await readRaw(model, id);
      if (!existing) return onMissing();
      const { items, result } = build(existing);
      try {
        await sendTransaction(model, items);
        return result;
      } catch (err) {
        // Two retryable shapes: our own guard refused the write because the row
        // moved, or DynamoDB hit contention on the item. Anything else is real.
        const guarded = rejectedByGuard(err);
        if (!guarded && !isTransactionConflict(err)) throw err;
        // A uniqueness marker collision is terminal; a stale revision is not.
        if (guarded && (await lostToUniqueness(model, id, existing))) {
          return asUniqueConflict(model, err);
        }
        if (attempt === MAX_WRITE_ATTEMPTS) {
          throw new OptimisticLockError(model, id, { cause: err });
        }
      }
    }
    /* c8 ignore next */
    throw new OptimisticLockError(model, id);
  };

  /**
   * Distinguish the two reasons a guarded write is cancelled: the row moved
   * under us (retryable), or a unique marker is held by somebody else
   * (terminal). DynamoDB reports both as `ConditionalCheckFailed`, so the row
   * is re-read to tell them apart.
   */
  const lostToUniqueness = async (
    model: string,
    id: string,
    previous: StoreItem,
  ): Promise<boolean> => {
    if (uniquePatternsFor(model).length === 0) return false;
    const current = await readRaw(model, id);
    // The revision is unchanged, so the row did not move — the marker did.
    return Boolean(current) && current![REVISION] === previous[REVISION];
  };

  return {
    async put(model, item) {
      const id = String(item.id);
      const entity = putEntity(model, item);
      const markers = uniqueMarkerPuts(model, item, id);

      try {
        if (markers.length === 0) {
          await doc.send(new PutCommand({ ...entity.Put! }));
        } else {
          await sendTransaction(model, [entity, ...markers]);
        }
      } catch (err) {
        if (isConditionalCheckFailed(err)) {
          throw new DynamoDBAdapterError(
            `better-auth-dynamodb: a "${model}" row with id "${id}" already exists.`,
            { cause: err },
          );
        }
        asUniqueConflict(model, err);
      }
      return item;
    },

    async getById(model, id) {
      const raw = await readRaw(model, id);
      return stripReserved(raw);
    },

    async update(model, id, patch) {
      return guardedWrite<StoreItem | null>(
        model,
        id,
        (existing) => {
          const clean = stripReserved(existing)!;
          const merged = { ...clean, ...patch };
          return {
            items: [
              {
                Put: {
                  TableName: tableName,
                  Item: {
                    ...merged,
                    ...encodeKeys(model, merged, indexMap, assignment),
                    ...ttlAttributesFor(model, merged),
                    [REVISION]: randomUUID(),
                  },
                  ...revisionGuard(existing),
                },
              },
              ...uniqueMarkerDiff(model, clean, merged, id),
            ],
            result: merged,
          };
        },
        () => null,
      );
    },

    async deleteById(model, id) {
      await guardedWrite<void>(
        model,
        id,
        (existing) => ({
          items: [
            {
              Delete: {
                TableName: tableName,
                Key: primaryKey(model, id),
                ...revisionGuard(existing),
              },
            },
            ...uniqueMarkerDeletes(model, stripReserved(existing)),
          ],
          result: undefined,
        }),
        () => undefined,
      );
    },

    async consumeOne(model, id) {
      // With no markers to move, a single conditional delete is already atomic
      // and returns what it removed — no read needed.
      if (uniquePatternsFor(model).length === 0) {
        const res = await doc.send(
          new DeleteCommand({
            TableName: tableName,
            Key: primaryKey(model, id),
            ReturnValues: "ALL_OLD",
          }),
        );
        const item = res.Attributes as StoreItem | undefined;
        return isExpired(item) ? null : stripReserved(item);
      }

      // Otherwise the revision guard is what makes exactly one caller win: the
      // loser's condition fails against an already-deleted row.
      const existing = await readRaw(model, id);
      if (!existing) return null;
      const clean = stripReserved(existing)!;
      try {
        await sendTransaction(model, [
          {
            Delete: {
              TableName: tableName,
              Key: primaryKey(model, id),
              ...revisionGuard(existing),
            },
          },
          ...uniqueMarkerDeletes(model, clean),
        ]);
      } catch (err) {
        if (rejectedByGuard(err)) return null;
        throw err;
      }
      return clean;
    },

    async incrementOne(model, id, { increment, set }) {
      const indexedFields = new Set(
        (indexMap[model] ?? []).flatMap((p) => [...p.pk, ...(p.sk ?? [])]),
      );
      const touchesIndex = Object.keys(set ?? {}).some((f) =>
        indexedFields.has(f),
      );
      const ttlField = ttlFieldFor(model);
      const touchesTtl = Boolean(ttlField && set && ttlField in set);

      // A native ADD cannot also re-encode GSI keys or the TTL attribute, so a
      // `set` that moves an indexed or TTL field goes the read-modify-write
      // route instead of silently leaving stale index rows behind.
      if (touchesIndex || touchesTtl) {
        return guardedWrite<StoreItem | null>(
          model,
          id,
          (existing) => {
            const clean = stripReserved(existing)!;
            const merged = { ...clean, ...(set ?? {}) };
            for (const [field, delta] of Object.entries(increment)) {
              const current = merged[field];
              merged[field] =
                (typeof current === "number" ? current : 0) + delta;
            }
            return {
              items: [
                {
                  Put: {
                    TableName: tableName,
                    Item: {
                      ...merged,
                      ...encodeKeys(model, merged, indexMap, assignment),
                      ...ttlAttributesFor(model, merged),
                      [REVISION]: randomUUID(),
                    },
                    ...revisionGuard(existing),
                  },
                },
                ...uniqueMarkerDiff(model, clean, merged, id),
              ],
              result: merged,
            };
          },
          () => null,
        );
      }

      const names: Record<string, string> = { "#pk": PK, "#rev": REVISION };
      const values: Record<string, unknown> = { ":rev": randomUUID() };
      const addClauses: string[] = [];
      const setClauses: string[] = ["#rev = :rev"];
      let i = 0;
      for (const [field, delta] of Object.entries(increment)) {
        names[`#f${i}`] = field;
        values[`:v${i}`] = delta;
        addClauses.push(`#f${i} :v${i}`);
        i++;
      }
      for (const [field, value] of Object.entries(set ?? {})) {
        names[`#f${i}`] = field;
        values[`:v${i}`] = value;
        setClauses.push(`#f${i} = :v${i}`);
        i++;
      }
      const expression = [
        `SET ${setClauses.join(", ")}`,
        addClauses.length ? `ADD ${addClauses.join(", ")}` : null,
      ]
        .filter(Boolean)
        .join(" ");

      try {
        const res = await doc.send(
          new UpdateCommand({
            TableName: tableName,
            Key: primaryKey(model, id),
            UpdateExpression: expression,
            // Without this, `ADD` would happily create the row it was told to
            // increment, turning "increment an existing counter" into an upsert.
            ConditionExpression: "attribute_exists(#pk)",
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
            ReturnValues: "ALL_NEW",
          }),
        );
        const item = res.Attributes as StoreItem | undefined;
        return isExpired(item) ? null : stripReserved(item);
      } catch (err) {
        if (isConditionalCheckFailed(err)) return null;
        throw err;
      }
    },

    async queryIndex({ model, index, key, cursor }): Promise<QueryPage> {
      const lookup = encodeLookupQuery(model, index, key, indexMap, assignment);
      const names: Record<string, string> = { "#pk": lookup.pkAttr };
      const values: Record<string, unknown> = { ":pk": lookup.pkValue };
      let condition = "#pk = :pk";
      if (lookup.skPrefix) {
        names["#sk"] = lookup.skAttr;
        values[":skp"] = lookup.skPrefix;
        condition += " AND begins_with(#sk, :skp)";
      }
      const { items, cursor: next } = await query(
        {
          IndexName: lookup.indexName,
          KeyConditionExpression: condition,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        },
        cursor,
      );
      return { items, cursor: next };
    },

    async listByType({ model, cursor }): Promise<QueryPage> {
      const { items, cursor: next } = await query(
        {
          IndexName: TYPE_INDEX,
          KeyConditionExpression: "#tpk = :tpk",
          ExpressionAttributeNames: { "#tpk": TYPE_PK },
          ExpressionAttributeValues: { ":tpk": model },
        },
        cursor,
      );
      return { items, cursor: next };
    },

    async count({ model, index, key }) {
      // `Select: COUNT` counts rows DynamoDB has not reaped yet, which would
      // over-report a model whose rows expire logically. Fall back to draining.
      if (modelHasTtl(model)) return null;

      let base: Parameters<typeof query>[0];
      if (index && key) {
        const lookup = encodeLookupQuery(
          model,
          index,
          key,
          indexMap,
          assignment,
        );
        base = {
          IndexName: lookup.indexName,
          KeyConditionExpression: "#pk = :pk",
          ExpressionAttributeNames: { "#pk": lookup.pkAttr },
          ExpressionAttributeValues: { ":pk": lookup.pkValue },
        };
      } else {
        base = {
          IndexName: TYPE_INDEX,
          KeyConditionExpression: "#tpk = :tpk",
          ExpressionAttributeNames: { "#tpk": TYPE_PK },
          ExpressionAttributeValues: { ":tpk": model },
        };
      }
      let total = 0;
      let cursor: unknown = undefined;
      let pages = 0;
      do {
        const page = await query(base, cursor, true);
        total += page.count;
        cursor = page.cursor;
        if (++pages >= maxPages && cursor) {
          throw new DynamoDBAdapterError(
            `better-auth-dynamodb: counting "${model}" exceeded maxPages ` +
              `(${maxPages}) with more pages remaining. Raise maxPages or ` +
              `narrow the query — returning a partial count would be wrong.`,
          );
        }
      } while (cursor);
      return total;
    },

    createSchema: ({ file }) =>
      Promise.resolve(
        generateSchemaFile({
          tableName,
          lookupSlots: assignment.maxSlots,
          file,
          ttlAttribute: ttl ? ttlAttribute : undefined,
        }),
      ),
  };
}
