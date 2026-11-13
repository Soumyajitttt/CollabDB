import * as Y from "yjs";

const ORIGIN = "broadcast-channel";

/**
 * Week 1 stand-in for the network: syncs a Y.Doc between tabs of the same browser.
 * Same idea as the real provider will be in Week 2 (state-vector handshake, then live updates).
 */
export function attachTabSync(doc: Y.Doc, name: string) {
  if (typeof BroadcastChannel === "undefined") return () => {};
  const ch = new BroadcastChannel(`collab-db:${name}`);

  const onUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === ORIGIN) return;
    ch.postMessage({ t: "update", u: update });
  };
  doc.on("update", onUpdate);

  ch.onmessage = (e: MessageEvent) => {
    const m = e.data;
    if (m.t === "update") Y.applyUpdate(doc, m.u, ORIGIN);
    else if (m.t === "sv") ch.postMessage({ t: "update", u: Y.encodeStateAsUpdate(doc, m.sv) });
  };
  // Ask peers for anything we're missing.
  ch.postMessage({ t: "sv", sv: Y.encodeStateVector(doc) });

  return () => {
    doc.off("update", onUpdate);
    ch.close();
  };
}
