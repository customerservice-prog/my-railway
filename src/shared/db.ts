import pg from "pg";
import fs from "node:fs/promises";
import path from "node:path";
import { env } from "./env.js";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: env("DATABASE_URL", "postgresql://myrailway:myrailway@localhost:5432/myrailway"),
  max: 20,
  idleTimeoutMillis: 30_000
});

export async function query<T = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<T[]> {
  const result = await pool.query(text, values);
  return result.rows as T[];
}

export async function one<T = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<T | null> {
  const rows = await query<T>(text, values);
  return rows[0] ?? null;
}

export async function ensureSchema(): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const dir = path.join(process.cwd(), "migrations");
  const names = (await fs.readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
  for (const name of names) {
    const exists = await one<{name:string}>("SELECT name FROM schema_migrations WHERE name=$1", [name]);
    if (exists) continue;
    const sql = await fs.readFile(path.join(dir, name), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations(name) VALUES($1)", [name]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
