import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { signAccessToken } from "@collab/shared";
import { authOptions } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * Turns a valid NextAuth session into a short-lived (10 min) JWT that the sync server verifies.
 * The browser asks for a fresh one on every (re)connect, so the long-lived credential never
 * leaves the httpOnly cookie and the server never needs refresh tokens.
 */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) return NextResponse.json({ error: "SERVER_MISCONFIGURED" }, { status: 500 });
  const token = await signAccessToken(secret, {
    sub: session.user.id,
    email: session.user.email ?? undefined,
    name: session.user.name ?? undefined,
  });
  return NextResponse.json({ token }, { headers: { "Cache-Control": "no-store" } });
}
