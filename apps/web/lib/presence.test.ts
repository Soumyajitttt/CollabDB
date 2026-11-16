import { describe, expect, it } from "vitest";
import type { PresenceEntry } from "@collab/sync";
import { byCell, cellKey, uniqueUsers } from "./presence";

const entry = (clientId: number, userId: string, cell: { rowId: string; colId: string } | null): PresenceEntry => ({
  clientId, cell, editing: false, user: { id: userId, name: `User ${userId}`, color: "#0b7a75" },
});

describe("presence helpers", () => {
  it("maps cells to people, ignoring people with no cell", () => {
    const m = byCell([entry(1, "a", { rowId: "r1", colId: "c1" }), entry(2, "b", null)]);
    expect([...m.keys()]).toEqual([cellKey("r1", "c1")]);
  });
  it("picks the lowest client id when two people share a cell", () => {
    const m = byCell([entry(9, "late", { rowId: "r", colId: "c" }), entry(3, "early", { rowId: "r", colId: "c" })]);
    expect(m.get(cellKey("r", "c"))!.user.id).toBe("early");
  });
  it("counts one person once even with two tabs open", () => {
    const users = uniqueUsers([entry(1, "a", null), entry(2, "a", null), entry(3, "b", null)]);
    expect(users.map((u) => u.id)).toEqual(["a", "b"]);
  });
});
