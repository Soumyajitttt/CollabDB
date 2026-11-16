"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MemberInfo } from "@collab/shared";
import { addMember, ApiError, listMembers, removeMember, updateMemberRole } from "@/lib/api";

type Role = "editor" | "viewer";

export function ShareDialog({ docId, onClose }: { docId: string; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [members, setMembers] = useState<MemberInfo[] | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("editor");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    listMembers(docId).then(setMembers).catch(() => setError("Could not load the member list."));
  }, [docId]);

  useEffect(() => {
    ref.current?.showModal();
    refresh();
  }, [refresh]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      refresh();
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "";
      setError(
        code === "USER_NOT_FOUND" ? "No account with that email. They need to register first."
        : code === "ALREADY_OWNER" ? "That person already owns this table."
        : code === "BAD_REQUEST" ? "Enter a valid email address."
        : "That did not work. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog ref={ref} className="dialog" onClose={onClose} aria-labelledby="share-title">
      <h2 id="share-title">Share this table</h2>
      <form
        className="share-add"
        onSubmit={(e) => {
          e.preventDefault();
          if (!email.trim()) return;
          void run(async () => { await addMember(docId, email.trim(), role); setEmail(""); });
        }}
      >
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email of an existing account" aria-label="Email" required />
        <select value={role} onChange={(e) => setRole(e.target.value as Role)} aria-label="Role">
          <option value="editor">Can edit</option>
          <option value="viewer">Can view</option>
        </select>
        <button className="btn primary" disabled={busy}>Add</button>
      </form>
      {error && <p className="form-error" role="alert">{error}</p>}

      <ul className="members">
        {members === null && <li className="muted">Loading…</li>}
        {members?.map((m) => (
          <li key={m.userId}>
            <span className="member-name">{m.name}<span className="muted small"> {m.email}</span></span>
            {m.role === "owner" ? (
              <span className="pill">owner</span>
            ) : (
              <>
                <select value={m.role} disabled={busy} aria-label={`Role for ${m.name}`}
                  onChange={(e) => void run(() => updateMemberRole(docId, m.userId, e.target.value as Role))}>
                  <option value="editor">Can edit</option>
                  <option value="viewer">Can view</option>
                </select>
                <button className="btn ghost" disabled={busy} onClick={() => void run(() => removeMember(docId, m.userId))}>Remove</button>
              </>
            )}
          </li>
        ))}
      </ul>
      <div className="dialog-foot">
        <button className="btn" onClick={() => ref.current?.close()}>Done</button>
      </div>
    </dialog>
  );
}
