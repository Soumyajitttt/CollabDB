# Devlog

## Week 1: Local grid + Yjs data model
- Data model in `apps/web/lib/doc.ts` (rows/columns as Y.Maps, fractional-index order, soft deletes, Y.Text for longtext).
- 11 unit tests: helpers, same-cell LWW convergence, longtext char-level merge, concurrent-insert tie-break, idempotency.
- `useStructure` only re-renders on row/column add/remove/reorder; `useCell` subscribes to one cell.
- Persistence: y-indexeddb. Two tabs mirror via BroadcastChannel (`lib/tabSync.ts`), a preview of the Week 2 handshake.
- Benchmark panel (bottom of page): fill in the numbers below from your machine.

| Metric | Result |
|---|---|
| 10k rows generate | _ ms |
| 10k rows render after load | _ ms |
| Scroll FPS | _ |
| Edit to paint (median) | _ ms |

### Notes / surprises
- _write yours_

---

## Week 2: Sync server + Postgres + auth

**Built**
- `packages/shared`: Zod schemas for every socket event and REST body, event names, JWT sign/verify (jose).
- `packages/sync`: `SyncProvider` (state-vector handshake, 15 ms client batching, acks, reconnect with backoff, pause/resume).
- `apps/server`: Express + Socket.IO, SQL migrations, bcrypt register/login, `DocManager` (load = snapshot + updates, 20 ms write batching, idle eviction, retry on failed INSERT), per-socket and per-IP rate limits.
- Web: NextAuth (credentials, JWT sessions), `/api/token`, login page, document list, synced grid, sync status pill, "Go offline" testing toggle. `/local` keeps the Week 1 browser-only table.
- `docs/protocol.md` written first-class; `docker-compose.yml`; CI with a Postgres service.

**Auth decision.** NextAuth cannot hand its own session JWT to a separate server cleanly (it is encrypted for NextAuth itself),
so the web app mints a second, short-lived HS256 JWT from the session. Result: JWT *and* NextAuth, no refresh tokens, and the long-lived credential stays in an httpOnly cookie.

**Measured (my sandbox, Postgres 16 on the same machine; re-run on yours: `npm run bench:latency -w apps/server`)**

| Metric | p50 | p95 | p99 |
|---|---|---|---|
| edit -> visible on other client | 2.8 ms | 4.6 ms | 6.8 ms |
| edit -> server ack (persisted) | 26.0 ms | 28.6 ms | 33.1 ms |

The ack number includes the deliberate 20 ms batching window. Localhost has no network latency, so treat these as a floor.

**Tests.** 46 passing across shared (6), server (29) and web (11). Fuzz v0: 3 clients, 150 random edits each with random disconnects (inserts with colliding order keys, cell writes, soft deletes, Y.Text typing, column adds);
5 seeds in the normal run, 40 seeds checked once, every run ended with all clients and the reloaded-from-Postgres doc identical.

**Deviations from the roadmap**
- npm workspaces instead of pnpm.
- `MAX_UPDATE_BYTES` is 4 MiB, not 256 KB: the 10k-row bulk insert and a long offline session are each ONE update and must fit. The Socket.IO buffer cap (5 MiB) and rate limits are the protection.
- The owner's client seeds the starter table after its first sync (the server never writes document content).
- No `sync:ack` loss handling beyond reconnect: on reconnect the handshake recomputes what the server lacks, so nothing depends on acks.

**Known limits (Week 3+)**
- Roles are read at join time; changing or revoking a role does not affect already-connected sockets yet.
- Viewers are blocked by the server, but the grid UI still lets them type locally (banner explains it). Proper read-only UI is Week 3.
- The JWT is verified at connect time only; an open socket outlives its 10-minute token.
- Two clients first-opening a brand-new empty doc at the exact same moment could both seed. Only the owner seeds, so this needs the owner in two tabs at once.
- One server process. Redis fan-out is the optional stretch.

**Fix after first run: join retry.** Reloading the page while the server's database was unreachable (for example no internet with a hosted Postgres)
made the server answer `doc:join` with `INTERNAL`, and the client sat in "Syncing…" forever. Reproduced with a test that makes the first two membership lookups fail;
`SyncProvider` now re-sends `doc:join` with backoff when it gets `INTERNAL` before the handshake finishes. Edits were never lost, they only synced late.

---

## Week 3: Presence, snapshots + compaction, permissions

**Built**
- **Presence.** `y-protocols` awareness relayed by the server, never stored. Clients send only `{cell, editing}`; the server stamps the real name and a palette colour, rejects forged identities and other people's client ids, and cleans up on disconnect or removal. UI: coloured cell ring + name tag (with a pencil while editing), avatars in the header, remote cursors cleared while offline.
- **Snapshots + compaction.** One transaction under an advisory lock: write the snapshot, delete the folded rows, keep manual versions. Triggered by 500 rows, a 5-minute timer, or the last client leaving.
- **Permissions.** Share dialog (owner only) with add / change role / remove; members REST with owner-only rules; role changes and removals reach already-connected sockets (`doc:role`, `FORBIDDEN`). Viewers get a read-only grid; a `READ_ONLY` error makes the web client re-sync from the server.
- **Fix requested after Week 2:** the whole table card on the list page is now the link (keyboard focus, hover state, "Opening…" while navigating), plus a `loading.tsx` for `/doc/[id]`.

**Measured (my sandbox, local Postgres 16; re-run on yours: `npm run bench:compaction -w apps/server`)**

| 50,000-update session | before compaction | after |
|---|---|---|
| rows in `updates` | 50,000 | 0 (1 snapshot) |
| payload bytes stored | 1,542 KiB | 530 KiB |
| time for a fresh server to load the doc (median of 3) | 332 to 370 ms | 116 to 140 ms |
| compaction itself | | 113 to 153 ms |

Payload bytes only: per-row overhead and indexes on 50,000 rows make the real on-disk difference larger. The first version of this benchmark was wrong (its own measuring managers compacted on shutdown, so "before" was really "after"); I caught it from a suspicious "0 ms" and fixed it.

**Tests.** 80 passing: shared 6, server 60, web 14. New: awareness wire format and sanitising, presence end to end (identity from the server, late joiner, leave, offline clearing, throttling, viewer presence, forged client id, oversized and malformed updates), sharing rules and live role changes (promote, demote, remove, leave), compaction (state equality after fold, snapshot + tail, newest-only snapshot, manual snapshots kept, automatic trigger, compaction on eviction, advisory lock actually blocks, end to end on the real server). The full-stack smoke script now also covers sharing, role change and presence through real NextAuth sessions.

**Decisions**
- The server, not the client, decides name and colour: otherwise any user could show up as someone else.
- Inviting needs an existing account (404 `USER_NOT_FOUND`); pending invites for unregistered emails are not built.
- Compaction runs inside the document's write queue and skips itself while any write is unpersisted.

**Known limits**
- UI is verified by typecheck, a production build and route checks, not by clicking through it in a browser (no browser in my sandbox): cursors, the share dialog, read-only grid and the clickable card need a look from you.
- Compaction assumes one process owns a document. Redis fan-out (optional stretch) would need doc ownership first.
- A token is still verified only at connect time.
- Version history UI, per-user undo, activity feed: Week 4.
