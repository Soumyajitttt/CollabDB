import { Client } from "pg";
import * as Y from "yjs";
import { SyncProvider, type SyncProviderOptions } from "@collab/sync";
import { signAccessToken } from "@collab/shared";
import { randomUUID } from "node:crypto";
import { loadConfig, type Config } from "../src/config";
import { startServer, type RunningServer } from "../src/server";

export const DB_URL = process.env.DATABASE_URL ?? "postgres://collab:collab@localhost:5432/collabdb";
export const SECRET = "test-secret-test-secret-test-secret-123";

/** True when Postgres answers. CI sets REQUIRE_DB=1 so a missing DB fails instead of skipping. */
export async function dbAvailable(): Promise<boolean> {
  const c = new Client({ connectionString: DB_URL, connectionTimeoutMillis: 1500 });
  try {
    await c.connect();
    await c.end();
    return true;
  } catch {
    if (process.env.REQUIRE_DB) throw new Error(`REQUIRE_DB is set but Postgres is not reachable at ${DB_URL}`);
    console.warn(`\n[tests] Postgres not reachable at ${DB_URL}: skipping DB tests. Run "npm run db:up" first.\n`);
    return false;
  }
}

export function testConfig(over: Record<string, string> = {}): Config {
  return loadConfig({
    DATABASE_URL: DB_URL, JWT_SECRET: SECRET, PORT: "0", BCRYPT_COST: "4",
    FLUSH_MS: "5", EVICT_AFTER_MS: "60000", ...over,
  });
}

export const start = (over: Record<string, string> = {}): Promise<RunningServer> => startServer(testConfig(over));

export const uniqueEmail = () => `u-${randomUUID()}@test.dev`;

export async function createUser(server: RunningServer, name = "Tester") {
  const { rows } = await server.pool.query(
    "INSERT INTO users (email, password_hash, name) VALUES ($1, 'x', $2) RETURNING id",
    [uniqueEmail(), name],
  );
  const id = rows[0].id as string;
  return { id, token: await signAccessToken(SECRET, { sub: id }) };
}

export async function createDoc(server: RunningServer, ownerId: string, members: [string, "editor" | "viewer"][] = []) {
  const { rows } = await server.pool.query("INSERT INTO documents (name, owner_id) VALUES ('t', $1) RETURNING id", [ownerId]);
  const docId = rows[0].id as string;
  await server.pool.query("INSERT INTO document_members VALUES ($1, $2, 'owner')", [docId, ownerId]);
  for (const [uid, role] of members) await server.pool.query("INSERT INTO document_members VALUES ($1, $2, $3)", [docId, uid, role]);
  return docId;
}

export function connect(server: RunningServer, token: string, docId: string, extra: Partial<SyncProviderOptions> = {}) {
  const doc = new Y.Doc();
  const provider = new SyncProvider(doc, {
    url: server.url, docId, getToken: async () => token, batchMs: 5, reconnectMinMs: 50, reconnectMaxMs: 300, ...extra,
  });
  return { doc, provider };
}

export async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 8000, what = "condition") {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

export const synced = (p: SyncProvider) => p.getState().status === "synced";
export const sv = (d: Y.Doc) => Buffer.from(Y.encodeStateVector(d)).toString("hex");
/** Canonical JSON: Y.Map iteration order differs between clients, the content must not. */
const sortKeys = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(sortKeys)
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, sortKeys(x)]))
  : v;
export const canon = (v: unknown) => JSON.stringify(sortKeys(v));
export const json = (d: Y.Doc) => canon(d.toJSON());
/** Named root types only. A doc freshly loaded from the DB has no root types registered until asked. */
export const snap = (d: Y.Doc, roots: string[] = ["rows", "columns"]) =>
  canon(Object.fromEntries(roots.map((r) => [r, d.getMap(r).toJSON()])));

/** Deterministic PRNG so fuzz failures are reproducible from the seed. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
