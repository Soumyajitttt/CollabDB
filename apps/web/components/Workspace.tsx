"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { getToken, SERVER_URL } from "@/lib/api";
import { useDoc, useSyncState } from "@/lib/useDoc";
import { Grid } from "./grid/Grid";
import { BenchPanel } from "./grid/BenchPanel";

/** With a docId: synced, server-backed table. Without: the Week 1 browser-only table. */
export function Workspace({ docId }: { docId?: string }) {
  const { data: session, status: auth } = useSession();
  const sync = useMemo(() => (docId ? { url: SERVER_URL, docId, getToken } : null), [docId]);
  const ready = !docId || auth === "authenticated";
  const storageName = docId ? `${session?.user?.id ?? "anon"}:${docId}` : "main";
  const state = useDoc(ready ? storageName : null, ready ? sync : null);
  const net = useSyncState(state?.provider ?? null);
  const [paused, setPaused] = useState(false);
  const scrollHook = useRef<() => void>(() => {});

  const reset = async () => {
    if (!confirm("Delete the local copy of this table on this device? Synced data stays on the server.")) return;
    await new Promise<void>((res) => {
      const req = indexedDB.deleteDatabase(`collab-db:${storageName}`);
      req.onsuccess = req.onerror = req.onblocked = () => res();
    });
    location.reload();
  };

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
        <span className="status" />
        {state?.provider && (
          <button className="btn ghost" onClick={togglePaused} title="Testing aid: disconnect this tab from the server, edit, then reconnect to watch the merge">
            {paused ? "Go online" : "Go offline"}
          </button>
        )}
        <button className="btn ghost" onClick={reset}>Reset local copy</button>
      </header>

      {forbidden && <p className="banner" role="alert">You don’t have access to this table. Ask its owner to share it with you.</p>}
      {net?.role === "viewer" && <p className="banner">View only: the server ignores edits from viewers.</p>}

      {state?.status === "ready" && !forbidden ? (
        <>
          <Grid doc={state.doc} onScrollFrame={() => scrollHook.current()} />
          <BenchPanel doc={state.doc} registerScroll={(fn) => (scrollHook.current = fn)} />
        </>
      ) : !forbidden ? (
        <div className="loading">Opening table…</div>
      ) : null}
    </main>
  );
}
