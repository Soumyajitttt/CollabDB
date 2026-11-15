import * as Y from "yjs";
import { io, Socket } from "socket.io-client";
import {
  EV, DocErrorPayload, DocJoinedPayload, Role, ServerUpdatePayload, SyncAckPayload, SyncRequestPayload, SyncStep2Payload,
} from "@collab/shared";

export type SyncStatus = "connecting" | "syncing" | "synced" | "offline";

export interface SyncState {
  status: SyncStatus;
  role: Role | null;
  /** Updates sent (or waiting to be sent) that the server has not acknowledged yet. */
  pending: number;
  lastError: DocErrorPayload | null;
}

export interface SyncProviderOptions {
  url: string;
  docId: string;
  /** Called on every (re)connect so the token is always fresh. */
  getToken: () => Promise<string>;
  /** Small updates are merged for this long before sending (roadmap: 10-30 ms). */
  batchMs?: number;
  /** Reconnect backoff bounds in ms. */
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
}

/** Socket.IO delivers binary as Buffer (Node), ArrayBuffer or Uint8Array (browser). */
function toU8(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  throw new Error("expected binary payload");
}

const EMPTY_UPDATE_BYTES = 2; // Y.encodeStateAsUpdate of "nothing" is [0, 0]
const FATAL = new Set(["FORBIDDEN", "UNAUTHORIZED"]);

/**
 * Yjs <-> Socket.IO sync for ONE document. Protocol: docs/protocol.md.
 * Offline needs no buffering: on every reconnect the handshake sends exactly the
 * part of the local doc the server's state vector doesn't have.
 */
export class SyncProvider {
  readonly doc: Y.Doc;
  private opts: Required<SyncProviderOptions>;
  private socket: Socket;
  private state: SyncState = { status: "connecting", role: null, pending: 0, lastError: null };
  private listeners = new Set<() => void>();

  private gotStep2 = false;
  private gotRequest = false;
  private clientSeq = 0;
  private unacked = new Set<number>();
  private buffer: Uint8Array[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryCount = 0;
  private rejoinTimer: ReturnType<typeof setTimeout> | null = null;
  private rejoinCount = 0;
  private destroyed = false;
  private fatal = false;

  constructor(doc: Y.Doc, options: SyncProviderOptions) {
    this.doc = doc;
    this.opts = { batchMs: 15, reconnectMinMs: 500, reconnectMaxMs: 10_000, ...options };
    this.socket = io(this.opts.url, {
      transports: ["websocket"],
      reconnection: true,
      reconnectionDelay: this.opts.reconnectMinMs,
      reconnectionDelayMax: this.opts.reconnectMaxMs,
      randomizationFactor: 0.5,
      auth: (cb) => {
        this.opts.getToken().then((token) => cb({ token })).catch(() => cb({ token: "" }));
      },
    });
    doc.on("update", this.onLocalUpdate);
    this.wire();
  }

  // ---- state (works with React's useSyncExternalStore) ----
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };
  getState = () => this.state;
  private set(patch: Partial<SyncState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }
  private refreshPending() {
    this.set({ pending: this.unacked.size + (this.buffer.length > 0 ? 1 : 0) });
  }

