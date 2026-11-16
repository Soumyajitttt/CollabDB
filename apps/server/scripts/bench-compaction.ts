/**
 * Compaction before/after for a long editing session (default 50,000 updates).
 * Reports rows in `updates`, bytes stored, and how long a fresh server takes to load the document.
 *   npm run bench:compaction        (BENCH_UPDATES=10000 for a quicker run)
 */
import "dotenv/config";
import { performance } from "node:perf_hooks";
import * as Y from "yjs";
import { loadConfig } from "../src/config";
import { createPool } from "../src/db/pool";
import { runMigrations } from "../src/db/migrate";
import { DocManager } from "../src/docs/DocManager";

const N = Number(process.env.BENCH_UPDATES ?? 50_000);
// Measuring managers must never compact on their own, or "before" would not be "before".
const NEVER = { flushMs: 5, evictAfterMs: 60_000, compactEvery: 1e9, compactIntervalMs: 3.6e9 };
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

(async () => {
  const config = loadConfig();
  const pool = createPool(config.DATABASE_URL);
  await runMigrations(pool);
  const userId = (await pool.query("INSERT INTO users (email, password_hash, name) VALUES ($1, 'x', 'bench') RETURNING id", [`bench-${Date.now()}@bench.dev`])).rows[0].id as string;
  const docId = (await pool.query("INSERT INTO documents (name, owner_id) VALUES ('bench', $1) RETURNING id", [userId])).rows[0].id as string;
  await pool.query("INSERT INTO document_members VALUES ($1, $2, 'owner')", [docId, userId]);

  // 1. A long session: a table of 200 rows x 5 columns, then N small edits, one update each.
  const gen = new Y.Doc();
  const updates: Uint8Array[] = [];
  gen.on("update", (u: Uint8Array) => updates.push(u));
  const rows = gen.getMap<Y.Map<unknown>>("rows");
  gen.transact(() => {
    for (let r = 0; r < 200; r++) {
      const row = new Y.Map<unknown>();
      row.set("_order", `a${String(r).padStart(4, "0")}`);
      row.set("notes", new Y.Text());
      rows.set(`row${r}`, row);
    }
  });
  for (let i = updates.length; i < N; i++) {
    const row = rows.get(`row${(i * 7) % 200}`)!;
    if (i % 5 === 0) {
      const t = row.get("notes") as Y.Text;
      t.insert(t.length, "x");
    } else {
      row.set(`c${i % 4}`, i);
    }
  }
  const seqs = updates.map((_, i) => i + 1);
  for (let i = 0; i < updates.length; i += 2000) {
    await pool.query("INSERT INTO updates (doc_id, seq, update) SELECT $1, * FROM unnest($2::bigint[], $3::bytea[])", [
      docId, seqs.slice(i, i + 2000), updates.slice(i, i + 2000).map((u) => Buffer.from(u)),
    ]);
  }

  const measure = async () => {
    const stat = (await pool.query(
      `SELECT (SELECT count(*) FROM updates WHERE doc_id=$1) AS rows,
              (SELECT COALESCE(sum(length(update)),0) FROM updates WHERE doc_id=$1) AS ubytes,
              (SELECT COALESCE(sum(length(state)),0) FROM snapshots WHERE doc_id=$1) AS sbytes`, [docId])).rows[0];
    const times: number[] = [];
    for (let i = 0; i < 3; i++) {
      const dm = new DocManager(pool, NEVER);
      const t = performance.now();
      await dm.acquire(docId);
      times.push(performance.now() - t);
      await dm.shutdown();
    }
    return { rows: Number(stat.rows), bytes: Number(stat.ubytes) + Number(stat.sbytes), loadMs: median(times) };
  };

  const before = await measure();

  // 2. Compact, using the same code the server runs.
  const dm = new DocManager(pool, NEVER);
  const md = await dm.acquire(docId);
  const t0 = performance.now();
  await dm.compact(md);
  const compactMs = performance.now() - t0;
  await dm.shutdown();

  const after = await measure();
  const fmt = (b: number) => (b / 1024).toFixed(0) + " KiB";
  console.log(`\nCompaction after a ${updates.length.toLocaleString()}-update session\n`);
  console.log(`                        before         after`);
  console.log(`rows in updates   ${String(before.rows).padStart(12)} ${String(after.rows).padStart(13)}`);
  console.log(`bytes stored      ${fmt(before.bytes).padStart(12)} ${fmt(after.bytes).padStart(13)}`);
  console.log(`load time (median of 3) ${before.loadMs.toFixed(0).padStart(5)} ms ${after.loadMs.toFixed(0).padStart(8)} ms`);
  console.log(`\ncompaction itself took ${compactMs.toFixed(0)} ms\n`);

  await pool.query("DELETE FROM documents WHERE id = $1", [docId]);
  await pool.query("DELETE FROM users WHERE id = $1", [userId]);
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
