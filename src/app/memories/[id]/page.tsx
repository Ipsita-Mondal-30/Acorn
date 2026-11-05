import { Aiko } from "@/components/Aiko";
import { ExploreImage } from "@/components/ExploreImage";
import { ModelNote } from "@/components/ModelNote";
import { VisualAidPanel } from "@/components/VisualAid";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { ActionsPanel } from "@/components/ActionsPanel";
import type { CvInfo } from "@/components/AgentControls";
import { PlanPanel } from "@/components/PlanPanel";
import { ProcessingWatcher } from "@/components/ProcessingWatcher";
import { RemindersSection } from "@/components/RemindersSection";
import type { CvDocument } from "@/lib/cv/types";
import { daysUntil, domainOf, formatDate, formatDateTime, safeHref, timeAgo, TYPE_LABEL } from "@/components/format";
import { CorrectionForm, DeleteMemory, FactsEditor, IntentPanel, ProcessButton, RestoreEdits, SuggestSteps } from "@/components/MemoryControls";
import { CardSkeleton, DeadlineChip, EditedTag, SampleTag, StatusPill, Tag, TypeGlyph } from "@/components/ui";
import { walledNote, walledPlatform } from "@/lib/platforms";
import { insightsFor } from "@/lib/insights";
import { relatedMemories } from "@/lib/related";
import { effective, type Extraction, type Memory, type MemoryView } from "@/lib/schema";
import { getEnv } from "@/lib/env";
import { getCvDocument, getMemory, listArtifacts, getPrefs, listActions, listDeliveries, listMemories, listPlans, listReminders } from "@/lib/store";

export const metadata: Metadata = { title: "Memory" };

const cvInfo = (d: CvDocument): CvInfo => ({
  originalName: d.originalName,
  source: d.source,
  fileKind: d.fileKind,
  byteSize: d.byteSize,
  createdAt: d.createdAt,
  characters: d.text.length,
  counts: { experience: d.parsed.experience.length, projects: d.parsed.projects.length, skills: d.parsed.skills.length, education: d.parsed.education.length, certifications: d.parsed.certifications.length },
  name: d.parsed.name?.text ?? null,
  contact: [...d.parsed.contact.emails, ...d.parsed.contact.phones].map((c) => c.text).slice(0, 3),
  warnings: d.parsed.warnings.map((w) => w.message).slice(0, 4),
  fileName: d.fileName,
});

