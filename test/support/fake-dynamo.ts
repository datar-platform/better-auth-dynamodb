import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

/**
 * A deliberately small in-memory stand-in for DynamoDB.
 *
 * It models exactly the surface the built-in store uses — `Get`, `Put`,
 * `Delete`, `Update`, and `TransactWrite` on a `PK`/`SK` table — and exactly
 * the four condition expressions the store emits. That narrowness is the
 * point: it makes uniqueness collisions, revision races, and conditional
 * upserts *deterministic* and instant, where a real DynamoDB can only be
 * cajoled into them by timing. The real key encoding, GSI behaviour, and
 * transaction semantics are proven separately by the DynamoDB Local suite.
 */

const PK = "__ba_pk";
const SK = "__ba_sk";

type Item = Record<string, any>;

/** AWS-shaped errors, so the store's error classification is exercised for real. */
class ConditionalCheckFailedException extends Error {
  override name = "ConditionalCheckFailedException";
}

class TransactionCanceledException extends Error {
  override name = "TransactionCanceledException";
  constructor(readonly CancellationReasons: { Code: string }[]) {
    super(
      "Transaction cancelled, please refer cancellation reasons for details",
    );
  }
}

export interface FakeDynamo {
  client: DynamoDBDocumentClient;
  /** Every row currently stored. */
  rows(): Item[];
  /** Rows whose partition key carries the given prefix (e.g. `"U#"` markers). */
  rowsWithPrefix(prefix: string): Item[];
  /** Commands seen, most recent last — for asserting the shape of a write. */
  commands(): { type: string; input: any }[];
  /** Force the next `n` writes to fail as if they lost a race. */
  failNextWrites(n: number): void;
}

const keyOf = (item: Item): string => `${String(item[PK])} ${String(item[SK])}`;

/**
 * Evaluate one of the store's condition expressions against the current row.
 * Anything else is a test-authoring mistake, so it throws loudly rather than
 * silently passing.
 */
function conditionHolds(
  expression: string | undefined,
  names: Record<string, string> | undefined,
  values: Record<string, any> | undefined,
  current: Item | undefined,
): boolean {
  if (!expression) return true;
  const revAttr = names?.["#rev"];
  switch (expression) {
    case "attribute_not_exists(#pk)":
      return current === undefined;
    case "attribute_exists(#pk)":
      return current !== undefined;
    case "attribute_exists(#pk) AND attribute_not_exists(#rev)":
      return current !== undefined && current[revAttr!] === undefined;
    case "attribute_exists(#pk) AND #rev = :rev":
      return current !== undefined && current[revAttr!] === values?.[":rev"];
    default:
      throw new Error(`fake-dynamo: unmodelled condition "${expression}"`);
  }
}

/** Apply the `SET`/`ADD` update expression shapes the store emits. */
function applyUpdate(current: Item, input: any): Item {
  const names: Record<string, string> = input.ExpressionAttributeNames ?? {};
  const values: Record<string, any> = input.ExpressionAttributeValues ?? {};
  const next = { ...current };
  const expression: string = input.UpdateExpression;

  const setPart = /SET (.+?)(?: ADD |$)/.exec(expression)?.[1];
  for (const clause of setPart?.split(", ") ?? []) {
    const [name = "", value = ""] = clause.split(" = ");
    next[names[name.trim()]!] = values[value.trim()];
  }

  const addPart = /ADD (.+)$/.exec(expression)?.[1];
  for (const clause of addPart?.split(", ") ?? []) {
    const [name = "", value = ""] = clause.trim().split(" ");
    const field = names[name]!;
    const existing = next[field];
    next[field] = (typeof existing === "number" ? existing : 0) + values[value];
  }
  return next;
}

export function createFakeDynamo(): FakeDynamo {
  const store = new Map<string, Item>();
  const seen: { type: string; input: any }[] = [];
  let failures = 0;

  const send = async (command: any): Promise<any> => {
    const type = command.constructor.name;
    const input = command.input;
    seen.push({ type, input });

    const forcedFailure = failures > 0 && type !== "GetCommand";
    if (forcedFailure) failures--;

    switch (type) {
      case "GetCommand":
        return { Item: store.get(keyOf(input.Key)) };

      case "PutCommand": {
        const key = keyOf(input.Item);
        if (
          forcedFailure ||
          !conditionHolds(
            input.ConditionExpression,
            input.ExpressionAttributeNames,
            input.ExpressionAttributeValues,
            store.get(key),
          )
        ) {
          throw new ConditionalCheckFailedException(
            "The conditional request failed",
          );
        }
        store.set(key, { ...input.Item });
        return {};
      }

      case "DeleteCommand": {
        const key = keyOf(input.Key);
        const current = store.get(key);
        if (
          forcedFailure ||
          !conditionHolds(
            input.ConditionExpression,
            input.ExpressionAttributeNames,
            input.ExpressionAttributeValues,
            current,
          )
        ) {
          throw new ConditionalCheckFailedException(
            "The conditional request failed",
          );
        }
        store.delete(key);
        return input.ReturnValues === "ALL_OLD" ? { Attributes: current } : {};
      }

      case "UpdateCommand": {
        const key = keyOf(input.Key);
        const current = store.get(key);
        if (
          forcedFailure ||
          !conditionHolds(
            input.ConditionExpression,
            input.ExpressionAttributeNames,
            input.ExpressionAttributeValues,
            current,
          )
        ) {
          throw new ConditionalCheckFailedException(
            "The conditional request failed",
          );
        }
        const next = applyUpdate(current!, input);
        store.set(key, next);
        return input.ReturnValues === "ALL_NEW" ? { Attributes: next } : {};
      }

      case "TransactWriteCommand": {
        const actions: any[] = input.TransactItems;
        if (forcedFailure) {
          throw new TransactionCanceledException([
            { Code: "TransactionConflict" },
          ]);
        }
        // All-or-nothing: every condition is evaluated against the pre-state
        // before anything is written, as DynamoDB does.
        const reasons = actions.map((action) => {
          const body = action.Put ?? action.Delete ?? action.Update;
          const key = keyOf(action.Put ? action.Put.Item : body.Key);
          return conditionHolds(
            body.ConditionExpression,
            body.ExpressionAttributeNames,
            body.ExpressionAttributeValues,
            store.get(key),
          )
            ? { Code: "None" }
            : { Code: "ConditionalCheckFailed" };
        });
        if (reasons.some((r) => r.Code !== "None")) {
          throw new TransactionCanceledException(reasons);
        }
        for (const action of actions) {
          if (action.Put) {
            store.set(keyOf(action.Put.Item), { ...action.Put.Item });
          } else if (action.Delete) {
            store.delete(keyOf(action.Delete.Key));
          } else if (action.Update) {
            const key = keyOf(action.Update.Key);
            store.set(key, applyUpdate(store.get(key)!, action.Update));
          }
        }
        return {};
      }

      default:
        throw new Error(`fake-dynamo: unmodelled command "${type}"`);
    }
  };

  return {
    client: { send } as unknown as DynamoDBDocumentClient,
    rows: () => [...store.values()],
    rowsWithPrefix: (prefix) =>
      [...store.values()].filter((item) => String(item[PK]).startsWith(prefix)),
    commands: () => seen,
    failNextWrites: (n) => {
      failures = n;
    },
  };
}
