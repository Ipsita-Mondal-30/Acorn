"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { createBrowserSupabase } from "@/lib/supabase/browser";
import { safeNext } from "@/lib/supabase/redirect";
import { buttonClass, fieldClass } from "./ui";

type Mode = "login" | "signup";
const MIN_PASSWORD = 8;

/** Email + password. Talks to Supabase Auth directly; the session lands in a cookie the server reads. */
export function AuthForm({ mode, next }: { mode: Mode; next: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const target = safeNext(next);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    setError(null);
    setNotice(null);
    if (!email) return setError("Enter your email address.");
    if (mode === "signup" && password.length < MIN_PASSWORD) return setError(`Use at least ${MIN_PASSWORD} characters for your password.`);
    if (!password) return setError("Enter your password.");

    setBusy(true);
    try {
      const supabase = createBrowserSupabase();
      if (mode === "login") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      } else {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: `${location.origin}/auth/callback?next=${encodeURIComponent(target)}` },
        });
        if (error) throw error;
        if (!data.session) {
          // the project requires email confirmation: no session until the link is opened
          setNotice("Check your email — we sent a link to confirm your account. Then sign in.");
          return;
        }
      }
      router.replace(target);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "Couldn't reach the sign-in service. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const other = mode === "login" ? { href: "/signup", text: "New to Acorn? Create an account" } : { href: "/login", text: "Already have an account? Sign in" };
  return (
    <form onSubmit={submit} className="mt-8 max-w-sm space-y-4" noValidate>
      <div>
        <label htmlFor="email" className="mb-1.5 block text-sm font-medium">Email</label>
        <input id="email" name="email" type="email" autoComplete="email" required className={fieldClass} />
      </div>
      <div>
        <label htmlFor="password" className="mb-1.5 block text-sm font-medium">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          required
          minLength={mode === "signup" ? MIN_PASSWORD : undefined}
          className={fieldClass}
        />
        {mode === "signup" && <p className="mt-1.5 text-sm text-ink-faint">At least {MIN_PASSWORD} characters.</p>}
      </div>
      <div aria-live="polite">
        {error && <p role="alert" className="rounded-xl bg-danger-soft px-3.5 py-2.5 text-sm text-danger">{error}</p>}
        {notice && <p className="rounded-xl bg-moss-soft px-3.5 py-2.5 text-sm text-moss-ink">{notice}</p>}
      </div>
      <button type="submit" disabled={busy} className={buttonClass.primary}>
        {busy ? (mode === "login" ? "Signing in…" : "Creating account…") : mode === "login" ? "Sign in" : "Create account"}
      </button>
      <p className="text-sm">
        <Link href={other.href} className="text-ink-soft underline underline-offset-2 hover:text-ink">{other.text}</Link>
      </p>
    </form>
  );
}
