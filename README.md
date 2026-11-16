# CollabDB

Collaborative table editor: Next.js + Yjs on the client, a Socket.IO sync server with Postgres persistence, NextAuth for login.

```
apps/web        Next.js app (grid, login, document list)
apps/server     Express + Socket.IO + Postgres
packages/shared Zod schemas, event names, JWT helpers (used by both)
packages/sync   Client SyncProvider (Yjs <-> Socket.IO)
docs/           protocol.md, devlog.md
```

## Run it (Week 2)

Needs Node 20+ and Docker (for Postgres).

```bash
npm install
npm run db:up                      # Postgres 16 on localhost:5432

# secrets: generate two different values with
#   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
cp apps/server/.env.example apps/server/.env          # set JWT_SECRET
cp apps/web/.env.local.example apps/web/.env.local    # set NEXTAUTH_SECRET and the SAME JWT_SECRET

npm run dev:server                 # terminal 1: http://localhost:4000 (runs migrations on start)
npm run dev:web                    # terminal 2: http://localhost:3000
```

Open http://localhost:3000, create an account, create a table. Open the same table in a second window
(same account; sharing with other accounts arrives in Week 3) and edit: changes appear in both.

**Try offline merge:** in each window press **Go offline**, edit the same row in both, press **Go online**.

**Try sharing and presence (Week 3):** register a second account, open a table you own, press **Share**, add that account's email as *Can edit* or *Can view*.
Sign in as the second account in a private window: you will see each other's avatars and cursors, and a viewer's grid is read-only.
Change the role or remove the person in the Share dialog while they are connected and watch it apply instantly.

## Auth design
NextAuth keeps the browser session (JWT strategy, httpOnly cookie). Passwords are verified by the server with bcrypt.
`GET /api/token` turns the session into a 10-minute JWT that the server verifies for REST and for the socket handshake.
`JWT_SECRET` must match in both `.env` files.

## Commands
| | |
|---|---|
| `npm test` | all tests. DB tests skip (with a warning) if Postgres is down; `REQUIRE_DB=1` makes that a failure |
| `npm run typecheck` | TypeScript across all packages |
| `npm run bench:latency -w apps/server` | edit-to-remote and edit-to-ack latency (needs `apps/server/.env`) |
| `npm run bench:compaction -w apps/server` | rows, bytes and load time before/after compaction of a 50,000-update session |
| `npm run smoke -w apps/server` | full-stack check (sign-in, token, sync, sharing, presence); start both servers first |
| `npm run migrate` | apply SQL migrations manually (the server also does this on start) |
