"use client";

import { useEffect, useRef, useState } from "react";
import type * as Y from "yjs";
import { generateRows, listColumns, listRows, setCell } from "@/lib/doc";

const nextPaint = () => new Promise<void>((res) => requestAnimationFrame(() => requestAnimationFrame(() => res())));

export interface BenchHandle { onScroll: () => void }

/** Collects the Week 1 numbers: 10k initial render, scroll FPS, single-cell edit to paint. */
export function BenchPanel({ doc, registerScroll }: { doc: Y.Doc; registerScroll: (fn: () => void) => void }) {
  const [out, setOut] = useState<{ gen?: number; render?: number; fps?: number; edit?: number; rows?: number }>({});
  const [busy, setBusy] = useState(false);
  const frames = useRef<number[]>([]);
  const scrolling = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    registerScroll(() => {
      frames.current.push(performance.now());
      if (scrolling.current) clearTimeout(scrolling.current);
      scrolling.current = setTimeout(() => {
        const f = frames.current;
        frames.current = [];
        if (f.length > 10) {
          const secs = ((f.at(-1) as number) - (f[0] as number)) / 1000;
          if (secs > 0.2) setOut((o) => ({ ...o, fps: Math.round((f.length - 1) / secs) }));
        }
      }, 250);
    });
  }, [registerScroll]);

  const load = async () => {
    setBusy(true);
    await nextPaint();
    const cols = listColumns(doc).map((c) => c.id);
    const t0 = performance.now();
    generateRows(doc, 10_000, cols);
    const t1 = performance.now();
    await nextPaint();
    const t2 = performance.now();
    setOut((o) => ({ ...o, gen: Math.round(t1 - t0), render: Math.round(t2 - t1), rows: listRows(doc).length }));
    setBusy(false);
  };

  const edit = async () => {
    const rows = listRows(doc);
    const cols = listColumns(doc);
    const r = rows[0], c = cols[0];
    if (!r || !c) return;
    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t = performance.now();
      setCell(doc, r.id, c.id, `bench ${i}`);
      await nextPaint();
      samples.push(performance.now() - t);
    }
    samples.sort((a, b) => a - b);
    setOut((o) => ({ ...o, edit: Math.round((samples[Math.floor(samples.length / 2)] as number) * 10) / 10 }));
  };

  return (
    <aside className="bench" aria-label="Benchmark">
      <div className="bench-actions">
        <button className="btn" onClick={load} disabled={busy}>{busy ? "Loading…" : "Add 10,000 rows"}</button>
        <button className="btn" onClick={edit}>Time a cell edit</button>
      </div>
      <dl>
        <div><dt>Rows</dt><dd>{out.rows ?? "–"}</dd></div>
        <div><dt>Generate</dt><dd>{out.gen !== undefined ? `${out.gen} ms` : "–"}</dd></div>
        <div><dt>Render after load</dt><dd>{out.render !== undefined ? `${out.render} ms` : "–"}</dd></div>
        <div><dt>Scroll</dt><dd>{out.fps !== undefined ? `${out.fps} fps` : "scroll the grid"}</dd></div>
        <div><dt>Edit to paint (median)</dt><dd>{out.edit !== undefined ? `${out.edit} ms` : "–"}</dd></div>
      </dl>
    </aside>
  );
}
