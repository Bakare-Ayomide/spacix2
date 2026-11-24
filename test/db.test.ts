import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mysqlConfigFromEnv, type QueryExecutor } from "../server/db/client.ts";
import { DatabaseStore } from "../server/db/repositories.ts";

test("MySQL schema defines all required tables for users, projects, generations, media, and credits", () => {
  const sql = readFileSync(new URL("../server/db/schema.sql", import.meta.url), "utf8");
  for (const table of [
    "users",
    "projects",
    "generation_records",
    "media_assets",
    "credit_balances",
    "credit_transactions",
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`), `missing ${table} table`);
  }
});

test("mysqlConfigFromEnv parses DATABASE_URL, discrete MYSQL_* vars, or returns null when unconfigured", () => {
  assert.equal(mysqlConfigFromEnv({}), null);

  const fromUrl = mysqlConfigFromEnv({ DATABASE_URL: "mysql://spacix_user:s3cr3t@db.internal:3307/spacix_prod?ssl=true" });
  assert.equal(fromUrl?.host, "db.internal");
  assert.equal(fromUrl?.port, 3307);
  assert.equal(fromUrl?.user, "spacix_user");
  assert.equal(fromUrl?.password, "s3cr3t");
  assert.equal(fromUrl?.database, "spacix_prod");
  assert.ok(fromUrl?.ssl);

  const fromParts = mysqlConfigFromEnv({
    MYSQL_HOST: "10.0.0.5",
    MYSQL_PORT: "3306",
    MYSQL_USER: "app",
    MYSQL_PASSWORD: "pw",
    MYSQL_DATABASE: "studio",
  });
  assert.equal(fromParts?.host, "10.0.0.5");
  assert.equal(fromParts?.database, "studio");
});

test("DatabaseStore uses parameterized queries for generation syncing and enforces credit balances", async () => {
  const executed: { sql: string; params: unknown[] }[] = [];
  let balance = 10;

  const mockExec: QueryExecutor = {
    async execute<T = unknown>(sql: string, params: unknown[] = []): Promise<[T, unknown]> {
      executed.push({ sql, params });
      if (sql.startsWith("SELECT id, visitor_key")) {
        return ([[{ id: "usr_local_owner", visitor_key: "local-owner", email: null, display_name: "Studio Owner" }], []] as unknown) as [T, unknown];
      }
      if (sql.startsWith("SELECT balance FROM credit_balances")) {
        return ([[{ balance }], []] as unknown) as [T, unknown];
      }
      if (sql.startsWith("UPDATE credit_balances SET balance = ?")) {
        balance = Number(params[0]);
      }
      return ([[] as unknown, []] as unknown) as [T, unknown];
    },
  };

  const store = new DatabaseStore(mockExec);
  await store.syncGeneration({
    id: "20261124-080000000-abcd",
    app: "z-image",
    status: "succeeded",
    job: "req-1",
    provider: "fal",
    provider_endpoint: "fal-ai/flux/schnell",
    created: "2026-11-24T08:00:00.000Z",
    started: "2026-11-24T08:00:01.000Z",
    finished: "2026-11-24T08:00:04.000Z",
    seconds: 3,
    total: 4,
    values: { prompt: "a blue comet" },
    preset: null,
    inputs: [{ id: "image", type: "image", file: "input-image.png", name: "me.png" }],
    outputs: [{ file: "out-01.png", type: "image", name: "out.png", node: "out", url: "https://v3.fal.media/files/out.png" }],
    error: null,
  });

  const genInsert = executed.find((q) => q.sql.includes("INSERT INTO generation_records"));
  assert.ok(genInsert);
  assert.ok(!genInsert.sql.includes("a blue comet"), "prompt value must be parameterized, never interpolated into SQL");
  assert.equal(genInsert.params[0], "20261124-080000000-abcd");
  assert.ok(executed.some((q) => q.sql.includes("INSERT IGNORE INTO media_assets")));
  assert.ok(executed.some((q) => q.sql.includes("INSERT INTO media_assets")));

  const afterDebit = await store.recordCreditTransaction({
    userId: "usr_local_owner",
    delta: -4,
    reason: "generation:z-image",
    generationId: "20261124-080000000-abcd",
  });
  assert.equal(afterDebit.balance, 6);

  await assert.rejects(() => store.recordCreditTransaction({
    userId: "usr_local_owner",
    delta: -20,
    reason: "generation:video",
  }), /Insufficient credit balance/);
});
