import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { TYPE_LABEL } from "@/components/format";
import { MemoryCard } from "@/components/MemoryCard";
import { ProcessingWatcher } from "@/components/ProcessingWatcher";
import { CardSkeleton, EmptyState, PageIntro } from "@/components/ui";
import { ContentType, effective } from "@/lib/schema";
import { listMemories } from "@/lib/store";

export const metadata: Metadata = { title: "Memories" };

const WHY: Record<string, string> = {
  type: "it isn't a PNG, JPEG, WebP, GIF or PDF",
  large: "it is too large",
  heic: "it is an Apple HEIC photo, which Acorn can't read yet",
  limit: "only the first 10 files of one share are saved",
  failed: "it couldn't be stored",
};

/** What a multi-file share did: how many were saved, how many were already saved, and which were skipped and why. */
async function SharedNotice({ searchParams }: Pick<PageProps<"/memories">, "searchParams">) {
  const q = await searchParams;
  const n = (k: string) => (typeof q[k] === "string" && /^\d{1,3}$/.test(q[k] as string) ? Number(q[k]) : 0);
  const shared = n("shared");
  if (!shared) return null;
  const skipped = n("skipped");
  const dup = n("dup");
  const why = (typeof q.why === "string" ? q.why.split(",") : []).filter((w) => w in WHY).map((w) => WHY[w]);
  return (
    <p role="status" className="mt-6 rounded-2xl bg-moss-soft px-4 py-3 text-[15px] text-moss-ink" data-testid="shared-notice">
      Saved {shared} {shared === 1 ? "item" : "items"} from your share{dup ? ` (${dup} ${dup === 1 ? "was" : "were"} already saved, so no copy was made)` : ""}.
      {skipped > 0 && ` Skipped ${skipped}: ${why.join("; ") || "they couldn't be saved"}.`}
    </p>
  );
}

export default function MemoriesPage({ searchParams }: PageProps<"/memories">) {
  return (
    <div>
      <PageIntro mood="happy" title="Memories">Everything you&apos;ve saved, newest first. I&apos;ve kept it all safe.</PageIntro>
      <Suspense fallback={null}>
        <SharedNotice searchParams={searchParams} />
      </Suspense>
      <Suspense fallback={<div className="mt-8"><CardSkeleton count={4} /></div>}>
        <MemoryIndex searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function MemoryIndex({ searchParams }: Pick<PageProps<"/memories">, "searchParams">) {
  const { type: raw } = await searchParams;
  await connection();
  const type = ContentType.safeParse(raw).data;
  const now = new Date();
  const all = await listMemories();
  const counts = new Map<ContentType, number>();
  for (const m of all) {
    const t = effective(m).contentType;
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const shown = type ? all.filter((m) => effective(m).contentType === type) : all;
  const chips: { href: string; label: string; count: number; active: boolean }[] = [
    { href: "/memories", label: "All", count: all.length, active: !type },
    ...ContentType.options
      .filter((t) => counts.has(t))
      .map((t) => ({ href: `/memories?type=${t}`, label: TYPE_LABEL[t], count: counts.get(t)!, active: t === type })),
  ];

  const working = all.filter((m) => m.status === "pending" || m.status === "processing");

  return (
    <>
      {working.length > 0 && <ProcessingWatcher stalled={working.filter((m) => m.status === "pending").map((m) => m.id)} />}
      {all.length > 0 && (
        <nav aria-label="Filter by type" className="mt-8">
          <ul className="flex flex-wrap gap-2">
            {chips.map((c) => (
              <li key={c.href}>
                <Link
                  href={c.href}
                  aria-current={c.active ? "page" : undefined}
                  className={`inline-flex items-center gap-1.5 rounded-full border-2 px-3.5 py-1 text-[15px] font-bold transition-colors ${
                    c.active ? "border-moss bg-moss text-white" : "border-line bg-card text-ink-soft hover:border-ink-faint hover:text-ink"
                  }`}
                >
                  {c.label}
                  <span className={c.active ? "text-white/80" : "text-ink-faint"}>{c.count}</span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      )}
      <div className="mt-6 grid gap-3">
        {shown.length === 0 ? (
          <EmptyState
            mood="sleeping"
            title={type ? `No ${TYPE_LABEL[type].toLowerCase()} memories` : "Nothing saved yet"}
            action={{ href: "/capture", label: "Capture something" }}
          />
        ) : (
          shown.map((m) => <MemoryCard key={m.id} memory={m} now={now} />)
        )}
      </div>
    </>
  );
}
