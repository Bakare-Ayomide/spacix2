// MySQL / MariaDB connection pool and versioned SQL migration runner using mysql2/promise.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import mysql, { type Pool, type PoolConnection, type PoolOptions } from "mysql2/promise";

export type DbStatus = {
  configured: boolean;
  connected: boolean;
  engine: "mysql" | "local-fallback";
  host: string | null;
  database: string | null;
  error: string | null;
};

export interface QueryExecutor {
  execute<T = unknown>(sql: string, params?: unknown[]): Promise<[T, unknown]>;
}

export function mysqlConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PoolOptions | null {
  const url = env.DATABASE_URL?.trim();
  if (url) {
    const parsed = new URL(url);
    return {
      host: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : 3306,
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
      database: parsed.pathname.replace(/^\//, "") || "spacix",
      waitForConnections: true,
      connectionLimit: 10,
      ...(env.MYSQL_SSL === "true" || parsed.searchParams.get("ssl") === "true" ? { ssl: {} } : {}),
    };
  }
  const host = env.MYSQL_HOST?.trim();
  if (!host) return null;
  return {
    host,
    port: Number(env.MYSQL_PORT || 3306),
    user: env.MYSQL_USER || "root",
    password: env.MYSQL_PASSWORD || "",
    database: env.MYSQL_DATABASE || "spacix",
    waitForConnections: true,
    connectionLimit: 10,
    ...(env.MYSQL_SSL === "true" ? { ssl: {} } : {}),
  };
}

export class MySqlClient implements QueryExecutor {
  readonly configured: boolean;
  readonly host: string | null;
  readonly database: string | null;
  private pool: Pool | null;
  private lastError: string | null = null;
  private connected = false;

  constructor(opts: PoolOptions | null = mysqlConfigFromEnv()) {
    this.configured = Boolean(opts);
    this.host = opts?.host ?? null;
    this.database = opts?.database ?? null;
    this.pool = opts ? mysql.createPool(opts) : null;
  }

  async execute<T = unknown>(sql: string, params: unknown[] = []): Promise<[T, unknown]> {
    if (!this.pool) throw new Error("MySQL database is not configured.");
    return this.pool.execute(sql, params as never) as Promise<[T, unknown]>;
  }

  async withTransaction<T>(fn: (conn: QueryExecutor) => Promise<T>): Promise<T> {
    if (!this.pool) throw new Error("MySQL database is not configured.");
    const conn: PoolConnection = await this.pool.getConnection();
    await conn.beginTransaction();
    const q: QueryExecutor = {
      execute: <R = unknown>(sql: string, params: unknown[] = []) =>
        conn.execute(sql, params as never) as Promise<[R, unknown]>,
    };
    try {
      const result = await fn(q);
      await conn.commit();
      return result;
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    } finally {
      conn.release();
    }
  }

  async migrate(): Promise<{ applied: string[] }> {
    if (!this.pool) return { applied: [] };
    const dir = dirname(fileURLToPath(import.meta.url));
    const migDir = join(dir, "migrations");

    // Ensure migration history table exists first
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(64) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    const [rows] = await this.pool.query("SELECT version FROM schema_migrations");
    const done = new Set((Array.isArray(rows) ? rows : []).map((r: unknown) => String((r as { version: string }).version)));

    const files = readdirSync(migDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    const applied: string[] = [];
    for (const file of files) {
      const version = file.split("_")[0] || file;
      if (done.has(version)) continue;
      const sql = readFileSync(join(migDir, file), "utf-8");
      const statements = sql
        .split(/;\s*(?:\r?\n|$)/)
        .map((s) =>
          s
            .split(/\r?\n/)
            .filter((line) => !line.trim().startsWith("--"))
            .join("\n")
            .trim(),
        )
        .filter(Boolean);
      for (const stmt of statements) {
        await this.pool.query(stmt);
      }
      await this.pool.execute("INSERT IGNORE INTO schema_migrations (version, name) VALUES (?, ?)", [version, file]);
      applied.push(file);
    }

    this.connected = true;
    this.lastError = null;
    return { applied };
  }

  async ping(): Promise<DbStatus> {
    if (!this.pool) {
      return {
        configured: false,
        connected: false,
        engine: "local-fallback",
        host: null,
        database: null,
        error: "MYSQL_HOST / DATABASE_URL not configured; using persistent local platform store.",
      };
    }
    try {
      await this.pool.query("SELECT 1");
      this.connected = true;
      this.lastError = null;
    } catch (err) {
      this.connected = false;
      this.lastError = (err as Error).message;
    }
    return {
      configured: true,
      connected: this.connected,
      engine: this.connected ? "mysql" : "local-fallback",
      host: this.host,
      database: this.database,
      error: this.lastError,
    };
  }

  status(): DbStatus {
    return {
      configured: this.configured,
      connected: this.connected,
      engine: this.connected ? "mysql" : "local-fallback",
      host: this.host,
      database: this.database,
      error: this.lastError,
    };
  }

  async close(): Promise<void> {
    await this.pool?.end();
    this.pool = null;
  }
}
