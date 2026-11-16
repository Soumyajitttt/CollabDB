"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type * as Y from "yjs";
import { ColumnDef, createColumnHelper, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { SyncProvider } from "@collab/sync";
import { usePresence, useStructure } from "@/lib/useDoc";
import { byCell, cellKey } from "@/lib/presence";
import {
  ColumnInfo, ColumnType, RowInfo, addColumn, appendRow, deleteColumn, deleteRow, insertRow,
  moveRowToIndex, renameColumn, setCell, setLongText,
} from "@/lib/doc";
import { Cell } from "./Cell";

const ROW_H = 36;
const COL_W = 180;
const GUTTER_W = 64;
const ADD_W = 56;

const helper = createColumnHelper<RowInfo>();
const TYPES: ColumnType[] = ["text", "longtext", "number", "checkbox", "select", "date"];

export function Grid({
  doc, provider = null, readOnly = false, onScrollFrame,
}: { doc: Y.Doc; provider?: SyncProvider | null; readOnly?: boolean; onScrollFrame?: () => void }) {
  const { rows, cols } = useStructure(doc);
  const presence = usePresence(provider);
  const remote = useMemo(() => byCell(presence), [presence]);
  // Don't announce a cursor on row 1 before the person has touched the grid.
  const [engaged, setEngaged] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<{ r: number; c: number }>({ r: 0, c: 0 });
  const [editing, setEditing] = useState(false);
  const [seed, setSeed] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropIdx, setDropIdx] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);

  const columns = useMemo<ColumnDef<RowInfo, any>[]>(
    () => cols.map((c) => helper.display({ id: c.id, header: c.name, size: COL_W })),
    [cols],
  );
  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel(), getRowId: (r) => r.id });
  const tableRows = table.getRowModel().rows;
  const headers = table.getHeaderGroups()[0]?.headers ?? [];

  const virtual = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 8,
  });

  useEffect(() => {
    if (!provider) return;
    const row = rows[active.r];
    const col = cols[active.c];
    provider.setPresence(engaged && row && col ? { rowId: row.id, colId: col.id } : null, engaged && editing && !readOnly);
  }, [provider, rows, cols, active, editing, engaged, readOnly]);

  const width = GUTTER_W + cols.length * COL_W + ADD_W;
  const template = `${GUTTER_W}px repeat(${cols.length}, ${COL_W}px) ${ADD_W}px`;
  const focusGrid = () => gridRef.current?.focus();

  const clamp = useCallback(
    (r: number, c: number) => ({
      r: Math.max(0, Math.min(r, Math.max(0, rows.length - 1))),
      c: Math.max(0, Math.min(c, Math.max(0, cols.length - 1))),
    }),
    [rows.length, cols.length],
  );
  const moveTo = (r: number, c: number) => {
    const n = clamp(r, c);
    setActive(n);
    virtual.scrollToIndex(n.r, { align: "auto" });
  };

  const endEdit = (move: "down" | "right" | "left" | "none") => {
    setEditing(false);
    setSeed(null);
    if (move === "down") moveTo(active.r + 1, active.c);
    if (move === "right") moveTo(active.r, active.c + 1);
    if (move === "left") moveTo(active.r, active.c - 1);
    focusGrid();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (editing || e.metaKey || e.ctrlKey || e.altKey) return;
    setEngaged(true);
    const col = cols[active.c];
    const row = rows[active.r];
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); return moveTo(active.r + 1, active.c);
      case "ArrowUp": e.preventDefault(); return moveTo(active.r - 1, active.c);
      case "ArrowRight": e.preventDefault(); return moveTo(active.r, active.c + 1);
      case "ArrowLeft": e.preventDefault(); return moveTo(active.r, active.c - 1);
      case "Tab": e.preventDefault(); return moveTo(active.r, active.c + (e.shiftKey ? -1 : 1));
    }
    if (!col || !row || readOnly) return;
    if (e.key === "Enter" || e.key === "F2" || (e.key === " " && col.type === "checkbox")) {
      e.preventDefault();
      if (col.type === "checkbox") {
        const cur = doc.getMap<Y.Map<unknown>>("rows").get(row.id)?.get(col.id) === true;
        return setCell(doc, row.id, col.id, !cur);
      }
      setSeed(null);
      return setEditing(true);
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      return col.type === "longtext" ? setLongText(doc, row.id, col.id, "") : setCell(doc, row.id, col.id, null);
    }
    if (e.key.length === 1 && ["text", "number", "date"].includes(col.type) && col.type !== "date") {
      e.preventDefault();
      setSeed(e.key);
      setEditing(true);
    }
  };

  const submitColumn = (f: FormData) => {
    const name = String(f.get("name") || "").trim() || "Untitled";
    const type = String(f.get("type")) as ColumnType;
    const options = String(f.get("options") || "").split(",").map((s) => s.trim()).filter(Boolean);
    addColumn(doc, name, type, cols.at(-1)?.order ?? null, type === "select" ? (options.length ? options : ["Option 1", "Option 2"]) : []);
    setAdding(false);
  };

  return (
    <div className="grid-wrap">
      <div className="grid-scroll" ref={scrollRef} onScroll={onScrollFrame}>
        <div
          ref={gridRef}
          className="grid"
          role="grid"
          aria-rowcount={rows.length}
          aria-colcount={cols.length}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onFocus={() => setEngaged(true)}
          aria-readonly={readOnly || undefined}
          style={{ width, height: ROW_H + virtual.getTotalSize() }}
        >
          <div className="grid-head" role="row" style={{ gridTemplateColumns: template }}>
            <div className="hcell gutter" />
            {headers.map((h, i) => {
              const col = cols[i] as ColumnInfo;
              return (
                <div key={h.id} className="hcell" role="columnheader">
                  {renaming === col.id ? (
                    <input
                      className="editor"
                      autoFocus
                      defaultValue={col.name}
                      onBlur={(e) => { renameColumn(doc, col.id, e.target.value.trim() || col.name); setRenaming(null); }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                        if (e.key === "Escape") setRenaming(null);
                      }}
                    />
                  ) : (
                    <>
                      <span className="hname" onDoubleClick={readOnly ? undefined : () => setRenaming(col.id)} title={readOnly ? undefined : "Double-click to rename"}>
                        {col.name}
                      </span>
                      <span className="htype">{col.type}</span>
                      {!readOnly && <button className="icon-btn" aria-label={`Delete column ${col.name}`} onClick={() => deleteColumn(doc, col.id)}>×</button>}
                    </>
                  )}
                </div>
              );
            })}
            <div className="hcell add">
              {!readOnly && <button className="icon-btn always" aria-label="Add column" onClick={() => setAdding((a) => !a)}>+</button>}
              {adding && !readOnly && (
                <div className="popover" onKeyDown={(e) => e.key === "Escape" && setAdding(false)}>
                  <div
                    role="group"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        const root = e.currentTarget as HTMLElement;
                        const fd = new FormData();
                        root.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[name]").forEach((el) => fd.set(el.name, el.value));
                        submitColumn(fd);
                      }
                    }}
                  >
                    <label>Name<input name="name" autoFocus placeholder="Column name" /></label>
                    <label>Type<select name="type" defaultValue="text">{TYPES.map((t) => <option key={t}>{t}</option>)}</select></label>
                    <label>Select options<input name="options" placeholder="Todo, Doing, Done" /></label>
                    <button
                      className="btn primary"
                      onClick={(e) => {
                        const root = (e.currentTarget.parentElement as HTMLElement);
                        const fd = new FormData();
                        root.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[name]").forEach((el) => fd.set(el.name, el.value));
                        submitColumn(fd);
                      }}
                    >Add column</button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {rows.length === 0 && <div className="empty">No rows yet. Use “Add row” to start.</div>}

          {virtual.getVirtualItems().map((v) => {
            const row = tableRows[v.index];
            if (!row) return null;
            const rowId = row.original.id;
            return (
              <div
                key={rowId}
                className={`grid-row${dragId === rowId ? " dragging" : ""}${dropIdx === v.index && dragId ? " drop-target" : ""}`}
                role="row"
                aria-rowindex={v.index + 1}
                style={{ gridTemplateColumns: template, transform: `translateY(${ROW_H + v.start}px)`, height: ROW_H }}
                onDragOver={(e) => { if (dragId) { e.preventDefault(); setDropIdx(v.index); } }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragId) moveRowToIndex(doc, dragId, v.index);
                  setDragId(null); setDropIdx(null);
                }}
              >
                <div
                  className="gutter"
                  draggable={!readOnly}
                  onDragStart={(e) => { setDragId(rowId); e.dataTransfer.effectAllowed = "move"; }}
                  onDragEnd={() => { setDragId(null); setDropIdx(null); }}
                  title={readOnly ? undefined : "Drag to reorder"}
                >
                  <span className="rownum">{v.index + 1}</span>
                  {!readOnly && <button className="icon-btn" aria-label={`Delete row ${v.index + 1}`} onClick={() => deleteRow(doc, rowId)}>×</button>}
                </div>
                {cols.map((col, ci) => {
                  const who = remote.get(cellKey(rowId, col.id));
                  return (
                    <Cell
                      key={col.id}
                      doc={doc}
                      rowId={rowId}
                      col={col}
                      active={active.r === v.index && active.c === ci}
                      editing={editing && active.r === v.index && active.c === ci}
                      seed={seed}
                      readOnly={readOnly}
                      remoteName={who?.user.name}
                      remoteColor={who?.user.color}
                      remoteEditing={who?.editing}
                      onSelect={() => { setEngaged(true); setActive({ r: v.index, c: ci }); if (editing) setEditing(false); }}
                      onStartEdit={() => { setSeed(null); setEditing(true); }}
                      onEnd={endEdit}
                    />
                  );
                })}
                <div />
              </div>
            );
          })}
        </div>
      </div>
      <div className="grid-foot">
        <button className="btn" disabled={readOnly} onClick={() => { appendRow(doc); setTimeout(() => moveTo(rows.length, active.c), 0); }}>Add row</button>
        <button
          className="btn"
          disabled={readOnly || !rows[active.r]}
          onClick={() => { const r = rows[active.r]; if (r) insertRow(doc, r.order, rows[active.r + 1]?.order ?? null); }}
        >Insert below</button>
        <span className="hint">{readOnly ? "View only: arrows move your cursor" : "Arrows move · Enter edits · Tab next cell · Esc cancels · Delete clears"}</span>
      </div>
    </div>
  );
}
