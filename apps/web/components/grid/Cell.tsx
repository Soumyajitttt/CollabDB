"use client";

import { memo, useEffect, useRef, useState } from "react";
import type * as Y from "yjs";
import { useCell } from "@/lib/useDoc";
import { CellValue, ColumnInfo, setCell, setLongText } from "@/lib/doc";

interface Props {
  doc: Y.Doc;
  rowId: string;
  col: ColumnInfo;
  active: boolean;
  editing: boolean;
  seed: string | null; // first typed character when editing starts by typing
  readOnly?: boolean;
  /** Someone else is on this cell. Primitives, so React.memo only re-renders cells that really change. */
  remoteName?: string;
  remoteColor?: string;
  remoteEditing?: boolean;
  onSelect: () => void;
  onStartEdit: () => void;
  onEnd: (move: "down" | "right" | "left" | "none") => void;
}

function display(col: ColumnInfo, v: CellValue) {
  if (v === null || v === "") return "";
  return String(v);
}

export const Cell = memo(function Cell({
  doc, rowId, col, active, editing, seed, readOnly, remoteName, remoteColor, remoteEditing, onSelect, onStartEdit, onEnd,
}: Props) {
  const value = useCell(doc, rowId, col.id);
  const cls = `cell${active ? " is-active" : ""}${col.type === "number" ? " is-num" : ""}${remoteColor ? " has-remote" : ""}`;
  const ring = remoteColor && !active ? { boxShadow: `inset 0 0 0 2px ${remoteColor}` } : undefined;
  const tag = remoteName ? (
    <span className="rtag" style={{ background: remoteColor }} title={`${remoteName}${remoteEditing ? " is editing" : ""}`}>
      {remoteEditing ? "✎ " : ""}{remoteName}
    </span>
  ) : null;

  if (col.type === "checkbox") {
    return (
      <div className={cls} style={ring} role="gridcell" onMouseDown={onSelect}>
        <input
          type="checkbox"
          className="check"
          checked={value === true}
          disabled={readOnly}
          aria-label={col.name}
          onChange={(e) => setCell(doc, rowId, col.id, e.target.checked)}
          tabIndex={-1}
        />
        {tag}
      </div>
    );
  }

  return (
    <div className={cls} style={ring} role="gridcell" onMouseDown={onSelect} onDoubleClick={readOnly ? undefined : onStartEdit}>
      {editing && !readOnly ? (
        <Editor doc={doc} rowId={rowId} col={col} value={value} seed={seed} onEnd={onEnd} />
      ) : (
        <span className={col.type === "longtext" ? "clip" : undefined}>{display(col, value)}</span>
      )}
      {tag}
    </div>
  );
});

function Editor({
  doc, rowId, col, value, seed, onEnd,
}: Pick<Props, "doc" | "rowId" | "col" | "seed" | "onEnd"> & { value: CellValue }) {
  const [draft, setDraft] = useState(seed ?? (value === null ? "" : String(value)));
  const done = useRef(false);
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement & HTMLSelectElement>(null);

  useEffect(() => {
    ref.current?.focus();
    if (seed === null && ref.current && "select" in ref.current && col.type !== "longtext") ref.current.select?.();
  }, [seed, col.type]);

  const commit = (move: "down" | "right" | "left" | "none", text = draft) => {
    if (done.current) return;
    done.current = true;
    if (col.type === "number") {
      const t = text.trim();
      if (t === "") setCell(doc, rowId, col.id, null);
      else if (!Number.isNaN(Number(t))) setCell(doc, rowId, col.id, Number(t));
    } else if (col.type === "longtext") {
      // already applied live
    } else {
      setCell(doc, rowId, col.id, text === "" ? null : text);
    }
    onEnd(move);
  };
  const cancel = () => {
    if (done.current) return;
    done.current = true;
    onEnd("none");
  };

  const onKey = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") return cancel();
    if (e.key === "Enter" && !(col.type === "longtext" && e.shiftKey)) {
      e.preventDefault();
      return commit("down");
    }
    if (e.key === "Tab") {
      e.preventDefault();
      return commit(e.shiftKey ? "left" : "right");
    }
  };

  if (col.type === "select") {
    return (
      <select
        ref={ref}
        className="editor"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          commit("none", e.target.value);
        }}
        onKeyDown={onKey}
        onBlur={() => cancel()}
      >
        <option value="">(none)</option>
        {col.options.map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
    );
  }

  if (col.type === "longtext") {
    // Live-applied so concurrent typing merges per character (Esc just closes).
    const text = value === null ? "" : String(value);
    return (
      <textarea
        ref={ref}
        className="editor editor-long"
        value={text}
        onChange={(e) => setLongText(doc, rowId, col.id, e.target.value)}
        onKeyDown={onKey}
        onBlur={() => commit("none")}
      />
    );
  }

  return (
    <input
      ref={ref}
      className="editor"
      type={col.type === "date" ? "date" : "text"}
      inputMode={col.type === "number" ? "decimal" : undefined}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={onKey}
      onBlur={() => commit("none")}
    />
  );
}
