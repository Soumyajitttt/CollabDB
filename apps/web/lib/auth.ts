import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { LoginBody } from "@collab/shared";

/**
 * NextAuth owns the browser session (a signed + encrypted JWT in an httpOnly cookie).
 * Passwords are checked by the sync server (bcrypt + Postgres), never in the web app.
 */
export const authOptions: NextAuthOptions = {
  session: { strategy: "jwt", maxAge: 7 * 24 * 60 * 60 },
  pages: { signIn: "/login" },
  providers: [
    CredentialsProvider({
      name: "Email and password",
      credentials: { email: { label: "Email", type: "email" }, password: { label: "Password", type: "password" } },
      async authorize(credentials) {
        const parsed = LoginBody.safeParse(credentials);
        if (!parsed.success) return null;
        try {
          const res = await fetch(`${process.env.AUTH_SERVER_URL}/auth/login`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(parsed.data),
            cache: "no-store",
          });
          if (!res.ok) return null;
          const { user } = (await res.json()) as { user: { id: string; email: string; name: string } };
          return { id: user.id, email: user.email, name: user.name };
        } catch {
          return null; // server unreachable: treated as a failed sign-in
        }
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user) token.uid = user.id;
      return token;
    },
    session({ session, token }) {
      if (session.user && token.uid) session.user.id = token.uid;
      return session;
    },
  },
};
