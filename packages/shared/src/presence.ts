/** Colours dark enough for white text (WCAG AA on #fff) and distinguishable from each other. */
export const PRESENCE_COLORS = [
  "#0b7a75", "#b3321f", "#6b4bd6", "#a15c00", "#1f6fb2", "#a02f7a", "#4d7c0f", "#c2410c",
] as const;

/** Same user -> same colour on every device, chosen by the server, never by the client. */
export function colorForUser(userId: string): string {
  let h = 0;
  for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) >>> 0;
  return PRESENCE_COLORS[h % PRESENCE_COLORS.length]!;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0]![0]! + (parts.length > 1 ? parts[parts.length - 1]![0]! : "")).toUpperCase();
}
