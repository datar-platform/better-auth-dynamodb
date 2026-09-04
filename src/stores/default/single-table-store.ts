import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

import type { IndexMap } from "../../index-map";
import type { DynamoStore, QueryPage, StoreItem } from "../../types";
import type { SlotAssignment } from "./key-codec";
import {
  assignSlots,
  encodeKeys,
  encodeLookupQuery,
  primaryKey,
  stripReserved,
  TYPE_INDEX,
  TYPE_PK,
} from "./key-codec";
import { generateSchemaFile } from "./schema";

export interface SingleTableStoreOptions {
  /** DynamoDB table name. Falls back to `DYNAMODB_TABLE_NAME`, then `"better-auth"`. */
  tableName?: string;
  /** AWS region (passed to the DynamoDB client). */
  region?: string;
  /** Endpoint override, e.g. DynamoDB Local or LocalStack (`http://localhost:4566`). */
  endpoint?: string;
  /** Resolved logical access-pattern map (derived or user-supplied). */
  indexMap: IndexMap;
  /** Pre-built document client (used by tests, e.g. against DynamoDB Local). */
  documentClient?: DynamoDBDocumentClient;
}

/**
 * A zero-dependency (beyond the AWS SDK) DynamoDB store for Better Auth.
 *
 * Uses a single table with a `byType` GSI plus generic lookup GSIs. It owns all
 * physical key encoding via the key codec, so the generic adapter core drives it
 * through logical index names only. Works with any Better Auth model or plugin
 * whose looked-up fields are described by the (typically schema-derived) index
 * map.
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
        ...input,
      }),
    );
    return {
      items: countOnly ? [] : (res.Items ?? []).map((i) => stripReserved(i)!),
      count: res.Count ?? 0,
      cursor: res.LastEvaluatedKey,
    };
  };

  return {
    async put(model, item) {
      await doc.send(
        new PutCommand({
          TableName: tableName,
          Item: { ...item, ...encodeKeys(model, item, indexMap, assignment) },
        }),
      );
      return item;
    },

    async getById(model, id) {
      const res = await doc.send(
        new GetCommand({ TableName: tableName, Key: primaryKey(model, id) }),
      );
      return stripReserved(res.Item);
    },

    async update(model, id, patch) {
      const res = await doc.send(
        new GetCommand({ TableName: tableName, Key: primaryKey(model, id) }),
      );
      const existing = stripReserved(res.Item);
      if (!existing) return null;
      const merged = { ...existing, ...patch };
      await doc.send(
        new PutCommand({
          TableName: tableName,
          Item: {
            ...merged,
            ...encodeKeys(model, merged, indexMap, assignment),
          },
        }),
      );
      return merged;
    },

    async deleteById(model, id) {
      await doc.send(
        new DeleteCommand({ TableName: tableName, Key: primaryKey(model, id) }),
      );
    },

    async consumeOne(model, id) {
      const res = await doc.send(
        new DeleteCommand({
          TableName: tableName,
          Key: primaryKey(model, id),
          ReturnValues: "ALL_OLD",
        }),
      );
      return stripReserved(res.Attributes);
    },

    async incrementOne(model, id, { increment, set }) {
      const names: Record<string, string> = {};
      const values: Record<string, unknown> = {};
      const addClauses: string[] = [];
      const setClauses: string[] = [];
      let i = 0;
      for (const [field, delta] of Object.entries(increment)) {
        const nameKey = `#f${i}`;
        const valueKey = `:v${i}`;
        names[nameKey] = field;
        values[valueKey] = delta;
        addClauses.push(`${nameKey} ${valueKey}`);
        i++;
      }
      for (const [field, value] of Object.entries(set ?? {})) {
        const nameKey = `#f${i}`;
        const valueKey = `:v${i}`;
        names[nameKey] = field;
        values[valueKey] = value;
        setClauses.push(`${nameKey} = ${valueKey}`);
        i++;
      }
      const expression = [
        setClauses.length ? `SET ${setClauses.join(", ")}` : null,
        addClauses.length ? `ADD ${addClauses.join(", ")}` : null,
      ]
        .filter(Boolean)
        .join(" ");
      const res = await doc.send(
        new UpdateCommand({
          TableName: tableName,
          Key: primaryKey(model, id),
          UpdateExpression: expression,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ReturnValues: "ALL_NEW",
        }),
      );
      return stripReserved(res.Attributes);
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
      do {
        const page = await query(base, cursor, true);
        total += page.count;
        cursor = page.cursor;
      } while (cursor);
      return total;
    },

    createSchema: ({ file }) =>
      Promise.resolve(
        generateSchemaFile({
          tableName,
          lookupSlots: assignment.maxSlots,
          file,
        }),
      ),
  };
}
