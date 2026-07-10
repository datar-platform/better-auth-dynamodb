import type { CleanedWhere } from "@better-auth/core/db/adapter";

import type { IndexMap } from "./index-map";
import type { StoreItem } from "./types";

/**
 * A resolved query plan: how the adapter will fetch candidate rows for a
 * `where` clause before applying any residual (in-memory) filtering.
 *
 * - `byId`      — a direct primary-key get (the cheapest path).
 * - `index`     — a logical index query with a resolved partition/sort key.
 * - `listByType`— no index matched; list all rows of the model and filter.
 *
 * `residual` holds the `where` clauses NOT satisfied by the chosen access path;
 * they are applied in memory by {@link matchesResidual}.
 */
export type QueryPlan =
  | { kind: "byId"; id: string; residual: CleanedWhere[] }
  | { kind: "index"; index: string; key: StoreItem; residual: CleanedWhere[] }
  | { kind: "listByType"; residual: CleanedWhere[] };

/** A clause usable for index selection: `eq`, `AND`-connected. */
function isKeyable(w: CleanedWhere): boolean {
  return w.operator === "eq" && w.connector === "AND" && w.value != null;
}

/**
 * Choose the most selective access path for `where` against a model's declared
 * access patterns. Falls back to `listByType` when nothing matches.
 *
 * Index selection only ever consumes `eq`/`AND` clauses; everything else (and
 * any `eq` clause not part of the chosen key) becomes residual.
 */
export function planQuery(
  model: string,
  where: CleanedWhere[],
  indexMap: IndexMap,
): QueryPlan {
  const eqByField = new Map<string, CleanedWhere>();
  for (const w of where) {
    if (isKeyable(w) && !eqByField.has(w.field)) eqByField.set(w.field, w);
  }

  // Cheapest: a direct id lookup. Everything else filters in memory.
  const idClause = eqByField.get("id");
  if (idClause) {
    return {
      kind: "byId",
      id: String(idClause.value),
      residual: where.filter((w) => w !== idClause),
    };
  }

  const patterns = indexMap[model] ?? [];
  for (const pattern of patterns) {
    if (!pattern.pk.every((f) => eqByField.has(f))) continue;

    const key: StoreItem = {};
    const consumed = new Set<CleanedWhere>();
    for (const f of pattern.pk) {
      const clause = eqByField.get(f)!;
      key[f] = clause.value;
      consumed.add(clause);
    }
    // Attach as many leading sort-key fields as are present (prefix match).
    for (const f of pattern.sk ?? []) {
      const clause = eqByField.get(f);
      if (!clause) break;
      key[f] = clause.value;
      consumed.add(clause);
    }

    return {
      kind: "index",
      index: pattern.index,
      key,
      residual: where.filter((w) => !consumed.has(w)),
    };
  }

  return { kind: "listByType", residual: where };
}
