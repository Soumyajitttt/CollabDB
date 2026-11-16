"use client";

import { initials, type PresenceUser } from "@collab/shared";

const MAX_SHOWN = 5;

/** You first, then everyone else who has the table open. */
export function PresenceBar({ me, others }: { me: PresenceUser | null; others: PresenceUser[] }) {
  if (!me && others.length === 0) return null;
  const shown = others.slice(0, MAX_SHOWN);
  const extra = others.length - shown.length;
  return (
    <div className="avatars" aria-label={`${others.length + (me ? 1 : 0)} people here`}>
      {me && (
        <span className="avatar me" style={{ background: me.color }} title={`${me.name} (you)`}>
          {initials(me.name)}
        </span>
      )}
      {shown.map((u) => (
        <span key={u.id} className="avatar" style={{ background: u.color }} title={u.name}>
          {initials(u.name)}
        </span>
      ))}
      {extra > 0 && <span className="avatar more" title={others.slice(MAX_SHOWN).map((u) => u.name).join(", ")}>+{extra}</span>}
    </div>
  );
}
