"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { signOut, useSession } from "next-auth/react";
import type { DocSummary } from "@collab/shared";
import { createDocument, listDocs } from "@/lib/api";

export function DocList() {
  const { data: session } = useSession();
  const [docs, setDocs] = useState<DocSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");

  useEffect(() => {
    listDocs().then(setDocs).catch(() => setError("Could not load your documents. Is the server running?"));
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      const doc = await createDocument(name.trim());
      setDocs((d) => [doc, ...(d ?? [])]);
      setName("");
    } catch {
      setError("Could not create the document.");
    }
  }

  return (
    <main className="shell narrow">
      <header className="top">
        <h1>CollabDB</h1>
        <span className="status">{session?.user?.name ?? ""}</span>
        <button className="btn ghost" onClick={() => signOut({ callbackUrl: "/login" })}>Sign out</button>
      </header>

      <form className="newdoc" onSubmit={create}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name a new table" maxLength={100} aria-label="New table name" />
        <button className="btn primary" disabled={!name.trim()}>Create table</button>
      </form>

      {error && <p className="form-error" role="alert">{error}</p>}
      {docs === null && !error && <p className="muted">Loading…</p>}
      {docs?.length === 0 && <p className="muted">No tables yet. Create your first one above.</p>}
      <ul className="doclist">
        {docs?.map((d) => (
          <li key={d.id}>
            <Link href={`/doc/${d.id}`}>{d.name}</Link>
            <span className="pill">{d.role}</span>
          </li>
        ))}
      </ul>
      <p className="muted small"><Link href="/local">Local-only table (Week 1, no sync)</Link></p>
    </main>
  );
}
