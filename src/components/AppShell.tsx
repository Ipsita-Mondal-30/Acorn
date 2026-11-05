import Link from "next/link";
import { Suspense } from "react";
import { Aiko } from "./Aiko";
import { AccountBar } from "./AccountBar";
import { ModeBadge } from "./ModeBadge";
import { BottomNav, Nav, NavLinks } from "./Nav";

export function AcornMark({ className = "size-9" }: { className?: string }) {
  return <Aiko mood="happy" motion="none" size={36} className={className} />;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-card focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-20 border-b border-line/70 bg-paper/90 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center gap-x-4 px-4 py-2.5 sm:px-6">
          <Link href="/" className="flex items-center gap-1.5 rounded-xl" aria-label="Acorn home">
            <AcornMark />
            <span className="font-display text-2xl text-moss-ink">Acorn</span>
          </Link>
          <Suspense fallback={<NavLinks path={null} />}>
            <Nav />
          </Suspense>
          <div className="ml-auto flex items-center gap-1.5">
            <Link href="/search" aria-label="Search" className="grid size-10 place-items-center rounded-full text-ink-soft hover:bg-paper-deep hover:text-ink">
              <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></svg>
            </Link>
            <Link href="/notifications" aria-label="Inbox" className="grid size-10 place-items-center rounded-full text-ink-soft hover:bg-paper-deep hover:text-ink">
              <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 13.5 6.5 5h11L20 13.5V18a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-4.500ZM4 13.500h4.500l1 2h5l1-2H20" /></svg>
            </Link>
            <Link href="/capture" className="btn-tactile hidden items-center gap-1.5 rounded-full bg-moss px-4 py-2 text-[15px] font-bold text-white sm:inline-flex">
              <span aria-hidden="true" className="text-lg leading-none">+</span> Save something
            </Link>
          </div>
        </div>
      </header>
      <main id="main" className="mx-auto w-full max-w-5xl flex-1 px-4 pb-32 pt-6 sm:px-6 sm:pb-24 sm:pt-10">
        {children}
      </main>
      <footer className="border-t border-line/70">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-4 gap-y-2 px-4 pt-5 pb-28 text-sm text-ink-faint sm:px-6 sm:pb-6">
          <Suspense fallback={null}>
            <ModeBadge />
          </Suspense>
          <Suspense fallback={null}>
            <AccountBar />
          </Suspense>
          <Link href="/today" className="font-bold text-moss-ink underline underline-offset-4">Today with Acorn</Link>
          <Link href="/usage" className="font-bold text-moss-ink underline underline-offset-4">Meta model usage</Link>
          <p className="basis-full">Aiko remembers what you discover and helps you do something with it. Nothing happens in the outside world unless you say so.</p>
        </div>
      </footer>
      <Suspense fallback={null}>
        <BottomNav />
      </Suspense>
    </div>
  );
}
