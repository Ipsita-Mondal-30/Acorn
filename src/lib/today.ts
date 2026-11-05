import type { Plan, Reminder } from "./agent/schema";
import type { Artifact } from "./artifacts";
import { dayDiff, learningPlans, localDay, nextUp, type NextUp } from "./home";
import { recentInsights, type Insight } from "./insights";
import { effective, INTENT_LABEL, type Action, type Memory } from "./schema";

// "Today with Acorn": everything here is computed from what is actually saved (memories, plans, reminders, artifacts).
// Each entry says WHY it is shown. Nothing is guessed, no activity or date is invented, and nothing here acts for you.

export type TodayEntry = {
  key: string; memoryId: string; title: string; verb: string; detail: string; why: string; href: string;
  /** the memory is one of Acorn's built-in demo samples, not something the user saved: it is shown, but marked */
  sample: boolean;
};
export type TodaySection = { id: string; heading: string; hint?: string; entries: TodayEntry[] };

const fmt = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });


/** how far ahead a stored deadline is worth showing (the real Northwind listing in the demo closes in about 70 days) */
export const DEADLINE_HORIZON_DAYS = 90;

type RawEntry = Omit<TodayEntry, "sample">;

export function buildToday(input: { memories: Memory[]; plans: Plan[]; reminders: Reminder[]; artifacts?: Artifact[]; actions?: Action[]; now: Date }): { sections: TodaySection[]; empty: boolean } {
  const { memories, plans, reminders, artifacts = [], actions = [], now } = input;
  const byId = new Map(memories.map((m) => [m.id, m]));
  const isSample = (id: string) => byId.get(id)?.isSample === true;
  const asEntry = (n: NextUp): RawEntry => ({ key: n.key, memoryId: n.memoryId, title: n.title, verb: n.verb, detail: n.detail, why: n.why, href: n.href });
  const used = new Set<string>();
  const take = (e: RawEntry) => (used.has(e.key) ? null : (used.add(e.key), e));

  const next = nextUp(memories, plans, reminders, now, 50).map(asEntry);
  const isApproval = (e: RawEntry) => /^(Approve|A step|Review|Your step|Reminder is due)/.test(e.verb);
  const waiting = next.filter(isApproval).map(take).filter((e): e is RawEntry => !!e);
  const learning = learningPlans(memories, plans)
    .filter((l) => l.plan.status !== "completed" && l.sp)
    .map((l): RawEntry => ({ key: `learn-${l.plan.id}`, memoryId: l.memory.id, title: effective(l.memory).title, verb: "Continue learning", detail: `${l.sp!.percent}% done: ${l.sp!.known} of ${l.sp!.cards} cards known, ${l.sp!.review} to review`, why: "You started this study pack and haven't finished it.", href: `/memories/${l.memory.id}#agent-heading` }))
    .map(take).filter((e): e is RawEntry => !!e);
  // what you already decided (and has no plan yet) comes before what is still only a guess
  const decide = next.filter((e) => e.verb === "Tell Acorn why you saved this" || e.verb === "Make a plan").sort((a, b) => Number(b.verb === "Make a plan") - Number(a.verb === "Make a plan")).map(take).filter((e): e is RawEntry => !!e);

  const today = localDay(now);
  const planned = new Set(plans.filter((p) => p.status !== "rejected").map((p) => p.memoryId));
  const deadlines = memories
    .filter((m) => m.status === "ready")
    .flatMap((m) => {
      const d = effective(m).deadline;
      if (!d) return [];
      const left = dayDiff(today, d);
      if (left < 0 || left > DEADLINE_HORIZON_DAYS) return [];
      const label = left === 0 ? "today" : left === 1 ? "tomorrow" : `in ${left} days`;
      const v = effective(m);
      const intent = v.intentKind ? `, and you said you want to ${INTENT_LABEL[v.intentKind].toLowerCase()} it` : "";
      return [{ left, e: { key: `deadline-${m.id}`, memoryId: m.id, title: v.title, verb: "Deadline", detail: `${fmt(d)}, ${label}`, why: `This date was found in what you saved${intent}${planned.has(m.id) ? "" : ". There's no plan or reminder for it yet"}.`, href: `/memories/${m.id}` } }];
    })
    .sort((a, b) => a.left - b.left)
    .map((x) => take(x.e)).filter((e): e is RawEntry => !!e);

  const soon = reminders
    .filter((r) => (r.status === "scheduled" || r.status === "snoozed") && byId.has(r.memoryId) && Date.parse(r.dueAt) > now.getTime() && Date.parse(r.dueAt) - now.getTime() < 7 * 86_400_000)
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt))
    .map((r): RawEntry => ({ key: `soon-${r.id}`, memoryId: r.memoryId, title: effective(byId.get(r.memoryId)!).title, verb: "Follow-up reminder", detail: `${r.title}: ${fmt(r.dueAt)}`, why: "You asked for this reminder, and it's due in the next week.", href: `/memories/${r.memoryId}` }))
    .map(take).filter((e): e is RawEntry => !!e);

  // new things Acorn made for you since you last looked: voice notes and linked readings the user saved
  const recentVoice = artifacts
    .filter((a) => a.kind === "voice" && a.memoryId && byId.has(a.memoryId) && now.getTime() - Date.parse(a.createdAt) < 3 * 86_400_000)
    .map((a): RawEntry => ({ key: `voice-${a.id}`, memoryId: a.memoryId!, title: effective(byId.get(a.memoryId!)!).title, verb: "Spoken note", detail: "You recorded this recently.", why: "A voice note you saved in the last three days; open it to choose what to do with it.", href: `/memories/${a.memoryId}` }))
    .map(take).filter((e): e is RawEntry => !!e);

  // what Acorn noticed in things it read recently: connections to work you already decided on, deadlines, proposed next steps.
  // A deadline already listed above is not repeated here.
  const VERB: Record<Insight["kind"], string> = { joins_work: "Connected to your work", connection: "Related", deadline: "Deadline", next_step: "Possible next step" };
  const deadlineIds = new Set(deadlines.map((d) => d.memoryId));
  const noticed = recentInsights({ memories, plans, reminders, actions, now }, { withinDays: 7, limit: 8 })
    .filter((i) => !(i.kind === "deadline" && deadlineIds.has(i.memoryId)))
    .map((i): RawEntry => ({ key: `ins-${i.key}`, memoryId: i.memoryId, title: i.title, verb: VERB[i.kind], detail: i.detail, why: i.why, href: i.href }))
    .map(take).filter((e): e is RawEntry => !!e);

  const sections: TodaySection[] = [
    { id: "waiting", heading: "Waiting for you", hint: "Nothing here happens until you say so.", entries: waiting },
    { id: "deadlines", heading: "Deadlines coming up", entries: deadlines },
    { id: "learning", heading: "Learning worth continuing", entries: learning },
    { id: "decide", heading: "Unfinished intentions", hint: "Things you saved that are waiting for a decision or a plan.", entries: decide },
    { id: "followups", heading: "Follow-ups", entries: [...soon, ...recentVoice] },
    { id: "noticed", heading: "Noticed in what you saved", hint: "Found by comparing new things with what you already have.", entries: noticed },
  ]
    // the person's own items come first, built-in samples after them (and are marked), then the most pressing six are kept
    .map((s) => ({
      ...s,
      entries: s.entries
        .map((e) => ({ ...e, sample: isSample(e.memoryId) }))
        .sort((a, b) => Number(a.sample) - Number(b.sample))
        .slice(0, 6),
    }))
    .filter((s) => s.entries.length > 0);
  return { sections, empty: sections.length === 0 };
}
