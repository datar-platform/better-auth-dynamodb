import type { CleanedWhere } from "@better-auth/core/db/adapter";
import type { BetterAuthOptions } from "better-auth";
import type { AdapterFactory } from "better-auth/adapters";
import { createAdapterFactory } from "better-auth/adapters";

import { UnsupportedQueryError } from "./errors";
import type { QueryPlan } from "./planner";
import type { DynamoAdapterConfig, DynamoStore, StoreItem } from "./types";
import {
  applySort,
  applyWindow,
  DEFAULT_MAX_PAGES,
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

    adapter: ({ schema, debugLog, getDefaultModelName, getFieldName }) => {
      const indexMap = config.indexMap ?? deriveIndexMap(schema);
      const maxPages = config.maxPages ?? DEFAULT_MAX_PAGES;
      const store: DynamoStore =
        config.store ??
        createSingleTableStore({
          tableName: config.tableName,
          region: config.region,
          endpoint: config.endpoint,
          documentClient: config.documentClient,
          atomicUniqueness: config.atomicUniqueness,
          maxPages,
          pageSize: config.pageSize,
          ttl: config.ttl,
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
        } else if (plan.kind === "byIds") {
          const found = await mapBatched(plan.ids, (id) =>
            store.getById(model, id),
          );
          candidates = found.filter((item): item is StoreItem => item !== null);
        } else if (plan.kind === "index") {
          candidates = await drainPages(
            (cursor) =>
              store.queryIndex({
                model,
                index: plan.index,
                key: plan.key,
                cursor,
              }),
            maxPages,
            `index query on "${model}"`,
          );
        } else {
          if (!config.unsafeAllowScan) {
            throw new UnsupportedQueryError(
              `better-auth-dynamodb: no index can serve this query on ` +
                `"${model}" (${describeWhere(clauses)}), so it would have to ` +
                `read every row of the model and filter in memory. Add the ` +
                `field to the index map — or to the Better Auth schema as ` +
                `\`unique\`, \`references\`, or \`index: true\` — or set ` +
                `\`unsafeAllowScan: true\` to accept the cost.`,
            );
          }
          candidates = await drainPages(
            (cursor) => store.listByType({ model, cursor }),
            maxPages,
            `model scan of "${model}"`,
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
        // The shortcut is only sound when `id` was the *whole* predicate.
        // `where: [id = x, status = "active"]` must still check the status, or
        // a guarded update would fire against a row that does not qualify.
        if (plan.kind === "byId" && plan.residual.length === 0) return plan.id;
        const [first] = await queryAll(model, where);
        return first ? String(first.id) : null;
      };

      /**
       * Narrow rows to the requested fields. Better Auth asks for projection at
       * the API surface; DynamoDB could do it server-side, but only by giving
       * up the reserved key attributes the store needs, so it happens here.
       */
      const project = (
        model: string,
        items: StoreItem[],
        select?: string[],
      ): StoreItem[] => {
        if (!select?.length) return items;
        // `select` arrives in Better Auth's field names; rows are stored under
        // whatever `fieldName` the schema maps them to, so the names have to be
        // translated before picking or every field comes back undefined.
        const stored = select.map((field) => getFieldName({ model, field }));
        return items.map((item) => {
          const picked: StoreItem = {};
          for (const field of stored) {
            if (field in item) picked[field] = item[field];
          }
          return picked;
        });
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
          select,
        }: {
          model: string;
          where: CleanedWhere[];
          select?: string[];
        }) {
          const m = getDefaultModelName(model);
          const [first] = project(m, await queryAll(m, where), select);
          return (first ?? null) as T | null;
        },

        async findMany<T>({
          model,
          where,
          limit,
          sortBy,
          offset,
          select,
        }: {
          model: string;
          where?: CleanedWhere[];
          limit: number;
          sortBy?: { field: string; direction: "asc" | "desc" };
          offset?: number;
          select?: string[];
        }) {
          const m = getDefaultModelName(model);
          // Projection runs last: sorting by a field the caller did not select
          // must still work.
          const items = project(
            m,
            applyWindow(
              applySort(await queryAll(m, where), sortBy),
              offset,
              limit,
            ),
            select,
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
          // Only for the two plans a native count actually describes — counting
          // a `byId`/`byIds` plan this way would count the whole model instead.
          if (plan.residual.length === 0 && store.count) {
            if (plan.kind === "index") {
              const fast = await store.count({
                model: m,
                index: plan.index,
                key: plan.key,
              });
              if (fast != null) return fast;
            } else if (plan.kind === "listByType") {
              const fast = await store.count({ model: m });
              if (fast != null) return fast;
            }
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

/** Render a `where` for an error message, without leaking the values. */
function describeWhere(where: CleanedWhere[]): string {
  if (where.length === 0) return "no where clause";
  return where.map((w) => `${w.field} ${w.operator}`).join(", ");
}

/** Map items through an async op in small concurrent chunks, keeping order. */
async function mapBatched<T, R>(
  items: T[],
  op: (item: T) => Promise<R>,
  chunkSize = 10,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    out.push(...(await Promise.all(items.slice(i, i + chunkSize).map(op))));
  }
  return out;
}

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
