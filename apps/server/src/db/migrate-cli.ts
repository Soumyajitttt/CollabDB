import "dotenv/config";
import { loadConfig } from "../config";
import { createPool } from "./pool";
import { runMigrations } from "./migrate";

(async () => {
  const config = loadConfig();
  const pool = createPool(config.DATABASE_URL);
  const applied = await runMigrations(pool);
  console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Database is up to date.");
  await pool.end();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
