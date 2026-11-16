import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { EV, colorForUser } from "@collab/shared";
import type { RunningServer } from "../src/server";
import { encodeAwareness } from "../src/socket/awareness";
import { connect, createDoc, createUser, dbAvailable, rawJoin, start, synced, waitFor } from "./helpers";

const available = await dbAvailable();
type Conn = ReturnType<typeof connect>;
const cell = { rowId: "r1", colId: "c1" };

describe.skipIf(!available)("presence", () => {
  let server: RunningServer;
  let open: Conn[] = [];
  const track = (c: Conn) => (open.push(c), c);
  beforeAll(async () => { server = await start(); });
  afterEach(() => { open.forEach((c) => { c.provider.destroy(); c.doc.destroy(); }); open = []; });
  afterAll(async () => { await server.close(); });

  const pair = async () => {
    const ann = await createUser(server, "Ann Lee");
    const bob = await createUser(server, "Bob Ray");
    const docId = await createDoc(server, ann.id, [[bob.id, "editor"]]);
    const a = track(connect(server, ann.token, docId));
    const b = track(connect(server, bob.token, docId));
    await waitFor(() => synced(a.provider) && synced(b.provider));
    return { ann, bob, docId, a, b };
  };

  it("shows who is on which cell, with the identity the SERVER knows", async () => {
    const { ann, a, b } = await pair();
    a.provider.setPresence(cell, true);
    await waitFor(() => b.provider.getPresence()[0]?.cell?.rowId === "r1", 4000, "A's cell to reach B");
    const seen = b.provider.getPresence()[0]!;
    expect(seen.user).toEqual({ id: ann.id, name: "Ann Lee", color: colorForUser(ann.id) });
    expect(seen.cell).toEqual(cell);
    expect(seen.editing).toBe(true);
    expect(a.provider.getPresence()).toHaveLength(1); // A sees B, never itself
    expect(a.provider.getPresence()[0]!.user.name).toBe("Bob Ray");
    expect(a.provider.getState().me?.name).toBe("Ann Lee");
  });

  it("a late joiner immediately sees the people already there", async () => {
    const { bob, docId, a } = await pair();
    a.provider.setPresence(cell, false);
    await waitFor(() => a.provider.getPresence().length === 1);
    const late = track(connect(server, bob.token, docId));
    await waitFor(() => synced(late.provider) && late.provider.getPresence().some((p) => p.user.name === "Ann Lee"), 5000, "late joiner sees Ann");
  });

  it("removes a participant who leaves or disconnects", async () => {
    const { a, b } = await pair();
    a.provider.setPresence(cell, false);
    await waitFor(() => b.provider.getPresence().length === 1);
    a.provider.destroy();
    await waitFor(() => b.provider.getPresence().length === 0, 4000, "A's cursor to disappear");
  });

  it("clears remote cursors while offline and brings them back on reconnect", async () => {
    const { a, b } = await pair();
    a.provider.setPresence(cell, false);
    await waitFor(() => b.provider.getPresence().length === 1);
    b.provider.pause();
    await waitFor(() => b.provider.getState().status === "offline");
    expect(b.provider.getPresence()).toEqual([]); // no stale cursors while cut off
    b.provider.resume();
    await waitFor(() => synced(b.provider) && b.provider.getPresence().length === 1, 5000, "cursor to return");
  });

  it("throttles rapid cursor moves", async () => {
    const { a, b } = await pair();
    let updates = 0;
    b.provider.subscribePresence(() => updates++);
    for (let i = 0; i < 40; i++) a.provider.setPresence({ rowId: `r${i}`, colId: "c" }, false);
    await waitFor(() => b.provider.getPresence()[0]?.cell?.rowId === "r39", 3000, "last position to arrive");
    expect(updates).toBeLessThanOrEqual(3);
  });

  it("viewers can show their cursor too", async () => {
    const owner = await createUser(server, "Owner");
    const viewer = await createUser(server, "Viewer");
    const docId = await createDoc(server, owner.id, [[viewer.id, "viewer"]]);
    const o = track(connect(server, owner.token, docId));
    const v = track(connect(server, viewer.token, docId));
    await waitFor(() => synced(o.provider) && synced(v.provider));
    v.provider.setPresence(cell, false);
    await waitFor(() => o.provider.getPresence().some((p) => p.user.name === "Viewer"), 4000, "viewer cursor");
  });

  describe("abuse", () => {
    it("rejects speaking for someone else's client id", async () => {
      const { bob, docId, a } = await pair();
      a.provider.setPresence(cell, false);
      await waitFor(() => a.provider.getPresence().length === 1);
      const { socket, errors } = await rawJoin(server, bob.token, docId);
      // Bob's raw socket tries to publish a state for the id Ann's client already owns.
      const forged = encodeAwareness([{ clientId: a.doc.clientID, clock: 99999, state: { cell, editing: true } }]);
      socket.emit(EV.AWARENESS, { docId, update: forged });
      await waitFor(() => errors.includes("BAD_PAYLOAD"), 3000, "forgery rejected");
      socket.close();
    });

    it("rejects a client-supplied identity, oversized and malformed updates", async () => {
      const { ann, docId } = await pair();
      const { socket, errors } = await rawJoin(server, ann.token, docId);
      const send = (update: Uint8Array) => socket.emit(EV.AWARENESS, { docId, update });
      send(encodeAwareness([{ clientId: 5, clock: 1, state: { user: { name: "Admin" }, cell: null, editing: false } }]));
      send(new Uint8Array(3000));
      send(Uint8Array.from([200, 1, 2]));
      await waitFor(() => errors.filter((e) => e === "BAD_PAYLOAD").length >= 3, 3000, "three rejections");
      socket.close();
    });

    it("refuses presence from a socket that has not joined", async () => {
      const stranger = await createUser(server);
      const owner = await createUser(server);
      const docId = await createDoc(server, owner.id);
      const { socket, errors } = await rawJoin(server, stranger.token, docId);
      socket.emit(EV.AWARENESS, { docId, update: encodeAwareness([{ clientId: 1, clock: 1, state: null }]) });
      await waitFor(() => errors.includes("NOT_JOINED"), 3000, "NOT_JOINED");
      expect(errors).toContain("FORBIDDEN");
      socket.close();
    });
  });
});
