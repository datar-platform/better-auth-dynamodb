/**
 * @datar-platform/better-auth-dynamodb
 *
 * A generic DynamoDB adapter for Better Auth. Use the built-in single-table
 * store, or bring your own by implementing {@link DynamoStore}.
 */
export { dynamoAdapter } from "./adapter";

export type {
  DynamoAdapterConfig,
  DynamoStore,
  QueryPage,
  StoreItem,
} from "./types";
export type { AccessPattern, IndexMap, ModelIndexMap } from "./index-map";
export type { QueryPlan } from "./planner";
export { planQuery } from "./planner";
export { matchesResidual } from "./pagination";

// Built-in single-table store (opt-in for advanced wiring / tests).
export { createSingleTableStore } from "./stores/default/single-table-store";
export type { SingleTableStoreOptions } from "./stores/default/single-table-store";
export { deriveIndexMap } from "./stores/default/derive-index-map";
export {
  buildTableDefinition,
  ensureSchema,
  generateSchemaFile,
} from "./stores/default/schema";
export { assignSlots } from "./stores/default/key-codec";