export default function MemoryPage({ params, searchParams }: PageProps<"/memories/[id]">) {
  return (
    <div>
      <Link href="/memories" className="text-sm font-medium text-ink-soft hover:text-ink">
        <span aria-hidden="true">←</span> All memories
      </Link>
      <Suspense fallback={<div className="mt-8"><CardSkeleton count={3} /></div>}>
        <MemoryDetail params={params} searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function MemoryDetail({ params, searchParams }: Pick<PageProps<"/memories/[id]">, "params" | "searchParams">) {
  const { id } = await params;
  const justSaved = (await searchParams).saved === "1";
  await connection();
  const memory = await getMemory(id);
  if (!memory) notFound();
  // the plan, reminder and CV tables come from a later migration: until it is applied, the page still works without them
  const optional = <T,>(p: Promise<T>, fallback: T) =>
    p.catch((e) => {
      console.error(`[memory page] optional data unavailable: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`);
      return fallback;
    });
  const [actions, plans, reminders, cv, prefs, deliveries, artifacts] = await Promise.all([
    listActions(id),
    optional(listPlans(id), []),
    optional(listReminders({ memoryId: id }), []),
    optional(getCvDocument(), null),
    optional(getPrefs(), null),
    optional(listDeliveries({ limit: 200 }), []),
    optional(listArtifacts({ memoryId: id }), []),
  ]);
  const realMeta = getEnv().ACORN_MODE === "meta";
  const voice = artifacts.find((a) => a.kind === "voice");
  const aids = artifacts.filter((a) => a.kind === "visual_aid");
  const segs = artifacts.filter((a) => a.kind === "segmentation");
  const reads = artifacts.filter((a) => a.kind === "region_reading");
  const tz = prefs?.timezone ?? "UTC";
  const allMemories = await listMemories();
  const related = relatedMemories(memory, allMemories);
  const now = new Date();
  const view = effective(memory);
  const x = memory.extraction;
  const noticed = insightsFor(memory, { memories: allMemories, plans, reminders, actions, now });

  return (
    <article className="mt-4">
      {(memory.status === "pending" || memory.status === "processing") && <ProcessingWatcher stalled={memory.status === "pending" ? [memory.id] : []} />}
      {justSaved && (
        <div role="status" className="mb-5 flex max-w-3xl items-center gap-3 rounded-3xl bg-moss-soft px-4 py-3 text-[15px] text-moss-ink">
          <Aiko mood="celebrating" size={72} className="shrink-0" />
          <p>
            <b>Yay! I saved that for you.</b> Your original is kept exactly as you gave it
            {memory.status === "ready" ? "." : ", and I'm reading it now. This page updates by itself."}
          </p>
        </div>
      )}
      <header className="max-w-3xl">
        <div className="flex items-center gap-3">
          <TypeGlyph type={view.contentType} className="size-9" />
          <p className="text-sm text-ink-faint">
            {TYPE_LABEL[view.contentType]} · saved <time dateTime={memory.createdAt}>{timeAgo(memory.createdAt, now)}</time>
          </p>
        </div>
        <h1 className="mt-4 font-display text-3xl leading-tight text-balance sm:text-4xl">
          {view.title}
        </h1>
        {(memory.status === "pending" || memory.status === "processing") && (
          <p className="mt-4 flex items-center gap-2 text-[15px] font-semibold text-ink-soft"><Aiko mood="reading" size={64} />Give me a second, I&apos;m reading this…</p>
        )}
        {memory.status === "failed" && (
          <p className="mt-4 flex items-center gap-2 text-[15px] font-semibold text-danger"><Aiko mood="confused" size={64} />I couldn&apos;t read this one. Your original is safe, and you can try again below.</p>
        )}
        {memory.status === "ready" && (
          <p className="mt-4 flex items-center gap-2 text-[15px] font-semibold text-moss-ink"><Aiko mood="happy" size={64} />I found something interesting here!</p>
        )}
        <div className="mt-3 flex flex-wrap gap-1.5">
          <StatusPill status={memory.status} />
          {view.deadline && <DeadlineChip date={view.deadline} days={daysUntil(view.deadline, now)} />}
          {view.edited.length > 0 && <EditedTag />}
          {memory.isSample && <SampleTag />}
        </div>
        {view.intent && view.edited.includes("intent") && (
          <p className="mt-5 border-l-2 border-amber pl-4 font-display text-lg text-ink-soft italic">
            You wrote: {view.intent}
          </p>
        )}
      </header>

      {voice && (
        <div className="mt-4 max-w-3xl rounded-3xl border-2 border-lav/30 bg-lav-soft/40 p-4 text-sm" data-testid="voice-origin">
          <p className="font-bold text-lav-ink">A spoken note</p>
          <p className="mt-1 text-ink-soft">
            You recorded this{typeof voice.input.audioDurationMs === "number" ? ` (${Math.round(Number(voice.input.audioDurationMs) / 1000)} s)` : ""}; the transcript below is what was saved{(voice.output as { confirmedText?: string }).confirmedText && (voice.output as { transcript?: string }).transcript !== (voice.output as { confirmedText?: string }).confirmedText ? ", after you edited it" : ""}. The original audio is kept privately.
          </p>
          <div className="mt-2"><ModelNote a={voice} label="Transcription" /></div>
        </div>
      )}

      {noticed.length > 0 && (
        <section aria-labelledby="noticed" className="mt-6 max-w-3xl rounded-3xl border-2 border-moss/30 bg-moss-soft/40 p-4 sm:p-5" data-testid="noticed">
          <h2 id="noticed" className="font-display text-xl">What Aiko noticed</h2>
          <ul className="mt-2 space-y-3">
            {noticed.map((n) => (
              <li key={n.key}>
                <Link href={n.href} className="font-semibold underline-offset-4 hover:underline">{n.title}</Link>
                <p className="text-[15px] text-ink-soft">{n.detail}</p>
                <p className="text-xs text-ink-faint">Why: {n.why}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {memory.status === "ready" && (
        <IntentPanel
          key={`${view.intentStatus}-${view.intentKind}-${view.suggestedIntent?.kind}`}
          memoryId={memory.id}
          view={view}
          alternatives={view.suggestedIntent ? (x?.alternativeIntents ?? []) : []}
        />
      )}

      <div className="mt-10 grid gap-12 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-14">
          <Understanding memory={memory} view={view} />
          <PlanPanel memory={memory} plans={plans} actions={actions} cv={cv ? cvInfo(cv) : null} />
          {memory.status === "ready" && <VisualAidPanel memoryId={memory.id} aids={aids} ready real={realMeta} />}
          {memory.source.kind === "image" && memory.source.fileName && (
            <ExploreImage memoryId={memory.id} imageUrl={`/api/files/${encodeURIComponent(memory.source.fileName)}`} segmentations={segs} readings={reads} real={realMeta} />
          )}
          <RemindersSection memory={memory} reminders={reminders} actions={actions} deliveries={deliveries} tz={tz} now={now} />
          <ActionsPanel memory={memory} actions={actions} planActionIds={plans.map((p) => p.actionId)} />
          {x && <SuggestSteps memoryId={memory.id} memoryAcorn={x.producedBy.provider} />}
          <RelatedBlock related={related} />
        </div>
        <aside className="min-w-0 space-y-8">
          <SourcePanel memory={memory} />
          <details className="group rounded-3xl border-2 border-line/80 bg-card p-4 sm:p-5">
            <summary className="cursor-pointer font-medium marker:text-ink-faint">Correct something</summary>
            <p className="mt-2 text-sm text-ink-soft">Your corrections always win over what Acorn extracted.</p>
            <div className="mt-4">
              <CorrectionForm
                memoryId={memory.id}
                initial={{
                  title: view.title,
                  contentType: view.contentType,
                  summary: view.summary,
                  intent: view.intent,
                  deadline: view.deadline,
                }}
              />
              <FactsEditor key={JSON.stringify(view.facts)} memoryId={memory.id} facts={view.facts} />
              <RestoreEdits memoryId={memory.id} edited={view.edited} />
            </div>
          </details>
          {x && (
            <div>
              <ProcessButton memoryId={memory.id} op="reprocess" label="Read it again" />
              <p className="mt-2 text-xs text-ink-faint">Runs extraction afresh. Your corrections are kept.</p>
            </div>
          )}
          {!memory.isSample && <DeleteMemory memoryId={memory.id} hasFile={Boolean(memory.source.fileName)} />}
        </aside>
      </div>
    </article>
  );
}

function Understanding({ memory, view }: { memory: Memory; view: MemoryView }) {
  const x = memory.extraction;
  return (
    <section aria-labelledby="understood">
      <h2 id="understood" className="font-display text-2xl">
        What Acorn understood
      </h2>

      {!x && memory.status !== "failed" && (
        <div className="mt-4 rounded-2xl border border-dashed border-line p-5">
          <p className="flex items-center gap-2 text-[15px] text-ink-soft">
            {memory.status === "processing" && <span className="size-2 animate-pulse rounded-full bg-amber" aria-hidden="true" />}
            {memory.status === "processing" ? "Acorn is reading this now…" : "Saved and waiting in the queue. Acorn hasn’t read this yet."}
          </p>
          <div className="mt-3">
            <ProcessButton memoryId={memory.id} op="process" label="Understand it now" primary />
          </div>
        </div>
      )}
      {memory.status === "failed" && (
        <div className="mt-4 rounded-2xl bg-danger-soft p-5">
          <p className="text-[15px] text-danger">
            {memory.error ?? "Acorn couldn't understand this one."} The original is saved safely.
          </p>
          <div className="mt-3">
            <ProcessButton memoryId={memory.id} op="reprocess" label="Try again" primary />
          </div>
        </div>
      )}

      {x && (
        <div className="mt-4 space-y-8">
          {x.producedBy.provider === "mock" && (
            <p className="rounded-xl border border-amber/40 bg-amber-soft px-4 py-3 text-sm text-amber-ink">
              <strong className="font-semibold">Demo extraction (mock, no AI model).</strong> These fields come from
              Acorn&apos;s built-in demo rules, not from a model reading your item.
              {x.producedBy.note && <span className="mt-1 block">{x.producedBy.note}</span>}
            </p>
          )}
          {x.producedBy.provider === "meta" && x.producedBy.note && (
            <p className="rounded-2xl bg-butter-soft px-4 py-3 text-[15px] text-butter-ink" data-testid="replay-note">
              <strong className="font-semibold">Saved result, replayed.</strong> {x.producedBy.note}
            </p>
          )}

          <ReadingKey x={x} />

          <div>
            <p className="text-[17px] leading-relaxed">{view.summary || <span className="text-ink-faint">No summary.</span>}</p>
            {view.edited.includes("summary") && <p className="mt-1 text-xs text-moss-ink">Summary edited by you</p>}
          </div>

          <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
            <Field label="Type" edited={view.edited.includes("contentType")}>
              {TYPE_LABEL[view.contentType]}
            </Field>
            <Field label={view.edited.includes("intent") ? "Intent" : "Acorn's reading of intent"} edited={view.edited.includes("intent")}>
              {view.intent ?? <span className="text-ink-faint">None noted</span>}
            </Field>
          </dl>

          {x.job && <JobBlock job={x.job} deadline={view.deadline} deadlineEdited={view.edited.includes("deadline")} />}

          {x.dates.length > 0 && (
            <Block title="Dates">
              <ul className="space-y-3">
                {x.dates.map((d, i) => (
                  <li key={i}>
                    <p>
                      <time dateTime={d.date} className="font-medium">
                        {formatDate(d.date)}
                      </time>{" "}
                      — {d.label} {d.isDeadline && <Tag tone="amber">Deadline</Tag>}
                    </p>
                    {d.evidence && <Quote>{d.evidence}</Quote>}
                  </li>
                ))}
              </ul>
            </Block>
          )}

          <FactsBlock facts={view.facts} edited={view.edited.includes("facts")} />

          {(x.entities.length > 0 || x.topics.length > 0) && (
            <div className="grid gap-8 sm:grid-cols-2">
              {x.entities.length > 0 && (
                <Block title="People, places & things">
                  <ul className="flex flex-wrap gap-1.5">
                    {x.entities.map((e) => (
                      <li key={`${e.kind}-${e.name}`}>
                        <span className="inline-flex rounded-full border border-line bg-card px-2.5 py-0.5 text-sm" title={e.kind}>
                          {e.name}
                        </span>
                      </li>
                    ))}
                  </ul>
                </Block>
              )}
              {x.topics.length > 0 && (
                <Block title="Topics">
                  <ul className="flex flex-wrap gap-1.5">
                    {x.topics.map((t) => (
                      <li key={t}>
                        <span className="inline-flex rounded-full bg-paper-deep px-2.5 py-0.5 text-sm text-ink-soft">#{t}</span>
                      </li>
                    ))}
                  </ul>
                </Block>
              )}
            </div>
          )}

          {x.evidence.length > 0 && (
            <Block title="Evidence from your item">
              <ul className="space-y-3">
                {x.evidence.map((e, i) => (
                  <li key={i}>
                    <Quote>{e.quote}</Quote>
                    <p className="mt-1 text-xs text-ink-faint">supports: {e.supports}</p>
                  </li>
                ))}
              </ul>
            </Block>
          )}

          <Confidence x={x} />
          <Provenance x={x} />
        </div>
      )}
    </section>
  );
}

/** Who produced what you are reading, and what each kind of label means. Never calls an extracted fact "verified". */
function ReadingKey({ x }: { x: Extraction }) {
  const p = x.producedBy;
  return (
    <div className="rounded-3xl border-2 border-line/80 bg-card p-4 text-sm" data-testid="reading-key">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Tag tone="amber">AI-extracted</Tag>
        <span className="text-ink-soft">
          {p.provider === "mock" ? "Demo rules, no model" : `Read by Meta ${p.model}`}. Everything below is a reading of your item, and it can be wrong.
        </span>
      </p>
      <dl className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-3">
        <div>
          <dt className="font-medium">Evidence</dt>
          <dd className="text-ink-soft">A quote the model attached to a claim. It shows where the claim came from, not that it is true.</dd>
        </div>
        <div>
          <dt className="font-medium">Checked by Acorn</dt>
          <dd className="text-ink-soft">Only when the quote was found in text you saved. A screenshot or PDF can&apos;t be checked this way.</dd>
        </div>
        <div>
          <dt className="font-medium">Verified by you</dt>
          <dd className="text-ink-soft">Anything you confirm or edit yourself.</dd>
        </div>
      </dl>
    </div>
  );
}

function Field({ label, edited, children }: { label: string; edited?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium tracking-wide text-ink-faint uppercase">
        {label}
        {edited && <span className="ml-2 tracking-normal text-moss-ink normal-case">edited by you</span>}
      </dt>
      <dd className="mt-1 text-[15px]">{children}</dd>
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-3 text-xs font-medium tracking-wide text-ink-faint uppercase">{title}</h3>
      {children}
    </div>
  );
}

function Quote({ children }: { children: React.ReactNode }) {
  return (
    <blockquote className="mt-1 border-l-2 border-line pl-3 font-display text-[15px] text-ink-soft italic">
      &ldquo;{children}&rdquo;
    </blockquote>
  );
}

function JobBlock({
  job,
  deadline,
  deadlineEdited,
}: {
  job: NonNullable<Extraction["job"]>;
  deadline: string | null;
  deadlineEdited: boolean;
}) {
  const apply = safeHref(job.applyUrl);
  return (
    <div className="rounded-3xl border-2 border-line/80 bg-card p-5">
      <h3 className="font-display text-lg">Job details</h3>
      <dl className="mt-4 grid gap-x-8 gap-y-4 sm:grid-cols-2">
        <Field label="Company">{job.company ?? "—"}</Field>
        <Field label="Role">{job.role ?? "—"}</Field>
        <Field label="Location">{job.location ?? "—"}</Field>
        <Field label="Deadline" edited={deadlineEdited}>
          {deadline ? formatDate(deadline) : "None found"}
        </Field>
        <Field label="Apply link">
          {apply ? (
            <a href={apply} target="_blank" rel="noopener noreferrer nofollow" className="break-all text-moss-ink underline underline-offset-4">
              {domainOf(apply)}
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          ) : (
            "—"
          )}
        </Field>
      </dl>
      {job.requirements.length > 0 && (
        <div className="mt-5">
          <p className="text-xs font-medium tracking-wide text-ink-faint uppercase">Requirements</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-[15px] marker:text-ink-faint">
            {job.requirements.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** What the item itself states, each with the words it rests on. Separate from the summary and from intent. */
function FactsBlock({ facts, edited }: { facts: MemoryView["facts"]; edited: boolean }) {
  if (facts.length === 0) return null;
  return (
    <Block title="What it states (AI-extracted, with its evidence)">
      <ul className="space-y-3">
        {facts.map((f, i) => (
          <li key={i}>
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span>{f.statement}</span>
              {f.by === "you" ? (
                <Tag tone="moss">Added by you</Tag>
              ) : f.checked ? (
                <span title="The quote was found in the text you saved"><Tag tone="moss">Checked: quote is in your text</Tag></span>
              ) : (
                <span title="The model read this from the image or document. Acorn cannot check the quote against text, so it is not verified."><Tag tone="amber">AI-read, not verified</Tag></span>
              )}
              {f.page !== null && <Tag>page {f.page}</Tag>}
            </p>
            {f.quote && <Quote>{f.quote}</Quote>}
          </li>
        ))}
      </ul>
      {edited && <p className="mt-2 text-xs text-moss-ink">Facts edited by you</p>}
    </Block>
  );
}

function RelatedBlock({ related }: { related: ReturnType<typeof relatedMemories> }) {
  if (related.length === 0) return null;
  return (
    <section aria-labelledby="related">
      <h2 id="related" className="font-display text-2xl">Connected memories</h2>
      <p className="mt-1 text-sm text-ink-soft">Linked by something they share, so you can judge whether the link is real.</p>
      <ul className="mt-4 space-y-3">
        {related.map(({ memory, reasons }) => (
          <li key={memory.id} className="rounded-3xl border-2 border-line/80 bg-card p-4">
            <Link href={`/memories/${memory.id}`} className="font-medium text-moss-ink underline underline-offset-4">
              {effective(memory).title}
            </Link>
            <ul className="mt-1.5 flex flex-wrap gap-1.5">
              {reasons.map((r) => (
                <li key={r}><Tag>{r}</Tag></li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Confidence({ x }: { x: Extraction }) {
  const pct = Math.round(x.confidence * 100);
  const bar = pct >= 75 ? "bg-moss" : pct >= 50 ? "bg-amber" : "bg-danger";
  return (
    <Block title="How well the item supports this reading">
      <div className="flex items-center gap-3">
        <div
          role="meter"
          aria-label="Extraction confidence"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-valuetext={`${pct} percent`}
          className="h-2 w-full max-w-xs overflow-hidden rounded-full bg-paper-deep"
        >
          <div className={`h-full rounded-full ${bar}`} style={{ width: `${pct}%` }} />
        </div>
        <span className="text-sm font-medium tabular-nums">{pct}%</span>
      </div>
      <p className="mt-1 text-xs text-ink-faint">A rough indication, not a calibrated probability.</p>
      {x.uncertainties.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm text-ink-soft">
          {x.uncertainties.map((u) => (
            <li key={u} className="flex gap-2">
              <span aria-hidden="true" className="text-amber">
                ?
              </span>
              {u}
            </li>
          ))}
        </ul>
      )}
    </Block>
  );
}

function Provenance({ x }: { x: Extraction }) {
  const p = x.producedBy;
  return (
    <p className="border-t border-line/70 pt-4 text-xs text-ink-faint">
      Read by {p.provider === "mock" ? "demo rules (no model)" : "Meta"} · {p.model} ·{" "}
      <time dateTime={p.at}>{formatDateTime(p.at)}</time>
      {p.latencyMs !== undefined && ` · ${(p.latencyMs / 1000).toFixed(1)}s`}
      {p.usage && ` · ${p.usage.totalTokens.toLocaleString()} tokens`}
      {p.usage?.estimatedCostUsd != null && ` · about $${p.usage.estimatedCostUsd.toFixed(4)} at list price`}
    </p>
  );
}

function SourcePanel({ memory }: { memory: Memory }) {
  const s = memory.source;
  const href = safeHref(s.url);
  return (
    <section aria-labelledby="source" className="rounded-3xl border-2 border-line/80 bg-card p-4 sm:p-5">
      <h2 id="source" className="text-xs font-medium tracking-wide text-ink-faint uppercase">
        What you saved
      </h2>
      <div className="mt-3 space-y-3 text-[15px]">
        {s.kind === "url" &&
          (href ? (
            <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="block rounded-lg">
              <span className="block font-medium text-moss-ink underline underline-offset-4">
                {domainOf(href)} <span aria-hidden="true">↗</span>
                <span className="sr-only">(opens in a new tab)</span>
              </span>
              <span className="mt-0.5 block truncate text-sm text-ink-faint">{href}</span>
            </a>
          ) : (
            <p className="break-all text-ink-soft">{s.url}</p>
          ))}

        {s.kind === "url" && walledPlatform(s.url) && (
          <p className="rounded-xl bg-amber-soft px-3 py-2 text-sm text-amber-ink">{walledNote(walledPlatform(s.url)!)}</p>
        )}

        {s.kind === "document" && s.fileName && (
          <a
            href={`/api/files/${encodeURIComponent(s.fileName)}`}
            className="block rounded-xl border border-line bg-paper-deep px-3 py-3 font-medium text-moss-ink underline underline-offset-4"
          >
            Open the original PDF{s.originalName ? `: ${s.originalName}` : ""}
          </a>
        )}

        {s.kind === "image" &&
          (s.fileName ? (
            // eslint-disable-next-line @next/next/no-img-element -- private upload served by /api/files, not optimisable
            <img
              src={`/api/files/${encodeURIComponent(s.fileName)}`}
              alt={s.originalName ? `Saved image: ${s.originalName}` : "Saved image"}
              className="w-full rounded-xl border border-line"
            />
          ) : (
            <p className="rounded-xl bg-paper-deep px-3 py-2 text-sm text-ink-soft">
              The original screenshot isn&apos;t included with the sample data — below is its caption text.
            </p>
          ))}

        {s.text && (
          <div>
            {s.kind !== "note" && (
              <p className="mb-1 text-xs text-ink-faint">{s.kind === "url" ? "Text you pasted" : "Your caption"}</p>
            )}
            <p className="max-h-96 overflow-auto leading-relaxed whitespace-pre-wrap text-ink-soft">{s.text}</p>
          </div>
        )}
        <p className="text-xs text-ink-faint">
          Saved {formatDateTime(memory.createdAt)}
          {s.originalName && ` · ${s.originalName}`}
        </p>
      </div>
    </section>
  );
}
