import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { io as ioClient } from "socket.io-client";
import * as Y from "yjs";
import { EV } from "@collab/shared";
import { DocManager } from "../src/docs/DocManager";
import type { RunningServer } from "../src/server";
import { connect, createDoc, createUser, dbAvailable, json, mulberry32, snap, start, sv, synced, waitFor } from "./helpers";

const available = await dbAvailable();
type Conn = ReturnType<typeof connect>;

describe.skipIf(!available)("sync over Socket.IO + Postgres", () => {
  let server: RunningServer;
  let open: Conn[] = [];
  const track = (c: Conn) => (open.push(c), c);

  beforeAll(async () => { server = await start(); });
  afterEach(() => { open.forEach((c) => { c.provider.destroy(); c.doc.destroy(); }); open = []; });
  afterAll(async () => { await server.close(); });

  const cell = (d: Y.Doc, k: string, v?: string) => {
    const m = d.getMap("m");
    if (v !== undefined) m.set(k, v);
    return m.get(k);
  };

  it("an edit in one client shows up in the other", async () => {
    const u = await createUser(server);
    const docId = await createDoc(server, u.id);
    const a = track(connect(server, u.token, docId));
    const b = track(connect(server, u.token, docId));
    await waitFor(() => synced(a.provider) && synced(b.provider), 8000, "both synced");
    cell(a.doc, "title", "hello");
    await waitFor(() => cell(b.doc, "title") === "hello", 4000, "edit to reach B");
    expect(a.provider.getState().role).toBe("owner");
  });

  it("a late joiner receives the existing state in the handshake", async () => {
    const u = await createUser(server);
    const docId = await createDoc(server, u.id);
    const a = track(connect(server, u.token, docId));
    await waitFor(() => synced(a.provider));
    for (let i = 0; i < 20; i++) cell(a.doc, `k${i}`, `v${i}`);
    await a.provider.whenFlushed();
    const late = track(connect(server, u.token, docId));
    await waitFor(() => synced(late.provider) && late.doc.getMap("m").size === 20, 5000, "late joiner state");
    expect(json(late.doc)).toBe(json(a.doc));
  });

  it("data survives a server restart (reads back from Postgres)", async () => {
    const u = await createUser(server);
    const docId = await createDoc(server, u.id);
    const a = track(connect(server, u.token, docId));
    await waitFor(() => synced(a.provider));
    cell(a.doc, "persist", "me");
    await a.provider.whenFlushed();
    // Simulate "kill and restart": a brand-new manager with an empty memory loads from the DB.
    const fresh = new DocManager(server.pool, { flushMs: 5, evictAfterMs: 60_000 });
    const md = await fresh.acquire(docId);
    expect(md.doc.getMap("m").get("persist")).toBe("me");
    await fresh.shutdown();
  });

  it("a real stop/start of the server keeps the doc and clients reconnect and re-sync", async () => {
    const s1 = await start({ PORT: "0" });
    const u = await createUser(s1);
    const docId = await createDoc(s1, u.id);
    const a = connect(s1, u.token, docId);
    await waitFor(() => synced(a.provider));
    cell(a.doc, "before", "restart");
    await a.provider.whenFlushed();
    const port = s1.port;
    a.provider.pause();
    await s1.close();

    cell(a.doc, "while", "down"); // edited while the server is gone
    const s2 = await start({ PORT: String(port) });
    a.provider.resume();
    await waitFor(() => synced(a.provider), 8000, "reconnect to restarted server");
    await a.provider.whenFlushed();
    const b = connect(s2, u.token, docId);
    await waitFor(() => synced(b.provider) && b.doc.getMap("m").size === 2, 5000, "B sees both edits");
    expect(json(b.doc)).toBe(json(a.doc));
    a.provider.destroy(); b.provider.destroy();
    await s2.close();
  });

  it("retries the join when the database is briefly unreachable (e.g. page reloaded while offline)", async () => {
    const u = await createUser(server);
    const docId = await createDoc(server, u.id);
    const pool = server.pool as unknown as { query: (...a: unknown[]) => Promise<unknown> };
    const real = pool.query.bind(server.pool);
    let failures = 2; // the first two membership lookups fail, like Neon being unreachable
    pool.query = (...a: unknown[]) => (failures-- > 0 ? Promise.reject(new Error("db unreachable")) : real(...a));
    try {
      const a = track(connect(server, u.token, docId));
      await waitFor(() => synced(a.provider), 6000, "join retried until the DB answered");
      expect(a.provider.getState().role).toBe("owner");
      expect(a.provider.getState().lastError).toBeNull();
    } finally {
      pool.query = real;
    }
  });

  it("offline edits to the same row from two clients merge on reconnect", async () => {
    const u = await createUser(server);
    const docId = await createDoc(server, u.id);
    const a = track(connect(server, u.token, docId));
    const b = track(connect(server, u.token, docId));
    await waitFor(() => synced(a.provider) && synced(b.provider));
    a.doc.getMap("rows").set("r1", new Y.Map([["title", "start"]]));
    await waitFor(() => b.doc.getMap("rows").has("r1"));

    a.provider.pause();
    b.provider.pause();
    await waitFor(() => a.provider.getState().status === "offline" && b.provider.getState().status === "offline");

    const row = (d: Y.Doc) => d.getMap("rows").get("r1") as Y.Map<unknown>;
    row(a.doc).set("status", "Done");        // different cells of the same row: both must survive
    row(b.doc).set("estimate", 5);
    row(a.doc).set("title", "from A");       // the same cell: one wins, identically everywhere
    row(b.doc).set("title", "from B");

    a.provider.resume();
    b.provider.resume();
    await waitFor(() => synced(a.provider) && synced(b.provider));
    await waitFor(() => sv(a.doc) === sv(b.doc) && json(a.doc) === json(b.doc), 6000, "convergence");

    const merged = row(a.doc).toJSON();
    expect(merged.status).toBe("Done");
    expect(merged.estimate).toBe(5);
    expect(["from A", "from B"]).toContain(merged.title);
  });

  describe("authorization and validation", () => {
    it("rejects a socket with no token or a bad token", async () => {
      for (const auth of [{}, { token: "garbage" }]) {
        const s = ioClient(server.url, { transports: ["websocket"], auth, reconnection: false });
        const err = await new Promise<Error>((res) => s.on("connect_error", res));
        expect(err.message).toBe("unauthorized");
        s.close();
      }
    });

    it("a non-member cannot join (FORBIDDEN) and gets no data", async () => {
      const owner = await createUser(server);
      const stranger = await createUser(server);
      const docId = await createDoc(server, owner.id);
      const c = track(connect(server, stranger.token, docId));
      await waitFor(() => c.provider.getState().lastError?.code === "FORBIDDEN", 5000, "FORBIDDEN");
      expect(c.provider.getState().status).not.toBe("synced");
    });

    it("a viewer receives updates but the server refuses their writes (READ_ONLY)", async () => {
      const owner = await createUser(server);
      const viewer = await createUser(server);
      const docId = await createDoc(server, owner.id, [[viewer.id, "viewer"]]);
      const a = track(connect(server, owner.token, docId));
      const v = track(connect(server, viewer.token, docId));
      await waitFor(() => synced(a.provider) && synced(v.provider));
      expect(v.provider.getState().role).toBe("viewer");
      cell(a.doc, "k", "from owner");
      await waitFor(() => cell(v.doc, "k") === "from owner");

      // The provider itself won't send as a viewer, so go around it with a raw socket.
      const raw = ioClient(server.url, { transports: ["websocket"], auth: { token: viewer.token }, reconnection: false });
      await new Promise<void>((r) => raw.on("connect", () => r()));
      raw.emit(EV.DOC_JOIN, { docId });
      await new Promise((r) => raw.once(EV.DOC_JOINED, r));
      const tmp = new Y.Doc();
      tmp.getMap("m").set("evil", "write");
      const err = new Promise<{ code: string }>((r) => raw.once(EV.DOC_ERROR, r));
      raw.emit(EV.SYNC_UPDATE, { docId, update: Y.encodeStateAsUpdate(tmp), clientSeq: 1 });
      expect((await err).code).toBe("READ_ONLY");
      await new Promise((r) => setTimeout(r, 100));
      expect(cell(a.doc, "evil")).toBeUndefined();
      raw.close();
    });

    it("rejects malformed payloads, un-joined docs and garbage binary", async () => {
      const u = await createUser(server);
      const docId = await createDoc(server, u.id);
      const raw = ioClient(server.url, { transports: ["websocket"], auth: { token: u.token }, reconnection: false });
      await new Promise<void>((r) => raw.on("connect", () => r()));
      const next = () => new Promise<{ code: string }>((r) => raw.once(EV.DOC_ERROR, r));

      let p = next(); raw.emit(EV.DOC_JOIN, { docId: "not-a-uuid" });
      expect((await p).code).toBe("BAD_PAYLOAD");

      p = next(); raw.emit(EV.SYNC_UPDATE, { docId, update: new Uint8Array(4), clientSeq: 1 });
      expect((await p).code).toBe("NOT_JOINED");

      raw.emit(EV.DOC_JOIN, { docId });
      await new Promise((r) => raw.once(EV.DOC_JOINED, r));
      p = next(); raw.emit(EV.SYNC_UPDATE, { docId, update: Uint8Array.from([255, 1, 2, 3, 4, 5, 6]), clientSeq: 1 });
      expect((await p).code).toBe("BAD_PAYLOAD");

      p = next(); raw.emit(EV.SYNC_UPDATE, { docId, update: "text", clientSeq: 1 });
      expect((await p).code).toBe("BAD_PAYLOAD");
      raw.close();
    });

    it("rate limits a flooding socket", async () => {
      const s = await start({ SOCKET_RATE_BURST: "10", SOCKET_RATE_PER_SEC: "1" });
      const u = await createUser(s);
      const docId = await createDoc(s, u.id);
      const raw = ioClient(s.url, { transports: ["websocket"], auth: { token: u.token }, reconnection: false });
      await new Promise<void>((r) => raw.on("connect", () => r()));
      const codes: string[] = [];
      raw.on(EV.DOC_ERROR, (e: { code: string }) => codes.push(e.code));
      for (let i = 0; i < 50; i++) raw.emit(EV.SYNC_STEP1, { docId, stateVector: new Uint8Array(1) });
      await waitFor(() => codes.includes("RATE_LIMITED"), 3000, "RATE_LIMITED");
      raw.close();
      await s.close();
    });
  });

  it("fuzz v0: 3 clients, random edits with random disconnects, everyone converges to the DB state", { timeout: 600_000 }, async () => {
    const runs = Number(process.env.FUZZ_RUNS ?? 5);
    for (const seed of Array.from({ length: runs }, (_, i) => i + 1)) {
      const rng = mulberry32(seed);
      const u = await createUser(server);
      const docId = await createDoc(server, u.id);
      const clients = [0, 1, 2].map(() => connect(server, u.token, docId));
      await waitFor(() => clients.every((c) => synced(c.provider)), 8000, `seed ${seed}: initial sync`);

      for (let step = 0; step < 150; step++) {
        const c = clients[Math.floor(rng() * 3)]!;
        const roll = rng();
        if (roll < 0.06) c.provider.pause();
        else if (roll < 0.12) c.provider.resume();
        else randomEdit(c.doc, rng);
        if (rng() < 0.3) await new Promise((r) => setTimeout(r, Math.floor(rng() * 15)));
      }
      clients.forEach((c) => c.provider.resume());
      await waitFor(() => clients.every((c) => synced(c.provider)), 10000, `seed ${seed}: resync`);
      await waitFor(
        () => clients.every((c) => c.provider.getState().pending === 0) && clients.every((c) => sv(c.doc) === sv(clients[0]!.doc)),
        10000, `seed ${seed}: convergence`,
      );
      const reference = snap(clients[0]!.doc);
      expect(JSON.parse(reference).rows).not.toEqual({}); // the run really did something
      clients.forEach((c, i) => expect(snap(c.doc), `seed ${seed}, client ${i}`).toBe(reference));

      // The durable copy must match too: reload from Postgres with an empty memory.
      const md = server.docManager.get(docId);
      if (md) await server.docManager.flush(md);
      const fresh = new DocManager(server.pool, { flushMs: 5, evictAfterMs: 60_000 });
      expect(snap((await fresh.acquire(docId)).doc), `seed ${seed}: DB state`).toBe(reference);
      await fresh.shutdown();
      clients.forEach((c) => { c.provider.destroy(); c.doc.destroy(); });
    }
  });
});

