import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signAccessToken } from "@collab/shared";
import type { RunningServer } from "../src/server";
import { SECRET, dbAvailable, start, uniqueEmail } from "./helpers";

const available = await dbAvailable();

describe.skipIf(!available)("auth and docs REST", () => {
  let server: RunningServer;
  const post = (path: string, body: unknown, token?: string) =>
    fetch(server.url + path, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });

  beforeAll(async () => { server = await start(); });
  afterAll(async () => { await server.close(); });

  it("registers, rejects duplicates, validates input", async () => {
    const email = uniqueEmail();
    const a = await post("/auth/register", { email, password: "password123", name: "Ann" });
    expect(a.status).toBe(201);
    const body = await a.json();
    expect(body.user.email).toBe(email);
    expect(JSON.stringify(body)).not.toContain("password");
    expect((await post("/auth/register", { email, password: "password123", name: "Ann" })).status).toBe(409);
    expect((await post("/auth/register", { email: "nope", password: "short", name: "" })).status).toBe(400);
  });

  it("logs in with the right password only (same error for unknown email)", async () => {
    const email = uniqueEmail();
    await post("/auth/register", { email, password: "password123", name: "Bob" });
    const ok = await post("/auth/login", { email: email.toUpperCase(), password: "password123" });
    expect(ok.status).toBe(200);
    expect((await ok.json()).user.name).toBe("Bob");
    const bad = await post("/auth/login", { email, password: "wrong-password" });
    const ghost = await post("/auth/login", { email: uniqueEmail(), password: "password123" });
    expect(bad.status).toBe(401);
    expect(ghost.status).toBe(401);
    expect(await bad.json()).toEqual(await ghost.json());
  });

  it("stores passwords hashed", async () => {
    const email = uniqueEmail();
    await post("/auth/register", { email, password: "password123", name: "C" });
    const { rows } = await server.pool.query("SELECT password_hash FROM users WHERE email = $1", [email]);
    expect(rows[0].password_hash).toMatch(/^\$2[aby]\$/);
    expect(rows[0].password_hash).not.toContain("password123");
  });

  it("protects /docs and scopes it to the caller", async () => {
    const reg = async (n: string) => (await (await post("/auth/register", { email: uniqueEmail(), password: "password123", name: n })).json()).user.id as string;
    const [u1, u2] = [await reg("U1"), await reg("U2")];
    const [t1, t2] = [await signAccessToken(SECRET, { sub: u1 }), await signAccessToken(SECRET, { sub: u2 })];

    expect((await fetch(server.url + "/docs")).status).toBe(401);
    expect((await fetch(server.url + "/docs", { headers: { authorization: "Bearer garbage" } })).status).toBe(401);
    expect((await post("/docs", { name: "" }, t1)).status).toBe(400);

    const created = await post("/docs", { name: "Plan" }, t1);
    expect(created.status).toBe(201);
    const list1 = await (await fetch(server.url + "/docs", { headers: { authorization: `Bearer ${t1}` } })).json();
    const list2 = await (await fetch(server.url + "/docs", { headers: { authorization: `Bearer ${t2}` } })).json();
    expect(list1.docs.map((d: { name: string; role: string }) => [d.name, d.role])).toEqual([["Plan", "owner"]]);
    expect(list2.docs).toEqual([]);
  });

  it("rejects an expired or wrongly signed token", async () => {
    const old = await signAccessToken(SECRET, { sub: "7d5f1a0e-3c1b-4d6e-8a52-2f2b9a1c4e10" }, -5);
    const forged = await signAccessToken("z".repeat(40), { sub: "7d5f1a0e-3c1b-4d6e-8a52-2f2b9a1c4e10" });
    for (const t of [old, forged]) expect((await fetch(server.url + "/docs", { headers: { authorization: `Bearer ${t}` } })).status).toBe(401);
  });
});
