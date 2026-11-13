import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  addColumn, appendRow, deleteColumn, deleteRow, getCellValue, insertRow, listColumns, listRows,
  moveRow, moveRowToIndex, renameColumn, restoreRow, seedIfEmpty, setCell, setLongText,
} from "./doc";

const sync = (a: Y.Doc, b: Y.Doc) => {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
};

describe("columns", () => {
  it("adds, renames, soft-deletes and keeps order", () => {
    const d = new Y.Doc();
    const a = addColumn(d, "A");
    const b = addColumn(d, "B", "number", listColumns(d)[0]!.order);
    expect(listColumns(d).map((c) => c.name)).toEqual(["A", "B"]);
    renameColumn(d, a, "Alpha");
    expect(listColumns(d)[0]!.name).toBe("Alpha");
    deleteColumn(d, b);
    expect(listColumns(d)).toHaveLength(1);
  });
});

describe("rows", () => {
  it("appends in order and inserts between", () => {
    const d = new Y.Doc();
    const r1 = appendRow(d);
    const r3 = appendRow(d);
    const [o1, o3] = listRows(d).map((r) => r.order);
    const r2 = insertRow(d, o1!, o3!);
    expect(listRows(d).map((r) => r.id)).toEqual([r1, r2, r3]);
  });

  it("soft-deletes and restores", () => {
    const d = new Y.Doc();
    const r = appendRow(d);
    deleteRow(d, r);
    expect(listRows(d)).toHaveLength(0);
    restoreRow(d, r);
    expect(listRows(d)).toHaveLength(1);
  });

  it("moves rows by neighbours and by index", () => {
    const d = new Y.Doc();
    const [a, b, c] = [appendRow(d), appendRow(d), appendRow(d)];
    moveRowToIndex(d, c, 0);
    expect(listRows(d).map((r) => r.id)).toEqual([c, a, b]);
    const rows = listRows(d);
    moveRow(d, c, rows[2]!.order, null);
    expect(listRows(d).map((r) => r.id)).toEqual([a, b, c]);
  });

  it("breaks order ties by id so concurrent inserts converge", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    sync(a, b);
    insertRow(a, null, null);
    insertRow(b, null, null);
    sync(a, b);
    const ra = listRows(a).map((r) => r.id);
    expect(ra).toHaveLength(2);
    expect(listRows(b).map((r) => r.id)).toEqual(ra);
  });
});

describe("cells", () => {
  it("sets primitive values and ignores missing rows", () => {
    const d = new Y.Doc();
    const c = addColumn(d, "N", "number");
    const r = appendRow(d);
    setCell(d, r, c, 42);
    expect(getCellValue(d, r, c)).toBe(42);
    setCell(d, "nope", c, 1);
    expect(getCellValue(d, "nope", c)).toBeNull();
  });

  it("same-cell concurrent writes resolve identically on both sides (LWW)", () => {
    const a = new Y.Doc();
    const c = addColumn(a, "T");
    const r = appendRow(a);
    const b = new Y.Doc();
    sync(a, b);
    setCell(a, r, c, "from A");
    setCell(b, r, c, "from B");
    sync(a, b);
    expect(getCellValue(a, r, c)).toBe(getCellValue(b, r, c));
  });

  it("longtext merges concurrent typing at the character level", () => {
    const a = new Y.Doc();
    const c = addColumn(a, "Notes", "longtext");
    const r = appendRow(a);
    setLongText(a, r, c, "hello world");
    const b = new Y.Doc();
    sync(a, b);
    setLongText(a, r, c, "hello brave world");
    setLongText(b, r, c, "hello world!");
    sync(a, b);
    expect(getCellValue(a, r, c)).toBe("hello brave world!");
    expect(getCellValue(b, r, c)).toBe("hello brave world!");
  });

  it("setLongText applies a minimal diff and is a no-op when unchanged", () => {
    const d = new Y.Doc();
    const c = addColumn(d, "N", "longtext");
    const r = appendRow(d);
    setLongText(d, r, c, "abc");
    let events = 0;
    d.on("update", () => events++);
    setLongText(d, r, c, "abc");
    expect(events).toBe(0);
    setLongText(d, r, c, "aXc");
    expect(getCellValue(d, r, c)).toBe("aXc");
  });
});

describe("sync properties", () => {
  it("applying the same update twice is idempotent", () => {
    const a = new Y.Doc();
    seedIfEmpty(a);
    const u = Y.encodeStateAsUpdate(a);
    const b = new Y.Doc();
    Y.applyUpdate(b, u);
    Y.applyUpdate(b, u);
    expect(listRows(b)).toEqual(listRows(a));
  });

  it("seedIfEmpty only seeds an empty doc", () => {
    const d = new Y.Doc();
    seedIfEmpty(d);
    const n = listRows(d).length;
    seedIfEmpty(d);
    expect(listRows(d)).toHaveLength(n);
    expect(listColumns(d).length).toBe(5);
  });
});