/** Mimics what the real app does to the doc, using plain Yjs (no web-app helpers needed). */
function randomEdit(doc: Y.Doc, rng: () => number) {
  const rows = doc.getMap<Y.Map<unknown>>("rows");
  const ids = Array.from(rows.keys());
  const pick = () => ids[Math.floor(rng() * ids.length)]!;
  const roll = rng();
  doc.transact(() => {
    if (ids.length === 0 || roll < 0.25) {
      const r = new Y.Map<unknown>();
      r.set("_order", "a" + Math.floor(rng() * 5)); // deliberately collides, like concurrent inserts do
      r.set("_deleted", false);
      rows.set(`row${Math.floor(rng() * 1e9)}`, r);
    } else if (roll < 0.6) {
      rows.get(pick())!.set(`c${Math.floor(rng() * 3)}`, Math.floor(rng() * 100));
    } else if (roll < 0.7) {
      const r = rows.get(pick())!;
      r.set("_deleted", !r.get("_deleted"));
    } else if (roll < 0.9) {
      const r = rows.get(pick())!;
      let t = r.get("notes");
      if (!(t instanceof Y.Text)) { t = new Y.Text(); r.set("notes", t); }
      const text = t as Y.Text;
      text.insert(Math.floor(rng() * (text.length + 1)), "abc"[Math.floor(rng() * 3)]!);
    } else {
      doc.getMap<Y.Map<unknown>>("columns").set(`col${Math.floor(rng() * 4)}`, new Y.Map([["name", `n${Math.floor(rng() * 9)}`]]));
    }
  });
}
