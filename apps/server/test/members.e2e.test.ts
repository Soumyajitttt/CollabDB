import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { EV } from "@collab/shared";
import type { RunningServer } from "../src/server";
import { connect, createDoc, createUser, dbAvailable, rawJoin, start, synced, waitFor } from "./helpers";

const available = await dbAvailable();
type Conn = ReturnType<typeof connect>;
type U = Awaited<ReturnType<typeof createUser>>;

describe.skipIf(!available)("sharing and live permission changes", () => {
  let server: RunningServer;
  let open: Conn[] = [];
  const track = (c: Conn) => (open.push(c), c);
  beforeAll(async () => { server = await start(); });
  afterEach(() => { open.forEach((c) => { c.provider.destroy(); c.doc.destroy(); }); open = []; });
  afterAll(async () => { await server.close(); });

  const api = (u: U, method: string, path: string, body?: unknown) =>
    fetch(server.url + path, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${u.token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const setup = async () => {
    const owner = await createUser(server, "Olive Owner");
    const guest = await createUser(server, "Gus Guest");
    const stranger = await createUser(server, "Sam Stranger");
    const docId = await createDoc(server, owner.id);
    return { owner, guest, stranger, docId };
  };

  describe("REST rules", () => {
    it("only the owner can add, change or remove members; outsiders get 404", async () => {
      const { owner, guest, stranger, docId } = await setup();
      expect((await api(stranger, "GET", `/docs/${docId}/members`)).status).toBe(404);
      expect((await api(stranger, "POST", `/docs/${docId}/members`, { email: guest.email, role: "viewer" })).status).toBe(404);

      const added = await api(owner, "POST", `/docs/${docId}/members`, { email: guest.email.toUpperCase(), role: "viewer" });
      expect(added.status).toBe(201);
      expect((await added.json()).member).toMatchObject({ userId: guest.id, role: "viewer", name: "Gus Guest" });

      expect((await api(guest, "POST", `/docs/${docId}/members`, { email: stranger.email, role: "editor" })).status).toBe(403);
      expect((await api(guest, "PATCH", `/docs/${docId}/members/${guest.id}`, { role: "editor" })).status).toBe(403);
      expect((await api(guest, "DELETE", `/docs/${docId}/members/${owner.id}`)).status).toBe(403);
    });

    it("validates input and protects the owner", async () => {
      const { owner, guest, docId } = await setup();
      expect((await api(owner, "POST", `/docs/${docId}/members`, { email: "nobody@nowhere.dev", role: "viewer" })).status).toBe(404);
      expect((await api(owner, "POST", `/docs/${docId}/members`, { email: guest.email, role: "owner" })).status).toBe(400);
      expect((await api(owner, "POST", `/docs/${docId}/members`, { email: "not-an-email", role: "viewer" })).status).toBe(400);
      expect((await api(owner, "POST", `/docs/${docId}/members`, { email: owner.email, role: "viewer" })).status).toBe(409);
      expect((await api(owner, "PATCH", `/docs/${docId}/members/${owner.id}`, { role: "viewer" })).status).toBe(409);
      expect((await api(owner, "DELETE", `/docs/${docId}/members/${owner.id}`)).status).toBe(409);
      expect((await api(owner, "GET", `/docs/not-a-uuid/members`)).status).toBe(400);
    });

    it("lists members (owner first), shows the doc to the new member, and lets them leave", async () => {
      const { owner, guest, docId } = await setup();
      await api(owner, "POST", `/docs/${docId}/members`, { email: guest.email, role: "editor" });
      const members = (await (await api(guest, "GET", `/docs/${docId}/members`)).json()).members;
      expect(members.map((m: { role: string }) => m.role)).toEqual(["owner", "editor"]);
      const mine = (await (await api(guest, "GET", "/docs")).json()).docs;
      expect(mine.find((d: { id: string }) => d.id === docId).role).toBe("editor");

      expect((await api(guest, "DELETE", `/docs/${docId}/members/${guest.id}`)).status).toBe(200);
      expect((await api(guest, "GET", `/docs/${docId}/members`)).status).toBe(404);
    });

    it("re-adding an existing member changes their role instead of duplicating them", async () => {
      const { owner, guest, docId } = await setup();
      await api(owner, "POST", `/docs/${docId}/members`, { email: guest.email, role: "viewer" });
      await api(owner, "POST", `/docs/${docId}/members`, { email: guest.email, role: "editor" });
      const members = (await (await api(owner, "GET", `/docs/${docId}/members`)).json()).members;
      expect(members).toHaveLength(2);
      expect(members[1].role).toBe("editor");
    });
  });

  describe("changes reach people who are already connected", () => {
    it("a viewer promoted to editor can write at once, and demoted again is blocked by the server", async () => {
      const { owner, guest, docId } = await setup();
      await api(owner, "POST", `/docs/${docId}/members`, { email: guest.email, role: "viewer" });
      const o = track(connect(server, owner.token, docId));
      const g = track(connect(server, guest.token, docId));
      await waitFor(() => synced(o.provider) && synced(g.provider));
      expect(g.provider.getState().role).toBe("viewer");

      await api(owner, "PATCH", `/docs/${docId}/members/${guest.id}`, { role: "editor" });
      await waitFor(() => g.provider.getState().role === "editor", 4000, "role to become editor");
      g.doc.getMap("m").set("by", "guest");
      await waitFor(() => o.doc.getMap("m").get("by") === "guest", 4000, "guest's edit to reach owner");

      await api(owner, "PATCH", `/docs/${docId}/members/${guest.id}`, { role: "viewer" });
      await waitFor(() => g.provider.getState().role === "viewer", 4000, "role to become viewer");
      // Bypass our own client: the SERVER must refuse.
      const raw = await rawJoin(server, guest.token, docId);
      const tmp = new Y.Doc();
      tmp.getMap("m").set("evil", 1);
      raw.socket.emit(EV.SYNC_UPDATE, { docId, update: Y.encodeStateAsUpdate(tmp), clientSeq: 1 });
      await waitFor(() => raw.errors.includes("READ_ONLY"), 3000, "READ_ONLY");
      raw.socket.close();
      await new Promise((r) => setTimeout(r, 100));
      expect(o.doc.getMap("m").get("evil")).toBeUndefined();
    });

    it("removing a member disconnects them from the document and clears their cursor", async () => {
      const { owner, guest, docId } = await setup();
      await api(owner, "POST", `/docs/${docId}/members`, { email: guest.email, role: "editor" });
      const o = track(connect(server, owner.token, docId));
      const g = track(connect(server, guest.token, docId));
      await waitFor(() => synced(o.provider) && synced(g.provider));
      g.provider.setPresence({ rowId: "r", colId: "c" }, false);
      await waitFor(() => o.provider.getPresence().some((p) => p.user.name === "Gus Guest"), 4000, "guest cursor");

      await api(owner, "DELETE", `/docs/${docId}/members/${guest.id}`);
      await waitFor(() => g.provider.getState().lastError?.code === "FORBIDDEN", 4000, "guest told FORBIDDEN");
      await waitFor(() => o.provider.getPresence().length === 0, 4000, "guest cursor removed");

      // Their edits no longer count, and they cannot come back in.
      g.doc.getMap("m").set("ghost", "write");
      await new Promise((r) => setTimeout(r, 150));
      expect(o.doc.getMap("m").get("ghost")).toBeUndefined();
      const again = await rawJoin(server, guest.token, docId);
      expect(again.errors).toContain("FORBIDDEN");
      again.socket.close();
    });
  });
});
