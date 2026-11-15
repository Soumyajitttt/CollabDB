/**
 * Sync latency: edit on client A -> visible on client B, and edit -> server ack.
 * Runs the server in-process, so client and server share one machine and one clock.
 *   npm run bench:latency            (BENCH_N=500 for more samples)
 */
import "dotenv/config";
import { performance } from "node:perf_hooks";
import * as Y from "yjs";
import { SyncProvider } from "@collab/sync";
import { signAccessToken } from "@collab/shared";
import { loadConfig } from "../src/config";
import { startServer } from "../src/server";

const N = Number(process.env.BENCH_N ?? 300);
const WARMUP = 20;

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
const summary = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return { p50: pct(s, 50), p95: pct(s, 95), p99: pct(s, 99), max: s[s.length - 1]! };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const config = loadConfig();
  const server = await startServer({ ...config, PORT: 0 });
  const u = (await server.pool.query("INSERT INTO users (email, password_hash, name) VALUES ($1, 'x', 'bench') RETURNING id", [`bench-${Date.now()}@bench.dev`])).rows[0].id as string;
  const docId = (await server.pool.query("INSERT INTO documents (name, owner_id) VALUES ('bench', $1) RETURNING id", [u])).rows[0].id as string;
  await server.pool.query("INSERT INTO document_members VALUES ($1, $2, 'owner')", [docId, u]);
  const token = await signAccessToken(config.JWT_SECRET, { sub: u });

  const mk = () => {
    const doc = new Y.Doc();
    return { doc, provider: new SyncProvider(doc, { url: server.url, docId, getToken: async () => token, batchMs: 0 }) };
  };
  const a = mk();
  const b = mk();
  const ready = async () => { while (a.provider.getState().status !== "synced" || b.provider.getState().status !== "synced") await sleep(5); };
  await ready();

  const visible: number[] = [];
  const acked: number[] = [];
  let waiter: (() => void) | null = null;
  b.doc.getMap("m").observe((e) => {
    if (!e.keysChanged.has("t")) return;
    visible.push(performance.now() - (b.doc.getMap("m").get("t") as number));
    waiter?.();
  });

  for (let i = 0; i < N + WARMUP; i++) {
    const arrived = new Promise<void>((r) => (waiter = r));
    const t0 = performance.now();
    a.doc.getMap("m").set("t", t0);
    await arrived;
    while (a.provider.getState().pending > 0) await sleep(0);
    acked.push(performance.now() - t0);
    await sleep(15);
  }
  visible.splice(0, WARMUP);
  acked.splice(0, WARMUP);

  const row = (label: string, xs: number[]) => {
    const s = summary(xs);
    console.log(`${label.padEnd(34)} p50 ${s.p50.toFixed(1).padStart(6)} ms   p95 ${s.p95.toFixed(1).padStart(6)} ms   p99 ${s.p99.toFixed(1).padStart(6)} ms   max ${s.max.toFixed(1).padStart(6)} ms`);
  };
  console.log(`\nSync latency over ${N} edits (same machine, client + server in one process)\n`);
  row("edit -> visible on other client", visible);
  row("edit -> server ack (persisted)", acked);
  console.log("");

  a.provider.destroy(); b.provider.destroy();
  await server.close();
  const { Pool } = await import("pg");
  const p = new Pool({ connectionString: config.DATABASE_URL });
  await p.query("DELETE FROM documents WHERE id = $1", [docId]);
  await p.query("DELETE FROM users WHERE id = $1", [u]);
  await p.end();
})().catch((e) => { console.error(e); process.exit(1); });
