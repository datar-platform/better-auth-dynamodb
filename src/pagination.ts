import type { CleanedWhere } from "@better-auth/core/db/adapter";

import { DynamoDBAdapterError } from "./errors";
import type { QueryPage, StoreItem } from "./types";

/** Default cap on pages drained for one logical query. */
export const DEFAULT_MAX_PAGES = 25;

/**
 * Drain every page of a paginated store query into a single array.
 *
 * DynamoDB paginates at 1 MB / index-page boundaries regardless of match count,
 * so a single `.query()` can silently return a partial result. Draining here —
 * rather than trusting one page — is what makes `findMany`/`count` correct
 * (and removes the old adapter's implicit 10 000-row cap).
 *
 * Draining is bounded by `maxPages`. Hitting the cap throws: an auth query that
 * silently returns some of its rows is a correctness bug wearing a success
 * response.
 */
export async function drainPages(
  fetch: (cursor: unknown) => Promise<QueryPage>,
  maxPages = DEFAULT_MAX_PAGES,
  label = "query",
): Promise<StoreItem[]> {
  const out: StoreItem[] = [];
  let cursor: unknown = undefined;
  let pages = 0;
  do {
    const page = await fetch(cursor);
    out.push(...page.items);
    cursor = page.cursor;
    if (++pages >= maxPages && cursor) {
      throw new DynamoDBAdapterError(
        `better-auth-dynamodb: ${label} exceeded maxPages (${maxPages}) with ` +
          `more pages remaining. Raise maxPages or narrow the query — ` +
          `returning a partial result here would silently drop rows.`,
      );
    }
  } while (cursor);
  return out;
}

function matchOne(item: StoreItem, w: CleanedWhere): boolean {
  // `mode: "insensitive"` asks for case-insensitive comparison. It only has
  // meaning between two strings; anything else keeps exact semantics.
  const fold = (v: unknown): unknown =>
    w.mode === "insensitive" && typeof v === "string" ? v.toLowerCase() : v;

  const actual = fold(item[w.field]) as any;
  const expected = Array.isArray(w.value)
    ? (w.value as unknown[]).map(fold)
    : fold(w.value);
  switch (w.operator) {
    case "eq":
      return actual === expected;
    case "ne":
      return actual !== expected;
    case "lt":
      return actual < (expected as any);
    case "lte":
      return actual <= (expected as any);
    case "gt":
      return actual > (expected as any);
    case "gte":
      return actual >= (expected as any);
    case "in":
      return Array.isArray(expected) && expected.includes(actual);
    case "not_in":
      return Array.isArray(expected) && !expected.includes(actual);
    case "contains":
      return String(actual).includes(String(expected));
    case "starts_with":
      return String(actual).startsWith(String(expected));
    case "ends_with":
      return String(actual).endsWith(String(expected));
    default:
      return actual === expected;
  }
}

/**
 * Apply the residual `where` clauses in memory, honoring Better Auth's
 * connector semantics: all `AND` clauses must match, and — if any `OR` clauses
 * are present — at least one of them must also match. An empty residual passes.
 */
export function matchesResidual(
  item: StoreItem,
  residual: CleanedWhere[],
): boolean {
  const andOk = residual
    .filter((w) => w.connector !== "OR")
    .every((w) => matchOne(item, w));
  if (!andOk) return false;

  const or = residual.filter((w) => w.connector === "OR");
  return or.length === 0 || or.some((w) => matchOne(item, w));
}

/** Stable in-memory sort matching Better Auth's `sortBy` contract. */
export function applySort(
  items: StoreItem[],
  sortBy?: { field: string; direction: "asc" | "desc" },
): StoreItem[] {
  if (!sortBy) return items;
  const { field, direction } = sortBy;
  const dir = direction === "asc" ? 1 : -1;
  return [...items].sort((a, b) => {
    if (a[field] < b[field]) return -dir;
    if (a[field] > b[field]) return dir;
    return 0;
  });
}

/** Apply `offset`/`limit` (a `limit` of 0 or undefined means "no cap"). */
export function applyWindow(
  items: StoreItem[],
  offset?: number,
  limit?: number,
): StoreItem[] {
  let out = items;
  if (offset && offset > 0) out = out.slice(offset);
  if (limit && limit > 0) out = out.slice(0, limit);
  return out;
}
