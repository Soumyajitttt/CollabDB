import { describe, expect, it } from "vitest";
import { colorForUser, initials, PRESENCE_COLORS } from "@collab/shared";
import { decodeAwareness, encodeAwareness, sanitizeEntries } from "../src/socket/awareness";

const user = { id: "u1", name: "Ann Lee", color: "#0b7a75" };

describe("awareness wire format", () => {
  it("round-trips entries", () => {
    const entries = [{ clientId: 123456, clock: 7, state: { cell: null, editing: false } }];
    expect(decodeAwareness(encodeAwareness(entries))).toEqual(entries);
  });
  it("rejects garbage, empty updates and trailing bytes", () => {
    expect(() => decodeAwareness(Uint8Array.from([255, 255, 255]))).toThrow();
    expect(() => decodeAwareness(Uint8Array.from([0]))).toThrow();
    const ok = encodeAwareness([{ clientId: 1, clock: 1, state: null }]);
    expect(() => decodeAwareness(Uint8Array.from([...ok, 9]))).toThrow();
  });
  it("rejects more than the allowed number of entries", () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ clientId: i, clock: 1, state: null }));
    expect(() => decodeAwareness(encodeAwareness(many))).toThrow();
  });
});

describe("sanitizeEntries", () => {
  it("stamps the server's identity onto the state", () => {
    const out = sanitizeEntries([{ clientId: 1, clock: 1, state: { cell: { rowId: "r", colId: "c" }, editing: true } }], user)!;
    expect(out[0]!.state).toEqual({ user, cell: { rowId: "r", colId: "c" }, editing: true });
  });
  it("passes a 'left' (null) state through", () => {
    expect(sanitizeEntries([{ clientId: 1, clock: 2, state: null }], user)![0]!.state).toBeNull();
  });
  it("refuses a client-supplied identity, extra fields, wrong types and over-long ids", () => {
    const bad = (state: unknown) => sanitizeEntries([{ clientId: 1, clock: 1, state }], user);
    expect(bad({ user: { name: "Admin" }, cell: null, editing: false })).toBeNull();
    expect(bad({ cell: null, editing: "yes" })).toBeNull();
    expect(bad({ cell: { rowId: "x".repeat(65), colId: "c" }, editing: false })).toBeNull();
    expect(bad("hello")).toBeNull();
  });
});

describe("presence helpers", () => {
  it("picks a stable colour from the palette", () => {
    expect(colorForUser("abc")).toBe(colorForUser("abc"));
    expect(PRESENCE_COLORS).toContain(colorForUser("another-user"));
  });
  it("builds initials", () => {
    expect(initials("Ann Lee")).toBe("AL");
    expect(initials("  madonna ")).toBe("M");
    expect(initials("")).toBe("?");
  });
});
