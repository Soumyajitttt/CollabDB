import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { AwarenessInput, AwarenessState, MAX_AWARENESS_ENTRIES, PresenceUser } from "@collab/shared";

/** One client's entry inside a y-protocols awareness update. */
export interface AwarenessEntry {
  clientId: number;
  clock: number;
  state: unknown; // JSON, null = the client left
}

/** Throws on anything malformed. Wire format: varUint count, then (clientId, clock, JSON string)*. */
export function decodeAwareness(update: Uint8Array): AwarenessEntry[] {
  const dec = decoding.createDecoder(update);
  const len = decoding.readVarUint(dec);
  if (len < 1 || len > MAX_AWARENESS_ENTRIES) throw new Error("bad entry count");
  const out: AwarenessEntry[] = [];
  for (let i = 0; i < len; i++) {
    const clientId = decoding.readVarUint(dec);
    const clock = decoding.readVarUint(dec);
    const state = JSON.parse(decoding.readVarString(dec));
    if (!Number.isSafeInteger(clientId) || !Number.isSafeInteger(clock)) throw new Error("bad id");
    out.push({ clientId, clock, state });
  }
  if (decoding.hasContent(dec)) throw new Error("trailing bytes");
  return out;
}

export function encodeAwareness(entries: AwarenessEntry[]): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, entries.length);
  for (const e of entries) {
    encoding.writeVarUint(enc, e.clientId);
    encoding.writeVarUint(enc, e.clock);
    encoding.writeVarString(enc, JSON.stringify(e.state));
  }
  return encoding.toUint8Array(enc);
}

/**
 * Validate every entry against the schema and stamp the server's idea of who the user is.
 * Returns null if anything is invalid (the whole update is then rejected).
 */
export function sanitizeEntries(entries: AwarenessEntry[], user: PresenceUser): AwarenessEntry[] | null {
  const out: AwarenessEntry[] = [];
  for (const e of entries) {
    const parsed = AwarenessInput.safeParse(e.state);
    if (!parsed.success) return null;
    const state: AwarenessState | null = parsed.data === null ? null : { user, cell: parsed.data.cell, editing: parsed.data.editing };
    out.push({ clientId: e.clientId, clock: e.clock, state });
  }
  return out;
}
