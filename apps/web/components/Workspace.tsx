"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { getToken, SERVER_URL } from "@/lib/api";
import { usePresence, useDoc, useSyncState } from "@/lib/useDoc";
import { uniqueUsers } from "@/lib/presence";
import { Grid } from "./grid/Grid";
import { BenchPanel } from "./grid/BenchPanel";
import { PresenceBar } from "./PresenceBar";
import { ShareDialog } from "./ShareDialog";

/** With a docId: synced, server-backed table. Without: the Week 1 browser-only table. */
export function Workspace({ docId }: { docId?: string }) {
  const { data: session, status: auth } = useSession();
  const sync = useMemo(() => (docId ? { url: SERVER_URL, docId, getToken } : null), [docId]);
  const ready = !docId || auth === "authenticated";
  const storageName = docId ? `${session?.user?.id ?? "anon"}:${docId}` : "main";
  const state = useDoc(ready ? storageName : null, ready ? sync : null);
  const net = useSyncState(state?.provider ?? null);
  const presence = usePresence(state?.provider ?? null);
  const [paused, setPaused] = useState(false);
  const [sharing, setSharing] = useState(false);
  const scrollHook = useRef<() => void>(() => {});

  const wipeLocalAndReload = async () => {
    await new Promise<void>((res) => {
      const req = indexedDB.deleteDatabase(`collab-db:${storageName}`);
      req.onsuccess = req.onerror = req.onblocked = () => res();
    });
    location.reload();
  };
  const reset = async () => {
    if (!confirm("Delete the local copy of this table on this device? Synced data stays on the server.")) return;
    await wipeLocalAndReload();
  };

  // The server refused a write (READ_ONLY): our local copy has drifted from what it accepted,
  // so throw it away and load the server's version. Guarded so it can never loop.
  const readOnlyError = net?.lastError?.code === "READ_ONLY";
  useEffect(() => {
    if (!readOnlyError) return;
    const key = `collab-db:resync:${storageName}`;
    const last = Number(sessionStorage.getItem(key) ?? 0);
    if (Date.now() - last < 30_000) return;
    sessionStorage.setItem(key, String(Date.now()));
    void wipeLocalAndReload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnlyError]);

  const togglePaused = () => {
    if (!state?.provider) return;
    if (paused) state.provider.resume();
    else state.provider.pause();
    setPaused(!paused);
  };

  const forbidden = net?.lastError?.code === "FORBIDDEN";
  const label = !docId
    ? "Saved in this browser"
    : !net ? "Opening…"
    : net.status === "synced" ? (net.pending > 0 ? "Saving…" : "Synced")
    : net.status === "syncing" ? "Syncing…"
    : net.status === "connecting" ? "Connecting…"
    : "Offline: edits are saved on this device";
  const tone = !net ? "" : net.status === "synced" && net.pending === 0 ? "ok" : net.status === "offline" ? "off" : "warn";

  return (
    <main className="shell">
      <header className="top">
        {docId && <Link href="/" className="back">← Tables</Link>}
        <h1>CollabDB</h1>
        <span className={`pill ${tone}`} role="status">{label}</span>
        {net?.role && <span className="pill">{net.role}</span>}
        <PresenceBar me={net?.me ?? null} others={uniqueUsers(presence).filter((u) => u.id !== net?.me?.id)} />
        <span className="status" />
        {net?.role === "owner" && <button className="btn" onClick={() => setSharing(true)}>Share</button>}
        {state?.provider && (
          <button className="btn ghost" onClick={togglePaused} title="Testing aid: disconnect this tab from the server, edit, then reconnect to watch the merge">
            {paused ? "Go online" : "Go offline"}
          </button>
        )}
        <button className="btn ghost" onClick={reset}>Reset local copy</button>
      </header>

      {forbidden && <p className="banner" role="alert">You don’t have access to this table (or it was just removed from you). Ask its owner to share it with you.</p>}
      {net?.role === "viewer" && <p className="banner">View only: you can follow along, but you can’t edit this table.</p>}

      {state?.status === "ready" && !forbidden ? (
        <>
          <Grid doc={state.doc} provider={state.provider} readOnly={net?.role === "viewer"} onScrollFrame={() => scrollHook.current()} />
          {net?.role !== "viewer" && <BenchPanel doc={state.doc} registerScroll={(fn) => (scrollHook.current = fn)} />}
        </>
      ) : !forbidden ? (
        <div className="loading">Opening table…</div>
      ) : null}
      {sharing && docId && <ShareDialog docId={docId} onClose={() => setSharing(false)} />}
    </main>
  );
}
