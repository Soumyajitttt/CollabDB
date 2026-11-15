import type { Server, Socket } from "socket.io";
import * as Y from "yjs";
import type { z } from "zod";
import {
  DocErrorPayload, ErrorCode, EV, JoinDoc, Role, SyncStep1, SyncUpdate, verifyAccessToken,
} from "@collab/shared";
import type { Pool } from "pg";
import type { Config } from "../config";
import type { DocManager } from "../docs/DocManager";
import { RateLimiter } from "../rateLimiter";

interface SocketData {
  userId: string;
  roles: Map<string, Role>; // docs this socket has joined, with the role granted at join time
}

type Deps = { pool: Pool; config: Config; docManager: DocManager };

export function attachSocket(io: Server, { pool, config, docManager }: Deps) {
  // Per-IP limit on connection attempts (cheap protection against token-guessing / reconnect storms).
  const ipLimiter = new RateLimiter(60, 5);

  io.use(async (socket, next) => {
    if (!ipLimiter.consume(socket.handshake.address)) return next(new Error("rate_limited"));
    const token = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
    if (typeof token !== "string" || token === "") return next(new Error("unauthorized"));
    try {
      const claims = await verifyAccessToken(config.JWT_SECRET, token);
      (socket.data as SocketData).userId = claims.sub;
      (socket.data as SocketData).roles = new Map();
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
      if (data.roles.has(docId)) return void socket.emit(EV.DOC_JOINED, { docId, role: data.roles.get(docId) });
      const res = await pool.query<{ role: Role }>(
        "SELECT role FROM document_members WHERE doc_id = $1 AND user_id = $2",
        [docId, data.userId],
      );
      const role = res.rows[0]?.role;
      if (!role) return fail("FORBIDDEN", "not a member of this document");
      await docManager.acquire(docId);
      if (socket.disconnected) return docManager.release(docId); // left while loading
      data.roles.set(docId, role);
      await socket.join(docId);
      socket.emit(EV.DOC_JOINED, { docId, role });
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

    socket.on("disconnect", () => {
      for (const docId of data.roles.keys()) docManager.release(docId);
      data.roles.clear();
    });
  });
}

export type { Socket };
