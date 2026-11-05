import Link from "next/link";
import { buttonClass } from "@/components/ui";

export default function NotFound() {
  return (
    <div className="max-w-xl py-10">
      <h1 className="font-display text-3xl font-medium tracking-tight">Nothing buried here.</h1>
      <p className="mt-3 text-ink-soft">That page or memory doesn&apos;t exist — it may have been removed, or the link is off.</p>
      <div className="mt-6 flex gap-3">
        <Link href="/memories" className={buttonClass.primary}>
          Browse memories
        </Link>
        <Link href="/search" className={buttonClass.secondary}>
          Search
        </Link>
      </div>
    </div>
  );
}
