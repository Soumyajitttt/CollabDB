# Sync protocol (v1)

Transport: Socket.IO (WebSocket). One socket per open document. Binary payloads are Yjs updates / state vectors.

## Auth
The client passes `auth: { token }` in the handshake. The token is a short-lived (10 min) HS256 JWT minted by the web app
(`GET /api/token`, requires a NextAuth session) and verified by the server (issuer, audience, expiry, `sub` is a uuid).
A fresh token is fetched on every (re)connect. Bad or missing token => `connect_error: unauthorized`.

## Events

| Event | Dir | Payload | Notes |
|---|---|---|---|
| `doc:join` | C→S | `{docId}` | Server checks `document_members`. |
| `doc:joined` | S→C | `{docId, role, user}` | role = owner / editor / viewer; `user` = `{id, name, color}` as the server knows you |
| `sync:step1` | C→S | `{docId, stateVector}` | "Here is what I have." |
| `sync:step2` | S→C | `{docId, update}` | What the client is missing. |
| `sync:request` | S→C | `{docId, stateVector}` | "Send me what I'm missing." |
| `sync:update` | C→S | `{docId, update, clientSeq}` | Live edit or handshake diff. |
| `sync:update` | S→C | `{docId, update}` | Another client's edit (never echoed to the sender). |
| `sync:ack` | S→C | `{docId, clientSeq}` | Sent AFTER the update is stored in Postgres. |
| `doc:error` | S→C | `{code, message?}` | See below. |
| `doc:role` | S→C | `{docId, role}` | Your role changed while connected (sharing). |
| `awareness:update` | C↔S | `{docId, update}` | Presence (y-protocols awareness bytes). Relayed, never stored. |

## Handshake (every connect and reconnect)
1. `doc:join` → `doc:joined`
2. client `sync:step1` (its state vector)
3. server `sync:step2` (diff for the client) then `sync:request` (server's state vector)
4. client answers with one `sync:update` containing what the server lacks (skipped if nothing)
5. both sides are now equal; live updates flow

Offline editing needs no queue: edits only change the local Y.Doc, and step 4 sends them on reconnect.

## Rules
- Updates are idempotent. A duplicate changes nothing, is not stored again, is not re-broadcast, but is still acked.
- Updates inside one 20 ms window per document are merged into ONE row of `updates` (one `seq`).
- `seq` is a per-document counter. `UNIQUE (doc_id, seq)` guards against two writers; on a conflict the server re-reads the max and retries.
- If an INSERT fails the update stays in memory and is retried in order; no ack is sent until it is stored.
- Server memory holds a doc while clients are connected, then 60 s longer (idle eviction, flushed first).
- Load = latest snapshot + every update with a greater `seq`.

## Presence (awareness)
- A client publishes only `{cell: {rowId, colId} | null, editing}` (strict schema, max 2 KiB, max 4 client ids per message), throttled to one message per 50 ms.
- The server NEVER trusts identity from the client: it decodes the update, validates it, and re-encodes it with `user = {id, name, color}`
  taken from the JWT and the `users` table. Colours come from a fixed palette chosen by user id.
- A client id belongs to the user who first used it. Another user sending an update for that id gets `BAD_PAYLOAD`.
- On `sync:step1` the server also sends everyone's current presence, so a newcomer sees cursors at once.
- When a socket disconnects, is removed from the table, or leaves, the server broadcasts a "left" update for its client ids.
  Silent clients are dropped after 30 s without a heartbeat. Clients drop remote cursors while offline.
- Any member, viewers included, may publish presence. Presence is not persisted and not rate-exempt: it shares the socket's token bucket.

## Sharing and live role changes (REST, owner only unless noted)
| Request | Result |
|---|---|
| `GET /docs/:id/members` (any member) | owner first, then by name |
| `POST /docs/:id/members {email, role: editor|viewer}` | 201; 404 `USER_NOT_FOUND` (the person must have registered); 409 if that person is the owner; re-adding changes the role |
| `PATCH /docs/:id/members/:userId {role}` | 200; the owner's role cannot be changed (409) |
| `DELETE /docs/:id/members/:userId` | owner removes anyone but the owner; any member may remove themselves |

Non-members get 404 on these routes (the document's existence is not revealed). After any change the server re-reads the role and applies it to
every socket that user already has open: role change => `doc:role`; removal => `doc:error FORBIDDEN`, leave the room, drop their cursor.

## Snapshots and compaction
- After 500 rows in `updates` (or 5 minutes, if there is anything to fold, or when the last client leaves) the server writes
  `snapshots(state = encodeStateAsUpdate(doc), up_to_seq)` and deletes `updates` rows with `seq <= up_to_seq`, in ONE transaction guarded by
  `pg_advisory_xact_lock(hashtext(docId))`. The newest automatic snapshot is kept; manual ones (`is_auto = false`, Week 4) are never deleted.
- The snapshot may contain edits that are applied in memory but not yet written. That is safe: they get a higher `seq` and are applied again on load, and applying an update twice changes nothing.
- Compaction runs in the document's write queue, only when everything is persisted, so it never interleaves with a write.
- It assumes ONE server process owns a document at a time.

## Errors (`doc:error.code`)
`BAD_PAYLOAD` (failed Zod validation or malformed Yjs bytes) · `NOT_JOINED` · `FORBIDDEN` (not a member; the client stops retrying) ·
`READ_ONLY` (viewer tried to write; the web client then drops its local copy and reloads the server's version, at most once per 30 s) · `RATE_LIMITED` (token bucket, 120 burst / 60 per second per socket) · `INTERNAL` (before the handshake finishes the client re-sends `doc:join` with backoff).

## Limits
Update ≤ 4 MiB, state vector ≤ 64 KiB, awareness ≤ 2 KiB, Socket.IO buffer 5 MiB, 60-connection burst per IP, 20 auth requests burst per IP.
