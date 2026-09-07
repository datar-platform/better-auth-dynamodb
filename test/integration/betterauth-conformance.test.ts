import type { BetterAuthOptions } from "better-auth";
import { getAuthTables } from "better-auth/db";
import {
  authFlowTestSuite,
  caseInsensitiveTestSuite,
  normalTestSuite,
  testAdapter,
  uuidTestSuite,
} from "@better-auth/test-utils/adapter";
import { randomUUID } from "node:crypto";

import {
  assignSlots,
  deriveIndexMap,
  dynamoAdapter,
  ensureSchema,
} from "../../src/index";
import { startDynamoLocal, type DynamoLocal } from "../support/dynamodb-local";

/**
 * Better Auth's *own* adapter conformance suites, run against real DynamoDB.
 *
 * These are the tests Better Auth uses to decide whether an adapter honours
 * its contract, so passing them is a far stronger claim than any assertion
 * written here could be — and they catch contract drift when Better Auth
 * itself changes.
 */
const tableName = `betterauth_conformance_${randomUUID().replaceAll("-", "")}`;

const dynamo: DynamoLocal = await startDynamoLocal();

const conformance = await testAdapter({
  adapter: () =>
    dynamoAdapter({
      tableName,
      documentClient: dynamo.documentClient,
      // The canonical suites deliberately exercise predicates no index can
      // serve, and case-insensitive equality — which DynamoDB keys, being
      // byte-compared, can never serve. Production defaults still reject both.
      unsafeAllowScan: true,
      maxPages: 100,
    }),
  runMigrations: async (options: BetterAuthOptions) => {
    // Provision exactly the GSIs this Better Auth configuration needs, derived
    // the same way the adapter derives its own access patterns.
    const indexMap = deriveIndexMap(getAuthTables(options));
    await ensureSchema({
      client: dynamo.client,
      tableName,
      lookupSlots: assignSlots(indexMap).maxSlots,
    });
  },
  onFinish: async () => {
    await dynamo.stop();
  },
  overrideBetterAuthOptions: (options) => ({
    ...options,
    emailAndPassword: { enabled: true, ...options.emailAndPassword },
    // Better Auth's verification cleanup issues a range-only
    // `deleteMany(expiresAt < now)`, which has no key to work from. Adapter TTL
    // is the DynamoDB-shaped answer to that, so cleanup stays off here.
    verification: { disableCleanup: true, ...options.verification },
  }),
  tests: [
    // The canonical CRUD/query/mutation contract.
    normalTestSuite(),
    // String ids are supported; only numeric ids are not.
    uuidTestSuite(),
    // Case-insensitive equality, served in memory rather than from an index.
    caseInsensitiveTestSuite(),
    // Better Auth's public auth flows, end to end.
    authFlowTestSuite(),
    // Excluded: numberIdTestSuite — the adapter sets supportsNumericIds: false.
    // Excluded: transactionsTestSuite — DynamoDB has no interactive transaction
    //   API, so the adapter honestly reports transaction: false.
    // Excluded: joinsTestSuite — native joins would need per-query access
    //   pattern design; Better Auth's fallback joins are covered above.
  ],
  prefixTests: "dynamodb-local-conformance",
});

conformance.execute();
