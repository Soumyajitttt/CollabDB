import type { PresenceUser } from "@collab/shared";
import type { PresenceEntry } from "@collab/sync";

export const cellKey = (rowId: string, colId: string) => `${rowId}|${colId}`;

/** Who is on which cell. If several people share a cell, the lowest client id wins so the choice is stable. */
export function byCell(presence: readonly PresenceEntry[]): Map<string, PresenceEntry> {
  const out = new Map<string, PresenceEntry>();
  for (const p of [...presence].sort((a, b) => a.clientId - b.clientId)) {
    if (!p.cell) continue;
    const k = cellKey(p.cell.rowId, p.cell.colId);
    if (!out.has(k)) out.set(k, p);
  }
  return out;
}

/** One entry per person: the same user in two tabs counts once. */
export function uniqueUsers(presence: readonly PresenceEntry[]): PresenceUser[] {
  const seen = new Map<string, PresenceUser>();
  for (const p of presence) if (!seen.has(p.user.id)) seen.set(p.user.id, p.user);
  return [...seen.values()];
}
