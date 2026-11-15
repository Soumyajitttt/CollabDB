import type { DocSummary } from "@collab/shared";

export const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL ?? "http://localhost:4000";

/** Fresh short-lived token from our own /api/token route (needs a NextAuth session). */
export async function getToken(): Promise<string> {
  const res = await fetch("/api/token", { cache: "no-store" });
  if (!res.ok) throw new Error("not signed in");
  return ((await res.json()) as { token: string }).token;
}

async function serverFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(SERVER_URL + path, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${await getToken()}`, ...init.headers },
  });
  if (!res.ok) throw new Error(`request failed (${res.status})`);
  return (await res.json()) as T;
}

export const listDocs = () => serverFetch<{ docs: DocSummary[] }>("/docs").then((r) => r.docs);
export const createDocument = (name: string) =>
  serverFetch<{ doc: DocSummary }>("/docs", { method: "POST", body: JSON.stringify({ name }) }).then((r) => r.doc);

export async function registerUser(input: { email: string; password: string; name: string }): Promise<string | null> {
  try {
    const res = await fetch(SERVER_URL + "/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    if (res.ok) return null;
    if (res.status === 409) return "That email is already registered.";
    if (res.status === 429) return "Too many attempts. Wait a bit and try again.";
    if (res.status === 400) return "Check your details: valid email, password of at least 8 characters.";
    return "Could not create the account.";
  } catch {
    return "Cannot reach the server. Is it running?";
  }
}
