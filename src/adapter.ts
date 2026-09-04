import type { CleanedWhere } from "@better-auth/core/db/adapter";
import type { BetterAuthOptions } from "better-auth";
import type { AdapterFactory } from "better-auth/adapters";
import { createAdapterFactory } from "better-auth/adapters";

import type { QueryPlan } from "./planner";
import type { DynamoAdapterConfig, DynamoStore, StoreItem } from "./types";
import {
  applySort,
  applyWindow,
  drainPages,
  matchesResidual,
} from "./pagination";
import { planQuery } from "./planner";
import { deriveIndexMap } from "./stores/default/derive-index-map";
import { createSingleTableStore } from "./stores/default/single-table-store";

/**
 * A generic DynamoDB adapter for Better Auth.
 *
 * The factory handles field mapping, JSON/date/boolean coercion, ID generation
 * and `where`-clause normalization; this adapter only implements the raw DB
 * operations. Those operations are expressed against a pluggable
 * {@link DynamoStore} and a declarative access-pattern map, so the same core
 * drives both the built-in single-table store and any custom store.
 *
 * @example
 * ```ts
 * betterAuth({ database: dynamoAdapter({ tableName: "auth", region: "us-east-1" }) });
 * ```
 */
export const dynamoAdapter = (
  config: DynamoAdapterConfig = {},
): AdapterFactory<BetterAuthOptions> => {
  return createAdapterFactory({
    config: {
      adapterId: "dynamodb",
      adapterName: "DynamoDB",
      // DynamoDB keys are strings; let Better Auth generate string ids.
      supportsNumericIds: false,
      // We serialize JSON ourselves via the SDK document client.
      supportsJSON: true,
      // No native Date type — stored as ISO strings (see transforms below).
      supportsDates: false,
      supportsBooleans: true,
      usePlural: false,
      debugLogs: config.debugLogs,

      // Dates <-> ISO strings, since supportsDates is false.
      customTransformInput: ({ data, fieldAttributes }) =>
        fieldAttributes.type === "date" && data instanceof Date
          ? data.toISOString()
          : data,
      customTransformOutput: ({ data, fieldAttributes }) =>
        fieldAttributes.type === "date" && typeof data === "string"
          ? new Date(data)
          : data,
    },

    adapter: ({ schema, debugLog, getDefaultModelName }) => {
      const indexMap = config.indexMap ?? deriveIndexMap(schema);
      const store: DynamoStore =
        config.store ??
        createSingleTableStore({
          tableName: config.tableName,
          region: config.region,
          endpoint: config.endpoint,
          indexMap,
        });

      /** Resolve every row matching `where`, using the best access path. */
      const queryAll = async (
        model: string,
        where?: CleanedWhere[],
      ): Promise<StoreItem[]> => {
        const clauses = where ?? [];
        const plan = planQuery(model, clauses, indexMap);
        debugLog("queryAll", { model, plan: plan.kind });

        let candidates: StoreItem[];
        if (plan.kind === "byId") {
          const one = await store.getById(model, plan.id);
          candidates = one ? [one] : [];
        } else if (plan.kind === "index") {
          candidates = await drainPages((cursor) =>
            store.queryIndex({
              model,
              index: plan.index,
              key: plan.key,
              cursor,
            }),
          );
        } else {
          candidates = await drainPages((cursor) =>
            store.listByType({ model, cursor }),
          );
        }
        return candidates.filter((item) =>
          matchesResidual(item, plan.residual),
        );
      };

      /** Find the primary id for a `where`, cheaply if it names `id` directly. */
      const resolveId = async (
        model: string,
        where: CleanedWhere[],
      ): Promise<string | null> => {
        const plan: QueryPlan = planQuery(model, where, indexMap);
        if (plan.kind === "byId") return plan.id;
        const [first] = await queryAll(model, where);
        return first ? String(first.id) : null;
      };

      return {
        async create<T extends Record<string, any>>({
          model,
          data,
        }: {
          model: string;
          data: T;
        }) {
          const m = getDefaultModelName(model);
          const created = await store.put(m, data);
          return created as T;
        },

        async update<T>({
          model,
          where,
          update,
        }: {
          model: string;
          where: CleanedWhere[];
          update: T;
        }) {
          const m = getDefaultModelName(model);
          const id = await resolveId(m, where);
          if (!id) return null;
          const updated = await store.update(m, id, update as StoreItem);
          return updated as T | null;
        },

        async updateMany({
          model,
          where,
          update,
        }: {
          model: string;
          where: CleanedWhere[];
          update: Record<string, any>;
        }) {
          const m = getDefaultModelName(model);
          const items = await queryAll(m, where);
          await runBatched(items, (item) =>
            store.update(m, String(item.id), update),
          );
          return items.length;
        },

        async delete({
          model,
          where,
        }: {
          model: string;
          where: CleanedWhere[];
        }) {
          const m = getDefaultModelName(model);
          const id = await resolveId(m, where);
          if (id) await store.deleteById(m, id);
        },

        async deleteMany({
          model,
          where,
        }: {
          model: string;
          where: CleanedWhere[];
        }) {
          const m = getDefaultModelName(model);
          const items = await queryAll(m, where);
          await runBatched(items, (item) =>
            store.deleteById(m, String(item.id)),
          );
          return items.length;
        },

        async findOne<T>({
          model,
          where,
        }: {
          model: string;
          where: CleanedWhere[];
        }) {
          const m = getDefaultModelName(model);
          const [first] = await queryAll(m, where);
          return (first ?? null) as T | null;
        },

        async findMany<T>({
          model,
          where,
          limit,
          sortBy,
          offset,
        }: {
          model: string;
          where?: CleanedWhere[];
          limit: number;
          sortBy?: { field: string; direction: "asc" | "desc" };
          offset?: number;
        }) {
          const m = getDefaultModelName(model);
          const items = applyWindow(
            applySort(await queryAll(m, where), sortBy),
            offset,
            limit,
          );
          return items as T[];
        },

        async count({
          model,
          where,
        }: {
          model: string;
          where?: CleanedWhere[];
        }) {
          const m = getDefaultModelName(model);
          const clauses = where ?? [];
          const plan = planQuery(m, clauses, indexMap);
          // Fast path: no residual predicates and the store can count natively.
          if (plan.residual.length === 0 && store.count) {
            const fast = await store.count(
              plan.kind === "index"
                ? { model: m, index: plan.index, key: plan.key }
                : { model: m },
            );
            if (fast != null) return fast;
          }
          return (await queryAll(m, clauses)).length;
        },

        async consumeOne<T>({
          model,
          where,
        }: {
          model: string;
          where: CleanedWhere[];
        }) {
          const m = getDefaultModelName(model);
          const id = await resolveId(m, where);
          if (!id) return null;
          if (store.consumeOne)
            return (await store.consumeOne(m, id)) as T | null;
          // Fallback for stores without a native atomic delete-and-return: not
          // safe under true concurrency, but correct for the common single
          // in-flight verification case.
          const item = await store.getById(m, id);
          if (!item) return null;
          await store.deleteById(m, id);
          return item as T;
        },

        async incrementOne<T>({
          model,
          where,
          increment,
          set,
        }: {
          model: string;
          where: CleanedWhere[];
          increment: Record<string, number>;
          set?: Record<string, any>;
        }) {
          const m = getDefaultModelName(model);
          const id = await resolveId(m, where);
          if (!id) return null;
          if (store.incrementOne) {
            return (await store.incrementOne(m, id, {
              increment,
              set,
            })) as T | null;
          }
          // Fallback for stores without a native atomic add/set: not safe
          // under true concurrency, but correct for the common single
          // in-flight update case.
          const current = await store.getById(m, id);
          if (!current) return null;
          const patch: StoreItem = { ...set };
          for (const [field, delta] of Object.entries(increment)) {
            patch[field] = (Number(current[field]) || 0) + delta;
          }
          return (await store.update(m, id, patch)) as T | null;
        },

        ...(store.createSchema
          ? {
              createSchema: (props: { file?: string; tables: unknown }) =>
                store.createSchema!(props),
            }
          : {}),
      };
    },
  });
};

/** Run an async op over items in small concurrent chunks to avoid throttling. */
async function runBatched<T>(
  items: T[],
  op: (item: T) => Promise<unknown>,
  chunkSize = 10,
): Promise<void> {
  for (let i = 0; i < items.length; i += chunkSize) {
    await Promise.all(items.slice(i, i + chunkSize).map(op));
  }
}
