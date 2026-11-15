/**
 * Full-stack check: server (4000) + web (3000) must both be running.
 *   register -> NextAuth sign-in -> /api/token -> create doc -> sync over the socket -> read back
 */
import * as Y from "yjs";
import { SyncProvider } from "@collab/sync";

const SERVER = process.env.SERVER_URL ?? "http://localhost:4000";
const WEB = process.env.WEB_URL ?? "http://localhost:3000";
const ok = (m: string) => console.log(`  ok  ${m}`);
const must = (c: unknown, m: string) => { if (!c) { console.error(`FAIL ${m}`); process.exit(1); } ok(m); };

class Jar {
  private c = new Map<string, string>();
  add(res: Response) {
    for (const line of res.headers.getSetCookie()) { const [kv] = line.split(";"); const i = kv!.indexOf("="); this.c.set(kv!.slice(0, i), kv!.slice(i + 1)); }
  }
  get header() { return [...this.c].map(([k, v]) => `${k}=${v}`).join("; "); }
}

(async () => {
  const email = `smoke-${Date.now()}@test.dev`;
  const password = "smoke-password-1";

  const reg = await fetch(`${SERVER}/auth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password, name: "Smoke" }) });
  must(reg.status === 201, "register on the server");

  const noSession = await fetch(`${WEB}/api/token`);
  must(noSession.status === 401, "/api/token refuses a request without a session");
  const gated = await fetch(`${WEB}/`, { redirect: "manual" });
  must(gated.status >= 300 && gated.status < 400 && (gated.headers.get("location") ?? "").includes("/login"), "middleware redirects / to /login when signed out");

  const jar = new Jar();
  const csrfRes = await fetch(`${WEB}/api/auth/csrf`);
  jar.add(csrfRes);
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
  const bad = await fetch(`${WEB}/api/auth/callback/credentials`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header },
    body: new URLSearchParams({ csrfToken, email, password: "wrong-password", json: "true" }),
  });
  const badBody = (await bad.json()) as { url?: string };
  must((badBody.url ?? "").includes("error="), "NextAuth rejects a wrong password");

  const login = await fetch(`${WEB}/api/auth/callback/credentials`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header },
    body: new URLSearchParams({ csrfToken, email, password, json: "true" }),
  });
  jar.add(login);
  const session = (await (await fetch(`${WEB}/api/auth/session`, { headers: { cookie: jar.header } })).json()) as { user?: { id: string; email: string } };
  must(session.user?.email === email && !!session.user.id, "NextAuth session carries the user id");

  const tokRes = await fetch(`${WEB}/api/token`, { headers: { cookie: jar.header } });
  must(tokRes.status === 200, "/api/token mints a token for a signed-in user");
  const { token } = (await tokRes.json()) as { token: string };

  const created = await fetch(`${SERVER}/docs`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ name: "Smoke table" }) });
  must(created.status === 201, "server accepts the NextAuth-minted JWT on REST");
  const docId = ((await created.json()) as { doc: { id: string } }).doc.id;

  const doc = new Y.Doc();
  const p = new SyncProvider(doc, { url: SERVER, docId, getToken: async () => (await (await fetch(`${WEB}/api/token`, { headers: { cookie: jar.header } })).json() as { token: string }).token });
  const until = async (f: () => boolean, what: string) => { const t = Date.now(); while (!f()) { if (Date.now() - t > 8000) { console.error(`FAIL timed out: ${what}`); process.exit(1); } await new Promise((r) => setTimeout(r, 20)); } };
  await until(() => p.getState().status === "synced", "socket handshake with the minted token");
  ok(`socket joined as ${p.getState().role}`);
  doc.getMap("m").set("hello", "world");
  await p.whenFlushed();
  ok("edit acknowledged by the server (persisted in Postgres)");

  const doc2 = new Y.Doc();
  const p2 = new SyncProvider(doc2, { url: SERVER, docId, getToken: async () => token });
  await until(() => doc2.getMap("m").get("hello") === "world", "second client receives the edit");
  ok("second client received the edit");
  p.destroy(); p2.destroy();
  console.log("\nAll good.");
  process.exit(0);
})();
