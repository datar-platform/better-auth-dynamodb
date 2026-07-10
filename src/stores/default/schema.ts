import type {
  CreateTableCommandInput,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  CreateTableCommand,
  ResourceInUseException,
  waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";

import {
  gsiName,
  gsiPk,
  gsiSk,
  PK,
  SK,
  TYPE_INDEX,
  TYPE_PK,
  TYPE_SK,
} from "./key-codec";

/** Build the CreateTable input for the built-in store's single-table layout. */
export function buildTableDefinition(
  tableName: string,
  lookupSlots: number,
): CreateTableCommandInput {
  const attr = (name: string) => ({
    AttributeName: name,
    AttributeType: "S" as const,
  });

  const attributeDefinitions = [
    attr(PK),
    attr(SK),
    attr(TYPE_PK),
    attr(TYPE_SK),
  ];
  const globalSecondaryIndexes = [
    {
      IndexName: TYPE_INDEX,
      KeySchema: [
        { AttributeName: TYPE_PK, KeyType: "HASH" as const },
        { AttributeName: TYPE_SK, KeyType: "RANGE" as const },
      ],
      Projection: { ProjectionType: "ALL" as const },
    },
  ];

  for (let slot = 1; slot <= lookupSlots; slot++) {
    attributeDefinitions.push(attr(gsiPk(slot)), attr(gsiSk(slot)));
    globalSecondaryIndexes.push({
      IndexName: gsiName(slot),
      KeySchema: [
        { AttributeName: gsiPk(slot), KeyType: "HASH" as const },
        { AttributeName: gsiSk(slot), KeyType: "RANGE" as const },
      ],
      Projection: { ProjectionType: "ALL" as const },
    });
  }

  return {
    TableName: tableName,
    BillingMode: "PAY_PER_REQUEST",
    KeySchema: [
      { AttributeName: PK, KeyType: "HASH" },
      { AttributeName: SK, KeyType: "RANGE" },
    ],
    AttributeDefinitions: attributeDefinitions,
    GlobalSecondaryIndexes: globalSecondaryIndexes,
  };
}

/**
 * Create the table if it does not already exist and wait until it is active.
 * Idempotent — safe to call at startup or in test `beforeAll` hooks.
 */
export async function ensureSchema(opts: {
  client: DynamoDBClient;
  tableName: string;
  lookupSlots: number;
}): Promise<void> {
  const input = buildTableDefinition(opts.tableName, opts.lookupSlots);
  try {
    await opts.client.send(new CreateTableCommand(input));
  } catch (error) {
    if (!(error instanceof ResourceInUseException)) throw error; // already exists
  }
  await waitUntilTableExists(
    { client: opts.client, maxWaitTime: 60 },
    { TableName: opts.tableName },
  );
}

/**
 * Better Auth CLI `generate` hook: emit a portable CloudFormation template for
 * the built-in store's table. Table name and lookup-GSI count are configurable
 * (unlike a hardcoded layout), so the generated stack matches the adapter's
 * actual access patterns.
 */
export function generateSchemaFile(opts: {
  tableName: string;
  lookupSlots: number;
  file?: string;
}): { code: string; path: string; overwrite: boolean } {
  const table = buildTableDefinition(opts.tableName, opts.lookupSlots);
  const template = {
    AWSTemplateFormatVersion: "2010-09-09",
    Resources: {
      BetterAuthTable: { Type: "AWS::DynamoDB::Table", Properties: table },
    },
  };
  const code = `/**
 * Auto-generated DynamoDB CloudFormation template for @datar-platform/better-auth-dynamodb.
 * Table: ${opts.tableName} — ${opts.lookupSlots} lookup GSI(s) + 1 byType GSI.
 * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-dynamodb-table.html
 */
export const dynamoDBSchema = ${JSON.stringify(template, null, 2)} as const;

export default dynamoDBSchema;
`;
  return {
    code,
    path: opts.file ?? "dynamodb-cloudformation.ts",
    overwrite: true,
  };
}
