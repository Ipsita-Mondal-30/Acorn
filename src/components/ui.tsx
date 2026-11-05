import Link from "next/link";
import type { ContentType, ProcessingStatus } from "@/lib/schema";
import { Aiko, type Mood } from "./Aiko";
import { daysLeftLabel, formatDate } from "./format";

const GLYPHS: Record<ContentType, React.ReactNode> = {
  job: (
    <>
      <rect x="3.5" y="7.5" width="17" height="12" rx="2" />
      <path d="M9 7.5V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1.5M3.5 13h17" />
    </>
  ),
  recipe: (
    <>
      <path d="M3.5 11h17a8.5 8.5 0 0 1-17 0Z" />
      <path d="M9.5 7.5c0-1.5 1-2 1-3.5M13.5 7.5c0-1.5 1-2 1-3.5" />
    </>
  ),
  technical: <path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 6l-3 12" />,
  article: (
    <>
      <rect x="5" y="3.5" width="14" height="17" rx="2" />
      <path d="M8.5 8h7M8.5 12h7M8.5 16h4" />
    </>
  ),
  person: (
    <>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5" />
    </>
  ),
  idea: <path d="M9.5 17.5h5M10.5 20.5h3M12 3.5a6 6 0 0 0-3.5 10.9c.4.3.5.7.5 1.1v2h6v-2c0-.4.2-.8.5-1.1A6 6 0 0 0 12 3.5Z" />,
  deadline: (
    <>
      <circle cx="12" cy="13" r="7.5" />
      <path d="M12 9.5V13l2.5 2M9.5 3h5" />
    </>
  ),
  event: (
    <>
      <rect x="3.5" y="5" width="17" height="15" rx="2" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </>
  ),
  product: (
    <>
      <path d="M4 7.5 12 4l8 3.5v9L12 20l-8-3.5v-9Z" />
      <path d="m4 7.5 8 3.5 8-3.5M12 11v9" />
    </>
  ),
  note: (
    <>
      <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Z" />
      <path d="m13.5 6.5 4 4" />
    </>
  ),
  other: (
    <>
      <path d="M5 19c0-8 5-14 14-14 0 9-6 14-14 14Z" />
      <path d="m5 19 8-8" />
    </>
  ),
};

export function TypeGlyph({ type, className = "size-10" }: { type: ContentType; className?: string }) {
  return (
    <span
      className={`grid shrink-0 place-items-center rounded-full bg-moss-soft text-moss-ink ${className}`}
      aria-hidden="true"
    >
      <svg
        viewBox="0 0 24 24"
        className="size-[55%]"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {GLYPHS[type]}
      </svg>
    </span>
  );
}

const chip = "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-bold whitespace-nowrap";

export function Tag({ tone = "plain", children }: { tone?: "plain" | "moss" | "amber" | "lav" | "butter" | "danger"; children: React.ReactNode }) {
  const tones = {
    plain: "bg-paper-deep text-ink-soft ring-1 ring-inset ring-line",
    moss: "bg-moss-soft text-moss-ink",
    amber: "bg-amber-soft text-amber-ink",
    lav: "bg-lav-soft text-lav-ink",
    butter: "bg-butter-soft text-butter-ink",
    danger: "bg-danger-soft text-danger",
  };
  return <span className={`${chip} ${tones[tone]}`}>{children}</span>;
}

export function SampleTag() {
  return (
    <span title="Seeded sample data, not something you saved">
      <Tag>Sample</Tag>
    </span>
  );
}

export function EditedTag() {
  return <Tag tone="moss">Edited by you</Tag>;
}

const STATUS: Record<ProcessingStatus, { label: string; tone: "plain" | "amber" | "danger" | "moss" }> = {
  pending: { label: "Waiting to be understood", tone: "plain" },
  processing: { label: "Understanding…", tone: "amber" },
  ready: { label: "Understood", tone: "moss" },
  failed: { label: "Couldn't understand", tone: "danger" },
};

export function StatusPill({ status }: { status: ProcessingStatus }) {
  return <Tag tone={STATUS[status].tone}>{STATUS[status].label}</Tag>;
}

export function DeadlineChip({ date, days }: { date: string; days: number }) {
  const tone = days < 0 ? "plain" : days <= 7 ? "amber" : "moss";
  return (
    <span title={`Deadline ${formatDate(date)}`}>
      <Tag tone={tone}>
        <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
          <circle cx="8" cy="8.5" r="5.5" />
          <path d="M8 5.5v3l2 1.5" strokeLinecap="round" />
        </svg>
        {days < 0 ? `Was due ${formatDate(date)}` : `Due ${daysLeftLabel(days).toLowerCase()}`}
      </Tag>
    </span>
  );
}

export function SectionHeading({ id, children, aside }: { id: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div className="mb-4 flex items-baseline justify-between gap-4">
      <h2 id={id} className="font-display text-2xl text-ink">
        {children}
      </h2>
      {aside}
    </div>
  );
}

export function EmptyState({
  title,
  children,
  action,
  mood = "sleeping",
}: {
  title: string;
  children?: React.ReactNode;
  action?: { href: string; label: string };
  mood?: Mood;
}) {
  return (
    <div className="rounded-3xl border-2 border-dashed border-line bg-card/60 px-6 py-9 text-center">
      <Aiko mood={mood} size={104} className="mx-auto" />
      <p className="mt-2 font-display text-xl">{title}</p>
      {children && <div className="mx-auto mt-2 max-w-md text-[15px] text-ink-soft">{children}</div>}
      {action && (
        <Link href={action.href} className={`${buttonClass.primary} mt-5`}>
          {action.label}
        </Link>
      )}
    </div>
  );
}

/** Aiko is busy reading: shown while a page's data loads. */
export function CardSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div className="space-y-3" role="status" aria-label="Loading">
      <div className="flex items-center gap-3 text-ink-soft">
        <Aiko mood="reading" size={64} />
        <p className="text-[15px] font-semibold">Give me a second, I&apos;m looking…</p>
      </div>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="h-24 animate-pulse rounded-2xl bg-paper-deep" aria-hidden="true" />
      ))}
    </div>
  );
}

export const buttonClass = {
  primary:
    "btn-tactile inline-flex items-center justify-center gap-2 rounded-full bg-moss px-5 py-2.5 text-[15px] font-bold text-white hover:bg-moss-ink disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none",
  secondary:
    "btn-tactile inline-flex items-center justify-center gap-2 rounded-full border-2 border-line bg-card px-4 py-2 text-[15px] font-bold text-ink hover:border-moss/50 disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none",
  quiet:
    "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[15px] font-bold text-ink-soft transition-colors hover:bg-paper-deep hover:text-ink disabled:cursor-not-allowed disabled:opacity-50",
};

export const fieldClass =
  "w-full rounded-2xl border-2 border-line bg-card px-4 py-2.5 text-base text-ink placeholder:text-ink-faint focus:border-moss focus:outline-none focus-visible:outline-2 focus-visible:outline-moss/40";

/** Page title with Aiko beside it: the h1 is the bubble's heading, so each page keeps exactly one h1. */
export function PageIntro({ mood, title, children }: { mood: Mood; title: string; children?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 sm:gap-5">
      <Aiko mood={mood} size={96} className="shrink-0" />
      <div className="bubble bubble-left min-w-0 flex-1 rounded-3xl px-5 py-3.5">
        <h1 className="font-display text-2xl sm:text-3xl">{title}</h1>
        {children && <div className="mt-1 text-[15px] text-ink-soft sm:text-base">{children}</div>}
      </div>
    </div>
  );
}
