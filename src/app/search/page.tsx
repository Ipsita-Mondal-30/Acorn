import type { Metadata } from "next";
import Form from "next/form";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { AskAcorn } from "@/components/AskAcorn";
import { MemoryCard } from "@/components/MemoryCard";
import { buttonClass, EmptyState, fieldClass, PageIntro } from "@/components/ui";
import { getEnv } from "@/lib/env";
import { SEARCH_EXAMPLES } from "@/lib/search-examples";
import { hybridOptions, semanticScores } from "@/lib/indexing";
import { searchMemories } from "@/lib/search";
import { fullTextIds, listMemories } from "@/lib/store";

export const metadata: Metadata = { title: "Search" };

export default function SearchPage({ searchParams }: PageProps<"/search">) {
  return (
    <div>
      <PageIntro mood="curious" title="Search">Ask the way you&apos;d remember it, and I&apos;ll go look.</PageIntro>
      <Suspense fallback={<SearchBox q="" />}>
        <SearchResults searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

function SearchBox({ q }: { q: string }) {
  return (
    <>
      <Form action="/search" role="search" className="mt-8 flex max-w-2xl gap-2">
        <label htmlFor="q" className="sr-only">
          Search your memories
        </label>
        <input
          id="q"
          name="q"
          type="search"
          defaultValue={q}
          maxLength={200}
          placeholder="e.g. that recipe with lemon"
          className={`${fieldClass} rounded-full px-5`}
        />
        <button type="submit" className={buttonClass.primary}>
          Search
        </button>
      </Form>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <span className="text-sm text-ink-faint">Try</span>
        {SEARCH_EXAMPLES.map((ex) => (
          <Link
            key={ex}
            href={`/search?q=${encodeURIComponent(ex)}`}
            className="rounded-full border border-line bg-card px-3 py-1 text-sm text-ink-soft transition-colors hover:border-ink-faint hover:text-ink"
          >
            {ex}
          </Link>
        ))}
      </div>
    </>
  );
}

async function SearchResults({ searchParams }: Pick<PageProps<"/search">, "searchParams">) {
  const raw = (await searchParams).q;
  const q = (Array.isArray(raw) ? raw[0] : raw)?.trim().slice(0, 200) ?? "";
  if (!q) return <SearchBox q="" />;
  await connection();
  const now = new Date();
  const fts = await fullTextIds(q).catch(() => new Map<string, number>()); // the page still works without the database index
  const memories = await listMemories();
  const sem = await semanticScores(q, memories); // off or failed: keyword results only
  const results = searchMemories(memories, q, now, { fts, ...hybridOptions(sem) });
  const demo = getEnv().ACORN_MODE === "demo";

  return (
    <>
      <SearchBox q={q} />
      <AskAcorn key={q} q={q} auto={demo} />
      <section aria-labelledby="results" className="mt-10">
        <h2 id="results" className="sr-only">
          Results
        </h2>
        {results.length === 0 ? (
          <EmptyState title={`Nothing matched “${q}”`} action={{ href: "/memories", label: "Browse all memories" }}>
            Try fewer words, a type of thing (&ldquo;recipe&rdquo;, &ldquo;job&rdquo;), or a name you remember.
          </EmptyState>
        ) : (
          <div className="grid gap-3">
            <p className="text-sm text-ink-soft">
              {results.length} {results.length === 1 ? "memory" : "memories"} for &ldquo;{q}&rdquo;
            </p>
            {sem.status === "ok" && sem.unindexed > 0 && (
              <p className="text-sm text-ink-faint">
                {sem.unindexed} {sem.unindexed === 1 ? "memory isn't" : "memories aren't"} indexed for meaning-based search yet; they match by words only.
              </p>
            )}
            {sem.status !== "ok" && (
              <p className="text-sm text-ink-faint" data-testid="words-only">
                Matching is by words only: meaning-based search isn&apos;t switched on, so something phrased differently from how you saved it may not be found.
              </p>
            )}
            {results.every((r) => r.termsTotal > 1 && r.termsMatched < r.termsTotal) && (
              <p className="text-sm text-ink-soft" data-testid="partial-matches">
                None of these contains all your words. They are partial matches, not confident answers.
              </p>
            )}
            {results.map(({ memory, reasons }) => (
              <MemoryCard key={memory.id} memory={memory} now={now} reasons={reasons} />
            ))}
          </div>
        )}
      </section>
    </>
  );
}
