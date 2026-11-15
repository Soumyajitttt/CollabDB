"use client";

import { Suspense, useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import { registerUser } from "@/lib/api";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [mode, setMode] = useState<"signin" | "register">("signin");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const email = String(f.get("email") ?? "");
    const password = String(f.get("password") ?? "");
    setBusy(true);
    setError(null);
    if (mode === "register") {
      const problem = await registerUser({ email, password, name: String(f.get("name") ?? "") });
      if (problem) {
        setBusy(false);
        return setError(problem);
      }
    }
    const res = await signIn("credentials", { email, password, redirect: false });
    setBusy(false);
    if (!res || res.error) return setError("Wrong email or password.");
    const next = params.get("callbackUrl");
    router.push(next && next.startsWith("/") ? next : "/");
    router.refresh();
  }

  return (
    <main className="auth">
      <form className="auth-card" onSubmit={submit}>
        <h1>CollabDB</h1>
        <p className="muted">{mode === "signin" ? "Sign in to your tables." : "Create an account."}</p>
        {mode === "register" && (
          <label>Name<input name="name" required maxLength={100} autoComplete="name" /></label>
        )}
        <label>Email<input name="email" type="email" required autoComplete="email" /></label>
        <label>
          Password
          <input name="password" type="password" required minLength={mode === "register" ? 8 : 1} maxLength={72}
            autoComplete={mode === "register" ? "new-password" : "current-password"} />
        </label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="btn primary" disabled={busy}>{busy ? "Please wait…" : mode === "signin" ? "Sign in" : "Create account"}</button>
        <button type="button" className="btn ghost" onClick={() => { setMode(mode === "signin" ? "register" : "signin"); setError(null); }}>
          {mode === "signin" ? "New here? Create an account" : "Have an account? Sign in"}
        </button>
        <a className="muted small" href="/local">Or try the local-only table (no account)</a>
      </form>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
