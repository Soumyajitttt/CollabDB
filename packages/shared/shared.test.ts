import { describe, expect, it } from "vitest";
import { JoinDoc, MAX_UPDATE_BYTES, RegisterBody, SyncUpdate, signAccessToken, verifyAccessToken } from "./src";

const secret = "x".repeat(32);
const id = "7d5f1a0e-3c1b-4d6e-8a52-2f2b9a1c4e10";

describe("event schemas", () => {
  it("accepts a valid join and rejects a non-uuid", () => {
    expect(JoinDoc.safeParse({ docId: id }).success).toBe(true);
    expect(JoinDoc.safeParse({ docId: "nope" }).success).toBe(false);
  });
  it("rejects oversized or non-binary updates and negative seq", () => {
    expect(SyncUpdate.safeParse({ docId: id, update: new Uint8Array(4), clientSeq: 1 }).success).toBe(true);
    expect(SyncUpdate.safeParse({ docId: id, update: new Uint8Array(MAX_UPDATE_BYTES + 1), clientSeq: 1 }).success).toBe(false);
    expect(SyncUpdate.safeParse({ docId: id, update: "abc", clientSeq: 1 }).success).toBe(false);
    expect(SyncUpdate.safeParse({ docId: id, update: new Uint8Array(1), clientSeq: -1 }).success).toBe(false);
  });
  it("normalizes emails and enforces password length", () => {
    const ok = RegisterBody.parse({ email: "  A@B.com ", password: "12345678", name: "A" });
    expect(ok.email).toBe("a@b.com");
    expect(RegisterBody.safeParse({ email: "a@b.com", password: "short", name: "A" }).success).toBe(false);
  });
});

describe("access tokens", () => {
  it("round-trips claims", async () => {
    const t = await signAccessToken(secret, { sub: id, email: "a@b.com" });
    expect((await verifyAccessToken(secret, t)).sub).toBe(id);
  });
  it("rejects wrong secret, tampering and expiry", async () => {
    const t = await signAccessToken(secret, { sub: id });
    await expect(verifyAccessToken("y".repeat(32), t)).rejects.toThrow();
    await expect(verifyAccessToken(secret, t.slice(0, -2) + "xx")).rejects.toThrow();
    const old = await signAccessToken(secret, { sub: id }, -10);
    await expect(verifyAccessToken(secret, old)).rejects.toThrow();
  });
  it("rejects a token whose sub is not a uuid", async () => {
    const t = await signAccessToken(secret, { sub: "not-a-uuid" } as never);
    await expect(verifyAccessToken(secret, t)).rejects.toThrow();
  });
});
