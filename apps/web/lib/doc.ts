import * as Y from "yjs";
import { generateKeyBetween } from "fractional-indexing";
import { nanoid } from "nanoid";

export type ColumnType = "text" | "longtext" | "number" | "checkbox" | "select" | "date";

export interface ColumnInfo {
  id: string;
  name: string;
  type: ColumnType;
  order: string;
  options: string[];
}

export interface RowInfo {
  id: string;
  order: string;
}

export type CellValue = string | number | boolean | null;

type YRow = Y.Map<unknown>;
type YCol = Y.Map<unknown>;

export const LOCAL = "local";

export const rowsMap = (doc: Y.Doc) => doc.getMap<YRow>("rows");
export const colsMap = (doc: Y.Doc) => doc.getMap<YCol>("columns");

/** Sort by (order, id). The id tie-break keeps concurrent inserts deterministic. */
function byOrderThenId(a: { order: string; id: string }, b: { order: string; id: string }) {
  if (a.order < b.order) return -1;
  if (a.order > b.order) return 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function listColumns(doc: Y.Doc): ColumnInfo[] {
  const out: ColumnInfo[] = [];
  colsMap(doc).forEach((c, id) => {
    if (c.get("_deleted")) return;
    out.push({
      id,
      name: String(c.get("name") ?? ""),
      type: (c.get("type") as ColumnType) ?? "text",
      order: String(c.get("order") ?? "a0"),
      options: ((c.get("options") as string[] | undefined) ?? []).slice(),
    });
  });
  return out.sort(byOrderThenId);
}

export function listRows(doc: Y.Doc): RowInfo[] {
  const out: RowInfo[] = [];
  rowsMap(doc).forEach((r, id) => {
    if (r.get("_deleted")) return;
    out.push({ id, order: String(r.get("_order") ?? "a0") });
  });
  return out.sort(byOrderThenId);
}

export function addColumn(
  doc: Y.Doc,
  name: string,
  type: ColumnType = "text",
  afterOrder: string | null = null,
  options: string[] = [],
): string {
  const id = nanoid(8);
  doc.transact(() => {
    const col = new Y.Map<unknown>();
    col.set("name", name);
    col.set("type", type);
    col.set("order", generateKeyBetween(afterOrder, null));
    col.set("options", options);
    col.set("_deleted", false);
    colsMap(doc).set(id, col);
  }, LOCAL);
  return id;
}

export function renameColumn(doc: Y.Doc, colId: string, name: string) {
  const c = colsMap(doc).get(colId);
  if (c) doc.transact(() => c.set("name", name), LOCAL);
}

export function deleteColumn(doc: Y.Doc, colId: string) {
  const c = colsMap(doc).get(colId);
  if (c) doc.transact(() => c.set("_deleted", true), LOCAL);
}

export function insertRow(doc: Y.Doc, afterOrder: string | null = null, beforeOrder: string | null = null): string {
  const id = nanoid();
  doc.transact(() => {
    const row = new Y.Map<unknown>();
    row.set("_order", generateKeyBetween(afterOrder, beforeOrder));
    row.set("_deleted", false);
    rowsMap(doc).set(id, row);
  }, LOCAL);
  return id;
}

/** Append at the end. */
export function appendRow(doc: Y.Doc): string {
  const rows = listRows(doc);
  return insertRow(doc, rows[rows.length - 1]?.order ?? null, null);
}

export function deleteRow(doc: Y.Doc, rowId: string) {
  const r = rowsMap(doc).get(rowId);
  if (r) doc.transact(() => r.set("_deleted", true), LOCAL);
}

export function restoreRow(doc: Y.Doc, rowId: string) {
  const r = rowsMap(doc).get(rowId);
  if (r) doc.transact(() => r.set("_deleted", false), LOCAL);
}

/** Move a row so it sits between two neighbours (null = edge). */
export function moveRow(doc: Y.Doc, rowId: string, afterOrder: string | null, beforeOrder: string | null) {
  const r = rowsMap(doc).get(rowId);
  if (!r) return;
  doc.transact(() => r.set("_order", generateKeyBetween(afterOrder, beforeOrder)), LOCAL);
}

/** Move a row to a visible index among the current non-deleted rows. */
export function moveRowToIndex(doc: Y.Doc, rowId: string, toIndex: number) {
  const rows = listRows(doc).filter((r) => r.id !== rowId);
  const i = Math.max(0, Math.min(toIndex, rows.length));
  moveRow(doc, rowId, rows[i - 1]?.order ?? null, rows[i]?.order ?? null);
}

export function getCell(doc: Y.Doc, rowId: string, colId: string): CellValue | Y.Text | undefined {
  return rowsMap(doc).get(rowId)?.get(colId) as CellValue | Y.Text | undefined;
}

/** Display/primitive value; Y.Text collapses to string. */
export function getCellValue(doc: Y.Doc, rowId: string, colId: string): CellValue {
  const v = getCell(doc, rowId, colId);
  if (v instanceof Y.Text) return v.toString();
  return v === undefined ? null : v;
}

/** Whole-value write (last-writer-wins per cell). Not for longtext, use setLongText. */
export function setCell(doc: Y.Doc, rowId: string, colId: string, value: CellValue) {
  const r = rowsMap(doc).get(rowId);
  if (!r) return;
  doc.transact(() => r.set(colId, value), LOCAL);
}

/** longtext cells are Y.Text so concurrent typing merges per character. */
export function setLongText(doc: Y.Doc, rowId: string, colId: string, text: string) {
  const r = rowsMap(doc).get(rowId);
  if (!r) return;
  doc.transact(() => {
    let t = r.get(colId);
    if (!(t instanceof Y.Text)) {
      t = new Y.Text();
      r.set(colId, t);
    }
    const yt = t as Y.Text;
    const cur = yt.toString();
    if (cur === text) return;
    // Minimal diff: common prefix/suffix so we don't rewrite the whole text.
    let s = 0;
    while (s < cur.length && s < text.length && cur[s] === text[s]) s++;
    let e = 0;
    while (e < cur.length - s && e < text.length - s && cur[cur.length - 1 - e] === text[text.length - 1 - e]) e++;
    yt.delete(s, cur.length - s - e);
    yt.insert(s, text.slice(s, text.length - e));
  }, LOCAL);
}

/** Seed a fresh doc with a small starter table. Safe to call once on empty docs. */
export function seedIfEmpty(doc: Y.Doc) {
  if (colsMap(doc).size > 0 || rowsMap(doc).size > 0) return;
  doc.transact(() => {
    doc.getMap("meta").set("name", "Untitled table");
    doc.getMap("meta").set("schemaVersion", 1);
  }, LOCAL);
  const title = addColumn(doc, "Title", "text");
  const status = addColumn(doc, "Status", "select", listColumns(doc).at(-1)?.order ?? null, ["Todo", "Doing", "Done"]);
  const est = addColumn(doc, "Estimate", "number", listColumns(doc).at(-1)?.order ?? null);
  const done = addColumn(doc, "Done", "checkbox", listColumns(doc).at(-1)?.order ?? null);
  const notes = addColumn(doc, "Notes", "longtext", listColumns(doc).at(-1)?.order ?? null);
  const samples: [string, string, number, boolean, string][] = [
    ["Sketch the sync protocol", "Doing", 3, false, "State vectors first, then updates."],
    ["Write doc.ts helpers", "Done", 2, true, ""],
    ["Virtualize the grid", "Todo", 5, false, ""],
  ];
  for (const [t, s, n, d, no] of samples) {
    const id = appendRow(doc);
    setCell(doc, id, title, t);
    setCell(doc, id, status, s);
    setCell(doc, id, est, n);
    setCell(doc, id, done, d);
    if (no) setLongText(doc, id, notes, no);
  }
}

/** Bulk generator used by the 10k-row benchmark. One transaction, evenly spaced order keys. */
export function generateRows(doc: Y.Doc, count: number, colIds: string[]) {
  const rows = rowsMap(doc);
  let prev: string | null = listRows(doc).at(-1)?.order ?? null;
  doc.transact(() => {
    for (let i = 0; i < count; i++) {
      const key = generateKeyBetween(prev, null);
      prev = key;
      const row = new Y.Map<unknown>();
      row.set("_order", key);
      row.set("_deleted", false);
      colIds.forEach((c, j) => row.set(c, j === 0 ? `Row ${i + 1}` : j === 2 ? i % 100 : null));
      rows.set(nanoid(), row);
    }
  }, LOCAL);
}
