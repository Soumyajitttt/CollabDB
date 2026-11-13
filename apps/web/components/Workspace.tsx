"use client";

import { useRef } from "react";
import { useDoc } from "@/lib/useDoc";
import { Grid } from "./grid/Grid";
import { BenchPanel } from "./grid/BenchPanel";

const NAME = "main";

export function Workspace() {
  const state = useDoc(NAME);
  const scrollHook = useRef<() => void>(() => {});

  const reset = async () => {
    if (!confirm("Delete the local copy of this table? This cannot be undone.")) return;
    await new Promise<void>((res) => {
      const req = indexedDB.deleteDatabase(`collab-db:${NAME}`);
      req.onsuccess = req.onerror = req.onblocked = () => res();
    });
    location.reload();
  };

  return (
    <main className="shell">
      <header className="top">
        <h1>CollabDB</h1>
        <span className="status">{state?.status === "ready" ? "Saved in this browser" : "Opening table…"}</span>
        <button className="btn ghost" onClick={reset}>Reset local data</button>
      </header>
      {state?.status === "ready" ? (
        <>
          <Grid doc={state.doc} onScrollFrame={() => scrollHook.current()} />
          <BenchPanel doc={state.doc} registerScroll={(fn) => (scrollHook.current = fn)} />
        </>
      ) : (
        <div className="loading">Opening table…</div>
      )}
    </main>
  );
}
