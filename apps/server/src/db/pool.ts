import { Pool } from "pg";

export function createPool(databaseUrl: string) {
  const pool = new Pool({ connectionString: databaseUrl, max: 10 });
  // An idle client erroring must not crash the process.
  pool.on("error", (err) => console.error("pg pool error:", err.message));
  return pool;
}
export type { Pool };
