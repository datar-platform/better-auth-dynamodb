import type { BetterAuthDBSchema } from "@better-auth/core/db";

import type { AccessPattern, IndexMap } from "../../index-map";

/** Logical index name for a single-field lookup (e.g. `email` -> `by_email`). */
export function lookupIndexName(field: string): string {
  return `by_${field}`;
}

/**
 * Derive a logical access-pattern map from a Better Auth schema.
 *
 * A single-field lookup index is created for every field that is either:
 *  - `unique`     (e.g. `user.email`, `session.token`) — direct lookups, or
 *  - a `references` foreign key (e.g. `account.userId`) — by-parent lookups, or
 *  - explicitly flagged `index: true`.
 *
 * This is what lets the built-in store serve any Better Auth model or plugin
 * (two-factor, passkey, api-key, …) out of the box: whatever fields the schema
 * marks as looked-up get an index, with no hand-maintained per-model table.
 */
export function deriveIndexMap(schema: BetterAuthDBSchema): IndexMap {
  const map: IndexMap = {};

  for (const [model, table] of Object.entries(schema)) {
    const patterns: AccessPattern[] = [];
    const seen = new Set<string>();

    const add = (field: string) => {
      if (field === "id" || seen.has(field)) return;
      seen.add(field);
      patterns.push({ index: lookupIndexName(field), pk: [field] });
    };

    // `unique` fields first (most selective), then foreign keys, then `index`.
    for (const [field, attr] of Object.entries(table.fields)) {
      if (attr.unique) add(field);
    }
    for (const [field, attr] of Object.entries(table.fields)) {
      if (attr.references) add(field);
    }
    for (const [field, attr] of Object.entries(table.fields)) {
      if (attr.index) add(field);
    }

    if (patterns.length > 0) map[model] = patterns;
  }

  return map;
}
