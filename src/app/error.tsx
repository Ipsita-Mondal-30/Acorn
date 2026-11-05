"use client";

import Link from "next/link";
import { useEffect } from "react";
import { buttonClass } from "@/components/ui";

export default function ErrorPage({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => console.error(error), [error]);
  return (
    <div className="max-w-xl py-10">
      <h1 className="font-display text-3xl font-medium tracking-tight">Something went sideways.</h1>
      <p className="mt-3 text-ink-soft">
        Acorn hit a snag loading this page. Your saved memories are safe — try again in a moment.
      </p>
      <div className="mt-6 flex gap-3">
        <button type="button" onClick={() => retry()} className={buttonClass.primary}>
          Try again
        </button>
        <Link href="/" className={buttonClass.secondary}>
          Go home
        </Link>
      </div>
    </div>
  );
}
