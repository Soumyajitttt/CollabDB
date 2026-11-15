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
| `doc:joined` | S→C | `{docId, role}` | role = owner / editor / viewer |
| `sync:step1` | C→S | `{docId, stateVector}` | "Here is what I have." |
| `sync:step2` | S→C | `{docId, update}` | What the client is missing. |
| `sync:request` | S→C | `{docId, stateVector}` | "Send me what I'm missing." |
| `sync:update` | C→S | `{docId, update, clientSeq}` | Live edit or handshake diff. |
| `sync:update` | S→C | `{docId, update}` | Another client's edit (never echoed to the sender). |
| `sync:ack` | S→C | `{docId, clientSeq}` | Sent AFTER the update is stored in Postgres. |
| `doc:error` | S→C | `{code, message?}` | See below. |

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

## Errors (`doc:error.code`)
`BAD_PAYLOAD` (failed Zod validation or malformed Yjs bytes) · `NOT_JOINED` · `FORBIDDEN` (not a member; the client stops retrying) ·
`READ_ONLY` (viewer tried to write) · `RATE_LIMITED` (token bucket, 120 burst / 60 per second per socket) · `INTERNAL`.

## Limits
Update ≤ 4 MiB, state vector ≤ 64 KiB, Socket.IO buffer 5 MiB, 60-connection burst per IP, 20 auth requests burst per IP.
