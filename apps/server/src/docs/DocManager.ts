import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import type { Pool } from "pg";

export interface DocManagerOptions {
  flushMs: number;
  evictAfterMs: number;
  /** Delay before retrying a failed write (default 1000). */
  retryMs?: number;
  /** Compact after this many rows in `updates` (default 500). */
  compactEvery?: number;
  /** ... or after this long if there is anything to fold (default 5 min). */
  compactIntervalMs?: number;
  log?: (msg: string) => void;
}

type AckFn = () => void;

interface Batch {
  updates: Uint8Array[];
  acks: AckFn[];
  userId: string | null;
}

/** One active document: the live Y.Doc plus everything needed to persist it. */
export class ManagedDoc {
  readonly doc = new Y.Doc();
  /** Live cursors / who is here. Never persisted. */
  readonly awareness: Awareness;
  /** Which socket (and user) owns each awareness client id, so nobody can speak for someone else. */
  awarenessOwners = new Map<number, { socketId: string; userId: string }>();
  awarenessWired = false;
  /** Rows in `updates` since the last snapshot. */
  rowsSinceSnapshot = 0;
  lastCompactAt = Date.now();
  clients = 0;
  seq = 0; // last seq written (or loaded)
  batch: Batch | null = null;
  flushTimer: ReturnType<typeof setTimeout> | null = null;
  evictTimer: ReturnType<typeof setTimeout> | null = null;
  retryTimer: ReturnType<typeof setTimeout> | null = null;
  chain: Promise<void> = Promise.resolve();
  /** Batches whose INSERT failed; retried before newer ones so seq order is kept. */
  failed: Batch[] = [];

  constructor(readonly id: string) {
    this.awareness = new Awareness(this.doc);
    this.awareness.setLocalState(null); // the server itself is not a participant
  }

  get hasPendingWrites() {
    return this.batch !== null || this.failed.length > 0;
  }
}

/**
 * In-memory Y.Doc per active document.
 *  - load:    latest snapshot + every update after it
 *  - write:   updates in a short window are merged into ONE `updates` row
 *  - evict:   docs with no clients are dropped after `evictAfterMs` (once flushed)
 */
export class DocManager {
  private docs = new Map<string, ManagedDoc>();
  private loading = new Map<string, Promise<ManagedDoc>>();

