import { DynamoDBClient, ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from "testcontainers";

/**
 * AWS's own DynamoDB Local, started per test run via Testcontainers.
 *
 * Preferred over LocalStack here because it is the same engine AWS ships for
 * offline development, and over a docker-compose file because the container
 * lifecycle belongs to the test process — no port collisions between parallel
 * runs, no stale container surviving a crashed suite, nothing to start by hand
 * before `pnpm test:integration`.
 */
const IMAGE = "amazon/dynamodb-local:2.6.1";
const PORT = 8000;
export const REGION = "us-east-1";

export interface DynamoLocal {
  client: DynamoDBClient;
  documentClient: DynamoDBDocumentClient;
  endpoint: string;
  stop(): Promise<void>;
}

export async function startDynamoLocal(): Promise<DynamoLocal> {
  const container: StartedTestContainer = await new GenericContainer(IMAGE)
    .withExposedPorts(PORT)
    .withCommand([
      "-jar",
      "DynamoDBLocal.jar",
      "-inMemory",
      "-sharedDb",
      "-disableTelemetry",
    ])
    .withWaitStrategy(Wait.forListeningPorts())
    .start();

  const endpoint = `http://${container.getHost()}:${container.getMappedPort(PORT)}`;
  const client = new DynamoDBClient({
    region: REGION,
    endpoint,
    credentials: { accessKeyId: "fake", secretAccessKey: "fake" },
  });
  const documentClient = DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
  });

  // The port is open before the Java process is ready to serve.
  await waitUntilServing(client);

  return {
    client,
    documentClient,
    endpoint,
    stop: async () => {
      client.destroy();
      await container.stop();
    },
  };
}

async function waitUntilServing(client: DynamoDBClient): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await client.send(new ListTablesCommand({}));
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  // One last attempt, so the failure carries the real AWS error.
  await client.send(new ListTablesCommand({}));
}