  // ---- socket wiring ----
  private wire() {
    const s = this.socket;
    s.on("connect", () => {
      this.retryCount = 0;
      this.gotStep2 = this.gotRequest = false;
      this.set({ status: "syncing", lastError: null });
      s.emit(EV.DOC_JOIN, { docId: this.opts.docId });
    });

    s.on(EV.DOC_JOINED, (p: DocJoinedPayload) => {
      this.rejoinCount = 0;
      this.set({ role: p.role, lastError: null });
      s.emit(EV.SYNC_STEP1, { docId: this.opts.docId, stateVector: Y.encodeStateVector(this.doc) });
    });

    s.on(EV.SYNC_STEP2, (p: SyncStep2Payload) => {
      Y.applyUpdate(this.doc, toU8(p.update), this);
      this.gotStep2 = true;
      this.maybeSynced();
    });

    s.on(EV.SYNC_REQUEST, (p: SyncRequestPayload) => {
      const diff = Y.encodeStateAsUpdate(this.doc, toU8(p.stateVector));
      if (diff.byteLength > EMPTY_UPDATE_BYTES && this.state.role !== "viewer") this.send(diff);
      this.gotRequest = true;
      this.maybeSynced();
    });

    s.on(EV.SYNC_UPDATE, (p: ServerUpdatePayload) => Y.applyUpdate(this.doc, toU8(p.update), this));

    s.on(EV.SYNC_ACK, (p: SyncAckPayload) => {
      this.unacked.delete(p.clientSeq);
      this.refreshPending();
    });

    s.on(EV.DOC_ERROR, (e: DocErrorPayload) => {
      this.set({ lastError: e });
      if (FATAL.has(e.code)) {
        this.fatal = true;
        s.disconnect();
      } else if (e.code === "INTERNAL" && this.state.status !== "synced") {
        // The server hit a transient problem (e.g. its database was unreachable) before the
        // handshake finished. The socket is fine, so just ask to join again after a pause.
        this.scheduleRejoin();
      }
    });

    s.on("disconnect", () => this.goOffline());
    s.on("connect_error", () => {
      this.goOffline();
      // Auth middleware rejections are not retried by Socket.IO itself.
      if (!s.active && !this.destroyed && !this.fatal) this.scheduleRetry();
    });
  }

  private scheduleRetry() {
    if (this.retryTimer) return;
    const delay = Math.min(this.opts.reconnectMinMs * 2 ** this.retryCount++, this.opts.reconnectMaxMs);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.destroyed && !this.fatal) this.socket.connect();
    }, delay);
  }

  private scheduleRejoin() {
    if (this.rejoinTimer) return;
    const delay = Math.min(this.opts.reconnectMinMs * 2 ** this.rejoinCount++, this.opts.reconnectMaxMs);
    this.rejoinTimer = setTimeout(() => {
      this.rejoinTimer = null;
      if (this.destroyed || this.fatal || !this.socket.connected) return;
      this.gotStep2 = this.gotRequest = false;
      this.socket.emit(EV.DOC_JOIN, { docId: this.opts.docId });
    }, delay);
  }

  private clearRejoin() {
    if (this.rejoinTimer) clearTimeout(this.rejoinTimer);
    this.rejoinTimer = null;
    this.rejoinCount = 0;
  }

  private goOffline() {
    this.clearRejoin();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.buffer = [];
    this.unacked.clear(); // acks for these will never arrive; the next handshake re-sends what's missing
    this.set({ status: "offline", pending: 0 });
  }

  private maybeSynced() {
    if (this.gotStep2 && this.gotRequest && this.state.status !== "synced") this.set({ status: "synced" });
  }

  // ---- sending ----
  private onLocalUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === this || this.state.status !== "synced" || this.state.role === "viewer") return;
    this.buffer.push(update);
    this.refreshPending();
    if (!this.timer) this.timer = setTimeout(() => this.flush(), this.opts.batchMs);
  };

  private flush() {
    this.timer = null;
    if (this.buffer.length === 0) return;
    const merged = this.buffer.length === 1 ? this.buffer[0]! : Y.mergeUpdates(this.buffer);
    this.buffer = [];
    this.send(merged);
  }

  private send(update: Uint8Array) {
    const clientSeq = ++this.clientSeq;
    this.unacked.add(clientSeq);
    this.refreshPending();
    this.socket.emit(EV.SYNC_UPDATE, { docId: this.opts.docId, update, clientSeq });
  }

  /** Resolves when the server has acknowledged everything sent so far. */
  async whenFlushed(timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    while (this.state.pending > 0 || this.state.status !== "synced") {
      if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for server ack");
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  /** Go offline on purpose (no auto-reconnect). Edits keep working locally. */
  pause() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.socket.disconnect();
  }

  /** Reconnect after pause(); the handshake sends everything the server is missing. */
  resume() {
    if (!this.destroyed && !this.fatal) this.socket.connect();
  }

  /** Test helper: drop the transport (Socket.IO reconnects by itself). */
  simulateDisconnect() {
    this.socket.io.engine?.close();
  }

  destroy() {
    this.destroyed = true;
    this.doc.off("update", this.onLocalUpdate);
    this.clearRejoin();
    if (this.timer) clearTimeout(this.timer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.socket.removeAllListeners();
    this.socket.disconnect();
    this.listeners.clear();
  }
}
