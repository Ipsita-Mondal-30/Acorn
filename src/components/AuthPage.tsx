import Link from "next/link";
import { connection } from "next/server";
import { storageMode } from "@/lib/env";
import { PageIntro } from "./ui";
import { AuthForm } from "./AuthForm";

const COPY = {
  login: { h1: "Sign in", lead: "Your memories are private to your account." },
  signup: { h1: "Create your account", lead: "Email and password. Your memories stay private to you." },
};

export async function AuthPage({ mode, searchParams }: { mode: "login" | "signup"; searchParams: Promise<{ [k: string]: string | string[] | undefined }> }) {
  await connection();
  const sp = await searchParams;
  const pick = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);
  const { h1, lead } = COPY[mode];

  if (storageMode() === "local") {
    return (
      <div>
        <PageIntro mood="happy" title={h1}>
          Acorn is running in <strong>local demo mode</strong>: everything stays on this machine and there are no accounts. To use
          cloud accounts, add your Supabase keys (see the README) and restart.
        </PageIntro>
        <Link href="/" className="mt-6 inline-block font-bold text-moss-ink underline underline-offset-4">Back to the demo</Link>
      </div>
    );
  }
  return (
    <div>
      <PageIntro mood="happy" title={h1}>{lead}</PageIntro>
      {pick("error") === "link" && (
        <p role="alert" className="mt-4 max-w-sm rounded-xl bg-danger-soft px-3.5 py-2.5 text-sm text-danger">
          We couldn&apos;t finish signing you in from that link. If you opened it in a different browser than the one you signed up in, or it has expired, your email may already be confirmed: try signing in below.
        </p>
      )}
      <AuthForm mode={mode} next={pick("next") ?? "/"} />
    </div>
  );
}
