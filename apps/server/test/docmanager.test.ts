import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { DocManager } from "../src/docs/DocManager";
import type { RunningServer } from "../src/server";
import { canon, createDoc, createUser, dbAvailable, start } from "./helpers";

const available = await dbAvailable();

const edit = (fn: (d: Y.Doc) => void) => {
  const d = new Y.Doc();
  let u!: Uint8Array;
  d.on("update", (x: Uint8Array) => (u = x));
  fn(d);
  return u;
};
const setKey = (k: string, v: string) => edit((d) => d.getMap("m").set(k, v));
const count = async (s: RunningServer, docId: string) =>
  Number((await s.pool.query("SELECT count(*) FROM updates WHERE doc_id = $1", [docId])).rows[0].count);

describe.skipIf(!available)("DocManager", () => {
  let server: RunningServer;
  let userId: string;
  beforeAll(async () => {
    server = await start();
    userId = (await createUser(server)).id;
  });
  afterAll(async () => { await server.close(); });

  const manager = (over = {}) => new DocManager(server.pool, { flushMs: 10, evictAfterMs: 60_000, retryMs: 20, ...over });

  it("merges updates inside the batch window into ONE row", async () => {
    const docId = await createDoc(server, userId);
    const dm = manager();
    const md = await dm.acquire(docId);
    const acks: number[] = [];
    for (let i = 0; i < 5; i++) dm.applyUpdate(md, setKey(`k${i}`, "v"), userId, () => acks.push(i));
    await dm.flush(md);
    expect(await count(server, docId)).toBe(1);
    expect(acks).toHaveLength(5); // every client still gets its ack
    await dm.shutdown();
  });

  it("assigns increasing seq and a restart (fresh manager) restores the exact state", async () => {
    const docId = await createDoc(server, userId);
    const dm1 = manager();
    const md1 = await dm1.acquire(docId);
    for (let i = 0; i < 3; i++) {
      dm1.applyUpdate(md1, setKey(`k${i}`, `v${i}`), userId, () => {});
      await dm1.flush(md1);
    }
    const seqs = (await server.pool.query("SELECT seq FROM updates WHERE doc_id = $1 ORDER BY seq", [docId])).rows.map((r) => Number(r.seq));
    expect(seqs).toEqual([1, 2, 3]);
    const before = canon(md1.doc.getMap("m").toJSON());
    expect(JSON.parse(before)).toEqual({ k0: "v0", k1: "v1", k2: "v2" });

    const dm2 = manager(); // simulates a server restart: nothing in memory
    const md2 = await dm2.acquire(docId);
    expect(canon(md2.doc.getMap("m").toJSON())).toBe(before);
    expect(md2.seq).toBe(3);
    dm2.applyUpdate(md2, setKey("after", "restart"), userId, () => {});
    await dm2.flush(md2);
    expect((await server.pool.query("SELECT max(seq) m FROM updates WHERE doc_id = $1", [docId])).rows[0].m).toBe("4");
    await dm1.shutdown();
    await dm2.shutdown();
  });

  it("does not store or re-broadcast a duplicate update, but still acks it", async () => {
    const docId = await createDoc(server, userId);
    const dm = manager();
    const md = await dm.acquire(docId);
    const u = setKey("a", "1");
    expect(dm.applyUpdate(md, u, userId, () => {})).toBe(true);
    await dm.flush(md);
    let acked = false;
    expect(dm.applyUpdate(md, u, userId, () => (acked = true))).toBe(false);
    expect(acked).toBe(true);
    await dm.flush(md);
    expect(await count(server, docId)).toBe(1);
    await dm.shutdown();
  });

  it("loads latest snapshot + only the updates after it", async () => {
    const docId = await createDoc(server, userId);
    const base = edit((d) => d.getMap("m").set("fromSnapshot", 1));
    const snapState = Y.encodeStateAsUpdate((() => { const d = new Y.Doc(); Y.applyUpdate(d, base); return d; })());
    await server.pool.query("INSERT INTO snapshots (doc_id, state, up_to_seq) VALUES ($1, $2, 5)", [docId, Buffer.from(snapState)]);
    // seq 3 is already folded into the snapshot (would double-apply harmlessly); seq 6 is newer.
    await server.pool.query("INSERT INTO updates (doc_id, seq, update) VALUES ($1, 6, $2)", [docId, Buffer.from(setKey("newer", "yes"))]);
    const dm = manager();
    const md = await dm.acquire(docId);
    expect(md.doc.getMap("m").toJSON()).toEqual({ fromSnapshot: 1, newer: "yes" });
    expect(md.seq).toBe(6);
    await dm.shutdown();
  });

  it("evicts an idle doc after the timeout but keeps it while someone is connected", async () => {
    const docId = await createDoc(server, userId);
    const dm = manager({ evictAfterMs: 40 });
    await dm.acquire(docId);
    await dm.acquire(docId);
    dm.release(docId);
    await new Promise((r) => setTimeout(r, 120));
    expect(dm.activeDocs).toBe(1); // one client left
    dm.release(docId);
    await new Promise((r) => setTimeout(r, 120));
    expect(dm.activeDocs).toBe(0);
  });

  it("concurrent acquires load the doc once", async () => {
    const docId = await createDoc(server, userId);
    const dm = manager();
    const [a, b] = await Promise.all([dm.acquire(docId), dm.acquire(docId)]);
    expect(a).toBe(b);
    expect(a.clients).toBe(2);
    await dm.shutdown();
  });

  it("keeps the update in memory and retries when the INSERT fails, acking only after it lands", async () => {
    const docId = await createDoc(server, userId);
    let failures = 2;
    const flaky = new Proxy(server.pool, {
      get(t, p, r) {
        if (p === "query") {
          return (sql: unknown, ...rest: unknown[]) =>
            typeof sql === "string" && sql.startsWith("INSERT INTO updates") && failures-- > 0
              ? Promise.reject(new Error("connection lost"))
              : (t.query as (...a: unknown[]) => unknown)(sql, ...rest);
        }
        return Reflect.get(t, p, r);
      },
    });
    const dm = new DocManager(flaky, { flushMs: 5, evictAfterMs: 60_000, retryMs: 20 });
    const md = await dm.acquire(docId);
    let acked = false;
    dm.applyUpdate(md, setKey("x", "1"), userId, () => (acked = true));
    await new Promise((r) => setTimeout(r, 15));
    expect(acked).toBe(false); // first attempt failed, no ack yet
    await new Promise((r) => setTimeout(r, 400));
    expect(acked).toBe(true);
    expect(await count(server, docId)).toBe(1);
    await dm.shutdown();
  });
});
