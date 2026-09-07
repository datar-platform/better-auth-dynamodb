import { betterAuth } from "better-auth";
import { beforeAll, describe, expect, it } from "vitest";

import type { DynamoStore, StoreItem } from "../src/index";
import { dynamoAdapter } from "../src/index";

/**
 * A minimal in-memory {@link DynamoStore}. It implements the exact same seam the
 * built-in and ElectroDB stores do, so driving a real Better Auth instance
 * through it exercises the whole generic core — planner, residual filtering,
 * pagination, and every adapter method — with no AWS dependency.
 *
 * `queryIndex` simply filters by the key field/value pairs the planner resolved,
 * which is precisely the semantics a real GSI query provides.
 */
function createMemoryStore(): DynamoStore {
  const tables = new Map<string, Map<string, StoreItem>>();
  const tbl = (m: string) => {
    if (!tables.has(m)) tables.set(m, new Map());
    return tables.get(m)!;
  };
  return {
    async put(model, item) {
      tbl(model).set(String(item.id), { ...item });
      return item;
    },
    async getById(model, id) {
      return tbl(model).get(id) ?? null;
    },
    async update(model, id, patch) {
      const cur = tbl(model).get(id);
      if (!cur) return null;
      const next = { ...cur, ...patch };
      tbl(model).set(id, next);
      return next;
    },
    async deleteById(model, id) {
      tbl(model).delete(id);
    },
    async queryIndex({ model, key }) {
      const items = [...tbl(model).values()].filter((it) =>
        Object.entries(key).every(([k, v]) => it[k] === v),
      );
      return { items };
    },
    async listByType({ model }) {
      return { items: [...tbl(model).values()] };
    },
  };
}

describe("dynamoAdapter — end-to-end via Better Auth (in-memory store)", () => {
  const store = createMemoryStore();
  const auth = betterAuth({
    secret: "better-auth-dynamodb-test-secret-0123456789",
    baseURL: "http://localhost:3000",
    emailAndPassword: { enabled: true },
    // indexMap auto-derived from schema. `unsafeAllowScan` is on because this
    // suite deliberately exercises predicates no index can serve (e.g.
    // `identifier starts_with`) to pin the residual-filtering contract;
    // production defaults still reject those shapes.
    database: dynamoAdapter({ store, unsafeAllowScan: true }),
  });

  const email = "ada@example.com";
  const password = "Password123!";
  let userId: string;

  it("signs up (adapter.create for user + account)", async () => {
    const res = await auth.api.signUpEmail({
      body: { email, password, name: "Ada Lovelace" },
    });
    expect(res.user.email).toBe(email);
    userId = res.user.id;
  });

  it("signs in (adapter.findOne by email + account, session create)", async () => {
    const res = await auth.api.signInEmail({ body: { email, password } });
    expect(res.token).toBeTruthy();
    expect(res.user.id).toBe(userId);
  });

  describe("direct adapter CRUD (full method contract)", () => {
    let adapter: Awaited<typeof auth.$context>["adapter"];

    beforeAll(async () => {
      adapter = (await auth.$context).adapter;
    });

    it("create + findOne by a derived unique index", async () => {
      const created = await adapter.create<{
        id: string;
        identifier: string;
        value: string;
        expiresAt: Date;
      }>({
        model: "verification",
        data: {
          identifier: "verify-1",
          value: "code-1",
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      expect(created.id).toBeTruthy();

      const found = await adapter.findOne<{ id: string }>({
        model: "verification",
        where: [
          {
            field: "identifier",
            value: "verify-1",
            operator: "eq",
            connector: "AND",
          },
        ],
      });
      expect(found?.id).toBe(created.id);
    });

    it("findMany with sort + limit and count agree", async () => {
      for (let i = 0; i < 3; i++) {
        await adapter.create({
          model: "verification",
          data: {
            identifier: `bulk-${i}`,
            value: `v-${i}`,
            expiresAt: new Date(Date.now() + 60_000),
          } as any,
        });
      }
      const many = await adapter.findMany<{ identifier: string }>({
        model: "verification",
        where: [
          {
            field: "identifier",
            value: "bulk-",
            operator: "starts_with",
            connector: "AND",
          },
        ],
        sortBy: { field: "identifier", direction: "asc" },
        limit: 2,
      });
      expect(many.map((m) => m.identifier)).toEqual(["bulk-0", "bulk-1"]);

      const total = await adapter.count({
        model: "verification",
        where: [
          {
            field: "identifier",
            value: "bulk-",
            operator: "starts_with",
            connector: "AND",
          },
        ],
      });
      expect(total).toBe(3);
    });

    it("update returns the patched row", async () => {
      const updated = await adapter.update<{ name: string }>({
        model: "user",
        where: [
          { field: "id", value: userId, operator: "eq", connector: "AND" },
        ],
        update: { name: "Ada L." },
      });
      expect(updated?.name).toBe("Ada L.");
    });

    it("updateMany and deleteMany return affected counts", async () => {
      const changed = await adapter.updateMany({
        model: "verification",
        where: [
          {
            field: "identifier",
            value: "bulk-",
            operator: "starts_with",
            connector: "AND",
          },
        ],
        update: { value: "touched" },
      });
      expect(changed).toBe(3);

      const removed = await adapter.deleteMany({
        model: "verification",
        where: [
          {
            field: "identifier",
            value: "bulk-",
            operator: "starts_with",
            connector: "AND",
          },
        ],
      });
      expect(removed).toBe(3);

      const after = await adapter.count({
        model: "verification",
        where: [
          {
            field: "identifier",
            value: "bulk-",
            operator: "starts_with",
            connector: "AND",
          },
        ],
      });
      expect(after).toBe(0);
    });

    it("delete removes a single row", async () => {
      await adapter.delete({
        model: "verification",
        where: [
          {
            field: "identifier",
            value: "verify-1",
            operator: "eq",
            connector: "AND",
          },
        ],
      });
      const gone = await adapter.findOne({
        model: "verification",
        where: [
          {
            field: "identifier",
            value: "verify-1",
            operator: "eq",
            connector: "AND",
          },
        ],
      });
      expect(gone).toBeNull();
    });
  });
});
