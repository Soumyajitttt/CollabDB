import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { DocManager } from "../src/docs/DocManager";
import type { RunningServer } from "../src/server";
import { canon, connect, createDoc, createUser, dbAvailable, start, synced, waitFor } from "./helpers";

const available = await dbAvailable();

const edit = (fn: (d: Y.Doc) => void) => {
  const d = new Y.Doc();
  let u!: Uint8Array;
  d.on("update", (x: Uint8Array) => (u = x));
  fn(d);
  return u;
};
const setKey = (k: string, v: string) => edit((d) => d.getMap("m").set(k, v));

describe.skipIf(!available)("snapshots and compaction", () => {
  let server: RunningServer;
  let userId: string;
  beforeAll(async () => {
    server = await start();
    userId = (await createUser(server)).id;
  });
  afterAll(async () => { await server.close(); });

  const manager = (over = {}) => new DocManager(server.pool, { flushMs: 5, evictAfterMs: 60_000, compactEvery: 100000, compactIntervalMs: 3_600_000, ...over });
  const rows = async (docId: string) => Number((await server.pool.query("SELECT count(*) FROM updates WHERE doc_id=$1", [docId])).rows[0].count);
  const snaps = async (docId: string) => (await server.pool.query("SELECT up_to_seq, is_auto FROM snapshots WHERE doc_id=$1 ORDER BY up_to_seq", [docId])).rows;
  const writeN = async (dm: DocManager, md: Awaited<ReturnType<DocManager["acquire"]>>, n: number, prefix = "k") => {
    for (let i = 0; i < n; i++) {
      dm.applyUpdate(md, setKey(`${prefix}${i}`, `v${i}`), userId, () => {});
      await dm.flush(md);
    }
  };
  const mapOf = (md: { doc: Y.Doc }) => canon(md.doc.getMap("m").toJSON());

  it("folds all update rows into one snapshot and a new client loads the same state", async () => {
    const docId = await createDoc(server, userId);
    const dm = manager();
    const md = await dm.acquire(docId);
    await writeN(dm, md, 12);
    expect(await rows(docId)).toBe(12);
    const before = mapOf(md);

    await dm.compact(md);
    expect(await rows(docId)).toBe(0);
    expect(await snaps(docId)).toEqual([{ up_to_seq: "12", is_auto: true }]);

    const fresh = manager();
    const md2 = await fresh.acquire(docId);
    expect(mapOf(md2)).toBe(before);
    expect(md2.seq).toBe(12);
    await dm.shutdown(); await fresh.shutdown();
  });

  it("loads snapshot + the updates written after it", async () => {
    const docId = await createDoc(server, userId);
    const dm = manager();
    const md = await dm.acquire(docId);
    await writeN(dm, md, 5);
    await dm.compact(md);
    await writeN(dm, md, 3, "after");
    expect(await rows(docId)).toBe(3);
    const seqs = (await server.pool.query("SELECT seq FROM updates WHERE doc_id=$1 ORDER BY seq", [docId])).rows.map((r) => Number(r.seq));
    expect(seqs).toEqual([6, 7, 8]); // numbering continues past the snapshot

    const fresh = manager();
    const md2 = await fresh.acquire(docId);
    expect(Object.keys(md2.doc.getMap("m").toJSON()).length).toBe(8);
    expect(mapOf(md2)).toBe(mapOf(md));
    await dm.shutdown(); await fresh.shutdown();
  });

  it("keeps only the newest automatic snapshot but never touches manual ones", async () => {
    const docId = await createDoc(server, userId);
    await server.pool.query("INSERT INTO snapshots (doc_id, state, up_to_seq, is_auto, label) VALUES ($1, $2, 0, false, 'v1')", [docId, Buffer.from(Y.encodeStateAsUpdate(new Y.Doc()))]);
    const dm = manager();
    const md = await dm.acquire(docId);
    await writeN(dm, md, 2);
    await dm.compact(md);
    await writeN(dm, md, 2, "b");
    await dm.compact(md);
    const s = await snaps(docId);
    expect(s.filter((x) => x.is_auto)).toEqual([{ up_to_seq: "4", is_auto: true }]);
    expect(s.filter((x) => !x.is_auto)).toHaveLength(1);
    await dm.shutdown();
  });

  it("compacts by itself once enough rows pile up", async () => {
    const docId = await createDoc(server, userId);
    const dm = manager({ compactEvery: 5 });
    const md = await dm.acquire(docId);
    await writeN(dm, md, 6);
    expect((await snaps(docId)).length).toBe(1);
    expect(await rows(docId)).toBeLessThan(5);
    await dm.shutdown();
  });

  it("compacts when the last client leaves and the doc is evicted", async () => {
    const docId = await createDoc(server, userId);
    const dm = manager({ evictAfterMs: 30 });
    const md = await dm.acquire(docId);
    await writeN(dm, md, 4);
    dm.release(docId);
    await waitFor(() => dm.activeDocs === 0, 3000, "eviction");
    expect(await rows(docId)).toBe(0);
    expect((await snaps(docId)).length).toBe(1);
  });

  it("waits for another transaction's advisory lock instead of racing it", async () => {
    const docId = await createDoc(server, userId);
    const dm = manager();
    const md = await dm.acquire(docId);
    await writeN(dm, md, 3);

    const holder = await server.pool.connect();
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock(hashtext($1))", [docId]);
    let finished = false;
    const job = dm.compact(md).then(() => { finished = true; });
    await new Promise((r) => setTimeout(r, 250));
    expect(finished).toBe(false);
    expect(await rows(docId)).toBe(3); // untouched while the lock is held
    await holder.query("COMMIT");
    holder.release();
    await job;
    expect(await rows(docId)).toBe(0);
    await dm.shutdown();
  });

  it("does nothing when there is nothing to fold", async () => {
    const docId = await createDoc(server, userId);
    const dm = manager();
    const md = await dm.acquire(docId);
    await dm.compact(md);
    expect((await snaps(docId)).length).toBe(0);
    await dm.shutdown();
  });

  it("end to end: after compaction on the real server a brand-new client still gets everything", async () => {
    const s = await start({ COMPACT_EVERY_UPDATES: "4", FLUSH_MS: "5" });
    const u = await createUser(s);
    const docId = await createDoc(s, u.id);
    const a = connect(s, u.token, docId);
    await waitFor(() => synced(a.provider));
    for (let i = 0; i < 12; i++) {
      a.doc.getMap("m").set(`k${i}`, i);
      await a.provider.whenFlushed();
    }
    await waitFor(async () => Number((await s.pool.query("SELECT count(*) FROM snapshots WHERE doc_id=$1", [docId])).rows[0].count) >= 1, 5000, "automatic snapshot");
    const b = connect(s, u.token, docId);
    await waitFor(() => synced(b.provider) && b.doc.getMap("m").size === 12, 5000, "new client state");
    expect(canon(b.doc.getMap("m").toJSON())).toBe(canon(a.doc.getMap("m").toJSON()));
    a.provider.destroy(); b.provider.destroy();
    await s.close();
  });
});
