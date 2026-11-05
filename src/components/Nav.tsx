"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type Item = { href: string; label: string; icon: React.ReactNode };

const ico = (d: React.ReactNode) => (
  <svg viewBox="0 0 24 24" className="size-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {d}
  </svg>
);

export const LINKS: Item[] = [
  { href: "/", label: "Home", icon: ico(<path d="M4 11.5 12 5l8 6.5V19a1 1 0 0 1-1 1h-4v-5.5H9V20H5a1 1 0 0 1-1-1v-7.5Z" />) },
  { href: "/memories", label: "Memories", icon: ico(<><rect x="4" y="4.5" width="16" height="15" rx="3" /><path d="M8 9.5h8M8 13.5h5" /></>) },
  { href: "/learn", label: "Learn", icon: ico(<path d="M4 6.5c3-1.3 5.5-1.1 8 .8 2.5-1.9 5-2.1 8-.8V18c-3-1.3-5.500-1.100-8 .8-2.500-1.900-5-2.100-8-.8V6.500ZM12 7.300V18.800" />) },
  { href: "/reminders", label: "Reminders", icon: ico(<path d="M6 16.5V11a6 6 0 0 1 12 0v5.500l1.500 1.500h-15L6 16.500ZM10 20.500h4" />) },
];

const isActive = (href: string, path: string | null) => (href === "/" ? path === "/" : !!path?.startsWith(href));

export function Nav() {
  return <NavLinks path={usePathname()} />;
}

/** Desktop: pills in the header. Also the Suspense fallback (no active state) while the pathname is unknown. */
export function NavLinks({ path }: { path: string | null }) {
  return (
    <nav aria-label="Main" className="hidden sm:block">
      <ul className="flex gap-1">
        {LINKS.map(({ href, label }) => (
          <li key={href}>
            <Link
              href={href}
              aria-current={isActive(href, path) ? "page" : undefined}
              className={`block rounded-full px-4 py-2 text-[15px] font-semibold transition-colors ${
                isActive(href, path) ? "bg-moss-soft text-moss-ink" : "text-ink-soft hover:bg-paper-deep hover:text-ink"
              }`}
            >
              {label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** Phones: compact bottom bar with a raised capture button in the middle. */
export function BottomNav() {
  const path = usePathname();
  const [a, b, c, d] = LINKS;
  const tab = (i: Item) => (
    <li key={i.href} className="flex-1">
      <Link
        href={i.href}
        aria-current={isActive(i.href, path) ? "page" : undefined}
        className={`flex flex-col items-center gap-0.5 rounded-2xl py-1.5 text-[11px] font-bold ${isActive(i.href, path) ? "text-moss-ink" : "text-ink-faint"}`}
      >
        <span className={`grid h-7 w-12 place-items-center rounded-full transition-colors ${isActive(i.href, path) ? "bg-moss-soft" : ""}`}>{i.icon}</span>
        {i.label}
      </Link>
    </li>
  );
  return (
    <nav aria-label="Main" className="safe-bottom fixed inset-x-0 bottom-0 z-30 border-t border-line bg-card/95 px-2 pt-1.5 backdrop-blur sm:hidden">
      <ul className="mx-auto flex max-w-md items-end">
        {tab(a)}
        {tab(b)}
        <li className="flex-1">
          <Link
            href="/capture"
            aria-label="Save something"
            className="btn-tactile -mt-6 mx-auto grid size-14 place-items-center rounded-full bg-moss text-white"
          >
            <svg viewBox="0 0 24 24" className="size-7" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </Link>
        </li>
        {tab(c)}
        {tab(d)}
      </ul>
    </nav>
  );
}
