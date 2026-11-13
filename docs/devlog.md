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
