"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import * as Y from "yjs";
import { IndexeddbPersistence } from "y-indexeddb";
import { attachTabSync } from "./tabSync";
import { CellValue, ColumnInfo, RowInfo, getCellValue, listColumns, listRows, rowsMap, seedIfEmpty } from "./doc";

export type DocStatus = "loading" | "ready";

/** Creates the Y.Doc, persists it to IndexedDB, mirrors it across tabs. */
export function useDoc(name: string) {
  const [state, setState] = useState<{ doc: Y.Doc; status: DocStatus } | null>(null);

  useEffect(() => {
    const doc = new Y.Doc();
    const idb = new IndexeddbPersistence(`collab-db:${name}`, doc);
    const detach = attachTabSync(doc, name);
    let alive = true;
    setState({ doc, status: "loading" });
    idb.whenSynced.then(() => {
      if (!alive) return;
      seedIfEmpty(doc);
      setState({ doc, status: "ready" });
    });
    return () => {
      alive = false;
      detach();
      idb.destroy();
      doc.destroy();
    };
  }, [name]);

  return state;
}

/**
 * Structure = which rows/columns exist, in what order. Cell edits do NOT change it,
 * so typing in a cell never re-renders the grid shell.
 */
export function useStructure(doc: Y.Doc) {
  const cache = useRef<{ rows: RowInfo[]; cols: ColumnInfo[]; v: number }>({ rows: [], cols: [], v: -1 });
  const version = useRef(0);

  const subscribe = useCallback(
    (notify: () => void) => {
      const rows = doc.getMap("rows");
      const cols = doc.getMap("columns");
      const onRows = (events: Y.YEvent<any>[]) => {
        const structural = events.some((e) => {
          if (e.path.length === 0) return true; // row added / removed
          if (e.path.length === 1 && e.target instanceof Y.Map) {
            const keys = (e as Y.YMapEvent<unknown>).keysChanged;
            return keys.has("_order") || keys.has("_deleted");
          }
          return false;
        });
        if (structural) {
          version.current++;
          notify();
        }
      };
      const onCols = () => {
        version.current++;
        notify();
      };
      rows.observeDeep(onRows);
      cols.observeDeep(onCols);
      return () => {
        rows.unobserveDeep(onRows);
        cols.unobserveDeep(onCols);
      };
    },
    [doc],
  );

  const getSnapshot = useCallback(() => {
    if (cache.current.v !== version.current) {
      cache.current = { rows: listRows(doc), cols: listColumns(doc), v: version.current };
    }
    return cache.current;
  }, [doc]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Subscribes to ONE cell. Only this cell re-renders when its value changes. */
export function useCell(doc: Y.Doc, rowId: string, colId: string): CellValue {
  const subscribe = useCallback(
    (notify: () => void) => {
      const row = rowsMap(doc).get(rowId);
      if (!row) return () => {};
      const handler = (events: Y.YEvent<any>[]) => {
        for (const e of events) {
          if (e.target === row && (e as Y.YMapEvent<unknown>).keysChanged.has(colId)) return notify();
          if (e.target instanceof Y.Text && e.target === row.get(colId)) return notify();
        }
      };
      row.observeDeep(handler);
      return () => row.unobserveDeep(handler);
    },
    [doc, rowId, colId],
  );
  const get = useCallback(() => getCellValue(doc, rowId, colId), [doc, rowId, colId]);
  return useSyncExternalStore(subscribe, get, () => null);
}

