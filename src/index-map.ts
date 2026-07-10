/**
 * Declarative description of a DynamoDB access pattern (one logical index).
 *
 * The adapter never deals in physical `PK`/`SK` strings — it only knows the
 * *logical* index name and which fields form its partition/sort key. Each store
 * implementation is responsible for translating a logical index + field values
 * into a concrete DynamoDB query. This is what lets the exact same generic core
 * drive both the built-in single-table store and a bring-your-own store (e.g.
 * one backed by ElectroDB) without either leaking its key encoding upward.
 */
export interface AccessPattern {
  /** Logical index name both the planner and the store agree on (e.g. `"byEmail"`). */
  index: string;
  /**
   * Fields that make up the partition key. Every one of these MUST be present as
   * an equality (`eq`) clause in a `where` for this pattern to be selected.
   */
  pk: string[];
  /**
   * Ordered fields that make up the sort key. Optional and prefix-satisfiable:
   * the planner attaches as many leading `sk` fields as the `where` provides
   * (as `eq` clauses), and leaves the rest to residual in-memory filtering.
   */
  sk?: string[];
}

/** Ordered list of access patterns for a single model, most specific first. */
export type ModelIndexMap = AccessPattern[];

/**
 * Map of model name -> its access patterns. The planner walks a model's
 * patterns in order and picks the first whose `pk` fields are all present.
 */
export type IndexMap = Record<string, ModelIndexMap>;