  private compactTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private pool: Pool, private opts: DocManagerOptions) {
    const every = opts.compactIntervalMs ?? 5 * 60_000;
    this.compactTimer = setInterval(() => {
      for (const md of this.docs.values()) {
        if (md.rowsSinceSnapshot > 0 && Date.now() - md.lastCompactAt >= every) void this.compact(md);
      }
    }, Math.max(50, Math.min(every / 2, 30_000)));
    this.compactTimer.unref();
  }

  get activeDocs() {
    return this.docs.size;
  }

  /** Join: load if needed and count this client. Pair with release(). */
  async acquire(docId: string): Promise<ManagedDoc> {
    let pending = this.loading.get(docId);
    if (!pending && !this.docs.has(docId)) {
      pending = this.load(docId).finally(() => this.loading.delete(docId));
      this.loading.set(docId, pending);
    }
    const md = this.docs.get(docId) ?? (await pending!);
    if (md.evictTimer) clearTimeout(md.evictTimer);
    md.evictTimer = null;
    md.clients++;
    return md;
  }

  release(docId: string) {
    const md = this.docs.get(docId);
    if (!md) return;
    md.clients = Math.max(0, md.clients - 1);
    if (md.clients === 0) this.scheduleEvict(md);
  }

  get(docId: string) {
    return this.docs.get(docId);
  }

  private async load(docId: string): Promise<ManagedDoc> {
    const md = new ManagedDoc(docId);
    const snap = await this.pool.query<{ state: Buffer; up_to_seq: string }>(
      "SELECT state, up_to_seq FROM snapshots WHERE doc_id = $1 ORDER BY up_to_seq DESC LIMIT 1",
      [docId],
    );
    let after = 0;
    if (snap.rows[0]) {
      Y.applyUpdate(md.doc, snap.rows[0].state);
      after = Number(snap.rows[0].up_to_seq);
      md.seq = after;
    }
    const ups = await this.pool.query<{ seq: string; update: Buffer }>(
      "SELECT seq, update FROM updates WHERE doc_id = $1 AND seq > $2 ORDER BY seq",
      [docId, after],
    );
    md.doc.transact(() => {
      for (const r of ups.rows) {
        Y.applyUpdate(md.doc, r.update);
        md.seq = Number(r.seq);
      }
    });
    md.rowsSinceSnapshot = ups.rows.length;
    this.docs.set(docId, md);
    return md;
  }

  /**
   * Apply a client update. Returns whether it changed the doc (a duplicate changes nothing,
   * so the caller can skip broadcasting). `onPersisted` runs once the bytes are in Postgres.
   */
  applyUpdate(md: ManagedDoc, update: Uint8Array, userId: string | null, onPersisted: AckFn): boolean {
    let changed = false;
    const mark = () => { changed = true; };
    md.doc.on("update", mark);
    try {
      Y.applyUpdate(md.doc, update, "client");
    } finally {
      md.doc.off("update", mark);
    }
    // An update with missing dependencies parks in pendingStructs without firing 'update'.
    // Persist it anyway so a restart doesn't lose it.
    const parked = md.doc.store.pendingStructs !== null;

    if (changed || parked) {
      if (!md.batch) md.batch = { updates: [], acks: [], userId };
      md.batch.updates.push(update);
      md.batch.acks.push(onPersisted);
      if (!md.flushTimer) md.flushTimer = setTimeout(() => void this.flush(md), this.opts.flushMs);
    } else if (md.batch) {
      md.batch.acks.push(onPersisted); // duplicate, but the original may not be durable yet
    } else if (md.failed.length) {
      md.failed[md.failed.length - 1]!.acks.push(onPersisted);
    } else {
      onPersisted();
    }
    return changed || parked;
  }

  /** Write the current batch. Serialized per doc so seq numbers stay in order. */
  flush(md: ManagedDoc): Promise<void> {
    if (md.flushTimer) clearTimeout(md.flushTimer);
    md.flushTimer = null;
    md.chain = md.chain.then(() => this.writePending(md)).then(() => this.maybeCompact(md));
    return md.chain;
  }

  private async maybeCompact(md: ManagedDoc) {
    if (md.rowsSinceSnapshot >= (this.opts.compactEvery ?? 500)) await this.compactNow(md);
  }

  /** Fold every row of `updates` into one snapshot. Safe to call any time; runs in the doc's write queue. */
  compact(md: ManagedDoc): Promise<void> {
    md.chain = md.chain.then(() => this.writePending(md)).then(() => this.compactNow(md));
    return md.chain;
  }

  /**
   * Roadmap section 6: snapshot = encodeStateAsUpdate, then drop the rows it covers, in ONE
   * transaction guarded by an advisory lock so two processes never compact the same doc together.
   * Assumes one process owns a document at a time (as the rest of the server does).
   */
  private async compactNow(md: ManagedDoc) {
    if (md.rowsSinceSnapshot === 0 || md.batch || md.failed.length > 0) return; // nothing to fold, or not all persisted yet
    const upTo = md.seq;
    // May include edits that are applied in memory but not written yet. That is harmless: they get a
    // higher seq and are re-applied on load, and applying an update twice changes nothing.
    const state = Y.encodeStateAsUpdate(md.doc);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [md.id]);
      await client.query("INSERT INTO snapshots (doc_id, state, up_to_seq, is_auto) VALUES ($1, $2, $3, true)", [md.id, Buffer.from(state), upTo]);
      await client.query("DELETE FROM updates WHERE doc_id = $1 AND seq <= $2", [md.id, upTo]);
      await client.query("DELETE FROM snapshots WHERE doc_id = $1 AND is_auto AND up_to_seq < $2", [md.id, upTo]); // keep manual versions (Week 4)
      await client.query("COMMIT");
      md.rowsSinceSnapshot = 0;
      md.lastCompactAt = Date.now();
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      this.opts.log?.(`compaction failed for ${md.id}: ${(e as Error).message}`);
    } finally {
      client.release();
    }
  }

  private async writePending(md: ManagedDoc) {
    if (md.batch) {
      md.failed.push(md.batch);
      md.batch = null;
    }
    while (md.failed.length) {
      const b = md.failed[0]!;
      const merged = b.updates.length === 1 ? b.updates[0]! : Y.mergeUpdates(b.updates);
      try {
        await this.insertUpdate(md, merged, b.userId);
      } catch (e) {
        this.opts.log?.(`persist failed for ${md.id}: ${(e as Error).message}; retrying`);
        if (!md.retryTimer) {
          md.retryTimer = setTimeout(() => {
            md.retryTimer = null;
            void this.flush(md);
          }, this.opts.retryMs ?? 1000);
        }
        return; // stays in md.failed, retried in order
      }
      md.failed.shift();
      md.rowsSinceSnapshot++;
      b.acks.forEach((a) => a());
    }
  }

  private async insertUpdate(md: ManagedDoc, update: Uint8Array, userId: string | null) {
    for (let attempt = 0; ; attempt++) {
      const seq = md.seq + 1;
      try {
        await this.pool.query("INSERT INTO updates (doc_id, seq, update, user_id) VALUES ($1, $2, $3, $4)", [
          md.id, seq, Buffer.from(update), userId,
        ]);
        md.seq = seq;
        return;
      } catch (e) {
        // Unique (doc_id, seq) violation = someone else wrote this seq. Re-read and retry.
        if ((e as { code?: string }).code === "23505" && attempt < 3) {
          const r = await this.pool.query<{ m: string }>("SELECT COALESCE(MAX(seq), 0) AS m FROM updates WHERE doc_id = $1", [md.id]);
          md.seq = Math.max(md.seq, Number(r.rows[0]!.m));
          continue;
        }
        throw e;
      }
    }
  }

  private scheduleEvict(md: ManagedDoc) {
    if (md.evictTimer) clearTimeout(md.evictTimer);
    md.evictTimer = setTimeout(async () => {
      md.evictTimer = null;
      if (md.clients > 0) return;
      await this.flush(md);
      if (md.clients > 0) return;
      if (md.hasPendingWrites) return this.scheduleEvict(md); // DB trouble: keep it in memory
      if (md.rowsSinceSnapshot > 0) await this.compact(md); // leave the doc cheap to load next time
      if (md.clients > 0) return;
      if (md.retryTimer) clearTimeout(md.retryTimer);
      md.awareness.destroy();
      md.doc.destroy();
      this.docs.delete(md.id);
    }, this.opts.evictAfterMs);
  }

  /** Flush everything and stop timers (graceful shutdown). */
  async shutdown() {
    if (this.compactTimer) clearInterval(this.compactTimer);
    for (const md of this.docs.values()) {
      md.awareness.destroy();
      if (md.evictTimer) clearTimeout(md.evictTimer);
      if (md.retryTimer) clearTimeout(md.retryTimer);
      await this.flush(md);
    }
  }
}
