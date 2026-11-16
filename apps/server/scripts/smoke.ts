/**
 * Full-stack check: server (4000) + web (3000) must both be running.
 *   register -> NextAuth sign-in -> /api/token -> create doc -> sync -> share -> presence
 */
import * as Y from "yjs";
import { SyncProvider } from "@collab/sync";

const SERVER = process.env.SERVER_URL ?? "http://localhost:4000";
const WEB = process.env.WEB_URL ?? "http://localhost:3000";
const ok = (m: string) => console.log(`  ok  ${m}`);
const must = (c: unknown, m: string) => { if (!c) { console.error(`FAIL ${m}`); process.exit(1); } ok(m); };
const until = async (f: () => boolean, what: string) => { const t = Date.now(); while (!f()) { if (Date.now() - t > 8000) { console.error(`FAIL timed out: ${what}`); process.exit(1); } await new Promise((r) => setTimeout(r, 20)); } };

class Jar {
  private c = new Map<string, string>();
  add(res: Response) {
    for (const line of res.headers.getSetCookie()) { const [kv] = line.split(";"); const i = kv!.indexOf("="); this.c.set(kv!.slice(0, i), kv!.slice(i + 1)); }
  }
  get header() { return [...this.c].map(([k, v]) => `${k}=${v}`).join("; "); }
}

async function register(email: string, password: string, name: string) {
  const res = await fetch(`${SERVER}/auth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password, name }) });
  return res.status;
}

/** Signs in through NextAuth exactly like the browser does and returns a token getter. */
async function signIn(email: string, password: string) {
  const jar = new Jar();
  const csrfRes = await fetch(`${WEB}/api/auth/csrf`);
  jar.add(csrfRes);
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
  const login = await fetch(`${WEB}/api/auth/callback/credentials`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header },
    body: new URLSearchParams({ csrfToken, email, password, json: "true" }),
  });
  jar.add(login);
  const getToken = async () => ((await (await fetch(`${WEB}/api/token`, { headers: { cookie: jar.header } })).json()) as { token: string }).token;
  return { jar, getToken };
}

(async () => {
  const stamp = Date.now();
  const emailA = `smoke-a-${stamp}@test.dev`;
  const emailB = `smoke-b-${stamp}@test.dev`;
  const password = "smoke-password-1";

  must((await register(emailA, password, "Smoke Anna")) === 201, "register user A on the server");
  must((await register(emailB, password, "Smoke Ben")) === 201, "register user B on the server");

  must((await fetch(`${WEB}/api/token`)).status === 401, "/api/token refuses a request without a session");
  const gated = await fetch(`${WEB}/`, { redirect: "manual" });
  must(gated.status >= 300 && gated.status < 400 && (gated.headers.get("location") ?? "").includes("/login"), "middleware redirects / to /login when signed out");

  // wrong password is refused by NextAuth
  const jar0 = new Jar();
  const csrf0 = await fetch(`${WEB}/api/auth/csrf`); jar0.add(csrf0);
  const bad = await fetch(`${WEB}/api/auth/callback/credentials`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar0.header }, body: new URLSearchParams({ csrfToken: ((await csrf0.json()) as { csrfToken: string }).csrfToken, email: emailA, password: "wrong-password", json: "true" }) });
  must((((await bad.json()) as { url?: string }).url ?? "").includes("error="), "NextAuth rejects a wrong password");

  const A = await signIn(emailA, password);
  const B = await signIn(emailB, password);
  const tokenA = await A.getToken();
  must(!!tokenA && !!(await B.getToken()), "/api/token mints tokens for signed-in users");

  const created = await fetch(`${SERVER}/docs`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tokenA}` }, body: JSON.stringify({ name: "Smoke table" }) });
  must(created.status === 201, "server accepts the NextAuth-minted JWT on REST");
  const docId = ((await created.json()) as { doc: { id: string } }).doc.id;

  const docA = new Y.Doc();
  const pA = new SyncProvider(docA, { url: SERVER, docId, getToken: A.getToken });
  await until(() => pA.getState().status === "synced", "A joins");
  ok(`A joined as ${pA.getState().role}`);
  docA.getMap("m").set("hello", "world");
  await pA.whenFlushed();
  ok("A's edit acknowledged by the server (persisted in Postgres)");

  // Week 3: B cannot get in until A shares the table.
  const docB = new Y.Doc();
  const pB = new SyncProvider(docB, { url: SERVER, docId, getToken: B.getToken });
  await until(() => pB.getState().lastError?.code === "FORBIDDEN", "B is refused before being shared");
  ok("B is refused before the table is shared");
  pB.destroy();

  const share = await fetch(`${SERVER}/docs/${docId}/members`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tokenA}` }, body: JSON.stringify({ email: emailB, role: "viewer" }) });
  must(share.status === 201, "A shares the table with B as a viewer");

  const docB2 = new Y.Doc();
  const pB2 = new SyncProvider(docB2, { url: SERVER, docId, getToken: B.getToken });
  await until(() => pB2.getState().status === "synced", "B joins after being shared");
  must(pB2.getState().role === "viewer", "B joined as a viewer");
  await until(() => docB2.getMap("m").get("hello") === "world", "B receives A's data");
  ok("B received A's data");

  pA.setPresence({ rowId: "r1", colId: "c1" }, true);
  await until(() => pB2.getPresence().some((p) => p.user.name === "Smoke Anna" && p.cell?.rowId === "r1"), "B sees A's cursor");
  ok("B sees A's cursor, with the name the server knows");

  const patch = await fetch(`${SERVER}/docs/${docId}/members/${pB2.getState().me!.id}`, { method: "PATCH", headers: { "content-type": "application/json", authorization: `Bearer ${tokenA}` }, body: JSON.stringify({ role: "editor" }) });
  must(patch.status === 200, "A promotes B to editor");
  await until(() => pB2.getState().role === "editor", "B's role updates live");
  ok("B's role changed to editor without reconnecting");

  pA.destroy(); pB2.destroy();
  console.log("\nAll good.");
  process.exit(0);
})();
