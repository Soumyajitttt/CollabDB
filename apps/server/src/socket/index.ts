import type { Server, Socket } from "socket.io";
import * as Y from "yjs";
import { applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import type { z } from "zod";
import {
  AwarenessMsg, DocErrorPayload, ErrorCode, EV, JoinDoc, PresenceUser, Role, SyncStep1, SyncUpdate,
  colorForUser, verifyAccessToken,
} from "@collab/shared";
import type { Pool } from "pg";
import type { Config } from "../config";
import type { DocManager, ManagedDoc } from "../docs/DocManager";
import { RateLimiter } from "../rateLimiter";
import { decodeAwareness, encodeAwareness, sanitizeEntries } from "./awareness";

interface SocketData {
  userId: string;
  identity?: PresenceUser;
  roles: Map<string, Role>; // docs this socket has joined, with the CURRENT role (kept up to date by refreshMembership)
}

type Deps = { pool: Pool; config: Config; docManager: DocManager };

export interface SocketLayer {
  /** Call after a membership row changed: re-reads the role and applies it to every connected socket of that user. */
  refreshMembership: (docId: string, userId: string) => Promise<void>;
}

export function attachSocket(io: Server, { pool, config, docManager }: Deps): SocketLayer {
  // Per-IP limit on connection attempts (cheap protection against token-guessing / reconnect storms).
  const ipLimiter = new RateLimiter(60, 5);

  /** Drop this socket's presence from a doc and tell the room. Only ids it still owns are removed. */
  const dropPresence = (md: ManagedDoc, socketId: string) => {
    const ids = [...md.awarenessOwners].filter(([, o]) => o.socketId === socketId).map(([id]) => id);
    if (ids.length === 0) return;
    ids.forEach((id) => md.awarenessOwners.delete(id));
    removeAwarenessStates(md.awareness, ids, "disconnect");
    io.in(md.id).emit(EV.AWARENESS, { docId: md.id, update: encodeAwarenessUpdate(md.awareness, ids) });
  };

  /** The server's awareness object also times out silent clients; tell the room when that happens. */
  const wireAwareness = (md: ManagedDoc) => {
    if (md.awarenessWired) return;
    md.awarenessWired = true;
    md.awareness.on("update", ({ removed }: { removed: number[] }, origin: unknown) => {
      if (origin !== "timeout" || removed.length === 0) return;
      removed.forEach((id) => md.awarenessOwners.delete(id));
      io.in(md.id).emit(EV.AWARENESS, { docId: md.id, update: encodeAwarenessUpdate(md.awareness, removed) });
    });
  };

  io.use(async (socket, next) => {
    if (!ipLimiter.consume(socket.handshake.address)) return next(new Error("rate_limited"));
    const token = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
    if (typeof token !== "string" || token === "") return next(new Error("unauthorized"));
    try {
      const claims = await verifyAccessToken(config.JWT_SECRET, token);
      const data = socket.data as SocketData;
      data.userId = claims.sub;
      data.roles = new Map();
      next();
    } catch {
      next(new Error("unauthorized"));
    }
  });

  io.on("connection", (socket) => {
    const data = socket.data as SocketData;
    const limiter = new RateLimiter(config.SOCKET_RATE_BURST, config.SOCKET_RATE_PER_SEC);

    const fail = (code: ErrorCode, message?: string) => {
      const payload: DocErrorPayload = { code, message };
      socket.emit(EV.DOC_ERROR, payload);
    };

    /** Zod check -> rate limit -> handler. Authorization happens inside each handler. */
    const guarded =
      <S extends z.ZodTypeAny>(schema: S, handler: (p: z.infer<S>) => Promise<void>) =>
      async (raw: unknown) => {
        const parsed = schema.safeParse(raw);
        if (!parsed.success) return fail("BAD_PAYLOAD");
        if (!limiter.consume("events")) return fail("RATE_LIMITED");
        try {
          await handler(parsed.data);
        } catch (e) {
          console.error(`socket handler error: ${(e as Error).message}`);
          fail("INTERNAL");
        }
      };

    socket.on(EV.DOC_JOIN, guarded(JoinDoc, async ({ docId }) => {
      if (data.roles.has(docId) && data.identity) {
        return void socket.emit(EV.DOC_JOINED, { docId, role: data.roles.get(docId), user: data.identity });
      }
      const res = await pool.query<{ role: Role; name: string }>(
        `SELECT m.role, u.name FROM document_members m JOIN users u ON u.id = m.user_id
          WHERE m.doc_id = $1 AND m.user_id = $2`,
        [docId, data.userId],
      );
      const row = res.rows[0];
      if (!row) return fail("FORBIDDEN", "not a member of this document");
      const md = await docManager.acquire(docId);
      if (socket.disconnected) return docManager.release(docId); // left while loading
      wireAwareness(md);
      data.identity = { id: data.userId, name: row.name, color: colorForUser(data.userId) };
      data.roles.set(docId, row.role);
      await socket.join(docId);
      socket.emit(EV.DOC_JOINED, { docId, role: row.role, user: data.identity });
    }));

    socket.on(EV.SYNC_STEP1, guarded(SyncStep1, async ({ docId, stateVector }) => {
      if (!data.roles.has(docId)) return fail("NOT_JOINED");
      const md = docManager.get(docId);
      if (!md) return fail("NOT_JOINED");
      let diff: Uint8Array;
      try {
        diff = Y.encodeStateAsUpdate(md.doc, stateVector);
      } catch {
        return fail("BAD_PAYLOAD", "malformed state vector");
      }
      socket.emit(EV.SYNC_STEP2, { docId, update: diff });
      socket.emit(EV.SYNC_REQUEST, { docId, stateVector: Y.encodeStateVector(md.doc) });
      // Everyone already here, so the newcomer sees their cursors immediately.
      const others = [...md.awareness.getStates().keys()].filter((id) => md.awarenessOwners.get(id)?.socketId !== socket.id);
      if (others.length > 0) socket.emit(EV.AWARENESS, { docId, update: encodeAwarenessUpdate(md.awareness, others) });
    }));

    socket.on(EV.SYNC_UPDATE, guarded(SyncUpdate, async ({ docId, update, clientSeq }) => {
      const role = data.roles.get(docId);
      if (!role) return fail("NOT_JOINED");
      if (role === "viewer") return fail("READ_ONLY");
      const md = docManager.get(docId);
      if (!md) return fail("NOT_JOINED");
      let changed: boolean;
      try {
        changed = docManager.applyUpdate(md, update, data.userId, () =>
          socket.emit(EV.SYNC_ACK, { docId, clientSeq }),
        );
      } catch {
        return fail("BAD_PAYLOAD", "malformed update");
      }
      if (changed) socket.to(docId).emit(EV.SYNC_UPDATE, { docId, update });
    }));

    // Presence is relayed, never stored. Any member (viewers too) may publish their own.
    socket.on(EV.AWARENESS, guarded(AwarenessMsg, async ({ docId, update }) => {
      if (!data.roles.has(docId) || !data.identity) return fail("NOT_JOINED");
      const md = docManager.get(docId);
      if (!md) return fail("NOT_JOINED");
      let entries;
      try {
        entries = decodeAwareness(update);
      } catch {
        return fail("BAD_PAYLOAD", "malformed awareness update");
      }
      // A client id may only be used by the user who first claimed it.
      for (const e of entries) {
        const owner = md.awarenessOwners.get(e.clientId);
        if (owner && owner.userId !== data.userId) return fail("BAD_PAYLOAD", "client id belongs to someone else");
      }
      const clean = sanitizeEntries(entries, data.identity);
      if (!clean) return fail("BAD_PAYLOAD", "invalid awareness state");
      for (const e of clean) md.awarenessOwners.set(e.clientId, { socketId: socket.id, userId: data.userId });
      const bytes = encodeAwareness(clean);
      applyAwarenessUpdate(md.awareness, bytes, socket.id);
      socket.to(docId).emit(EV.AWARENESS, { docId, update: bytes });
    }));

    socket.on("disconnect", () => {
      for (const docId of data.roles.keys()) {
        const md = docManager.get(docId);
        if (md) dropPresence(md, socket.id);
        docManager.release(docId);
      }
      data.roles.clear();
    });
  });

  /** Apply a changed or removed membership to sockets that are already connected. */
  async function refreshMembership(docId: string, userId: string) {
    const res = await pool.query<{ role: Role }>("SELECT role FROM document_members WHERE doc_id = $1 AND user_id = $2", [docId, userId]);
    const role = res.rows[0]?.role ?? null;
    for (const socket of await io.in(docId).fetchSockets()) {
      const d = socket.data as SocketData;
      if (d.userId !== userId || !d.roles.has(docId)) continue;
      if (role) {
        d.roles.set(docId, role);
        socket.emit(EV.DOC_ROLE, { docId, role });
      } else {
        d.roles.delete(docId);
        socket.emit(EV.DOC_ERROR, { code: "FORBIDDEN", message: "access removed" } satisfies DocErrorPayload);
        const md = docManager.get(docId);
        if (md) dropPresence(md, socket.id);
        socket.leave(docId);
        docManager.release(docId);
      }
    }
  }

  return { refreshMembership };
}

export type { Socket };
