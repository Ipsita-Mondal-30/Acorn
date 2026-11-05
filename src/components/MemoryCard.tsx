import Link from "next/link";
import { effective, INTENT_LABEL, type Memory } from "@/lib/schema";
import { daysUntil, sourceLabel, timeAgo, TYPE_LABEL } from "./format";
import { DeadlineChip, EditedTag, SampleTag, StatusPill, Tag, TypeGlyph } from "./ui";

export function MemoryCard({
  memory,
  now,
  reasons,
  note,
  understood = false,
}: {
  memory: Memory;
  now: Date;
  /** search: why this memory matched */
  reasons?: string[];
  /** home: extra context line, e.g. why it needs attention */
  note?: string;
  /** home: label the summary as Aiko's reading */
  understood?: boolean;
}) {
  const view = effective(memory);
  return (
    <article className="group lift relative flex gap-4 rounded-3xl border-2 border-line/80 bg-card p-4 shadow-card sm:p-5">
      <TypeGlyph type={view.contentType} />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-bold tracking-wide text-ink-faint uppercase">
          {TYPE_LABEL[view.contentType]} <span aria-hidden="true">·</span> {sourceLabel(memory)}{" "}
          <span aria-hidden="true">·</span> <time dateTime={memory.createdAt}>{timeAgo(memory.createdAt, now)}</time>
        </p>
        <h3 className="mt-1 font-display text-lg leading-snug text-balance">
          <Link
            href={`/memories/${memory.id}`}
            className="rounded-sm after:absolute after:inset-0 after:rounded-2xl after:content-[''] group-hover:underline group-hover:decoration-line group-hover:underline-offset-4 focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-moss"
          >
            {view.title}
          </Link>
        </h3>
        {view.summary && (
          <p className="mt-1.5 line-clamp-2 text-[15px] leading-relaxed text-ink-soft">
            {understood && <span className="font-bold text-moss-ink">Aiko understood: </span>}
            {view.summary}
          </p>
        )}
        {note && <p className="mt-2 text-sm font-medium text-amber-ink">{note}</p>}
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {view.deadline && <DeadlineChip date={view.deadline} days={daysUntil(view.deadline, now)} />}
          {memory.status !== "ready" && <StatusPill status={memory.status} />}
          {view.edited.length > 0 && <EditedTag />}
          {view.intentKind && <Tag tone="moss">{INTENT_LABEL[view.intentKind]}</Tag>}
          {view.suggestedIntent && <Tag tone="amber">Guess: {INTENT_LABEL[view.suggestedIntent.kind]}?</Tag>}
          {memory.isSample && <SampleTag />}
        </div>
        {reasons && reasons.length > 0 && (
          <div className="mt-3 border-t border-line/70 pt-3">
            <p className="text-xs font-medium text-ink-faint">Why it matched</p>
            <ul className="mt-1 space-y-0.5 text-sm text-ink-soft">
              {reasons.map((r) => (
                <li key={r} className="flex gap-2">
                  <span aria-hidden="true" className="text-moss">
                    ✓
                  </span>
                  {r}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </article>
  );
}
