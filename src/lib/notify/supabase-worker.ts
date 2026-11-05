import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { deliveryToRow, rowToDelivery, rowToMemory, rowToPlan, rowToPrefs, rowToReminder, rowToAction } from "../backends/supabase";
import { StoreError } from "../backends/types";
import type { Snapshot } from "./followthrough";
import type { ClaimedDelivery, DueReminder, WorkerStore } from "./worker";

type Row = Record<string, unknown>;

/**
 * The worker's view of Supabase, using the SERVICE ROLE (which bypasses row-level security: that is what lets one scheduled
 * job serve every user). It is used by exactly one caller, the secret-protected /api/cron/tick, and every query below is
 * scoped to one user's rows at a time: reminders by their own user_id, memories/plans/actions by that same user_id, and
 * a delivery is only ever written for the user that owns its reminder. A reminder whose memory belongs to someone else
 * (which the composite foreign keys make impossible) is dropped rather than used.
 */
export function supabaseWorkerStore(c: SupabaseClient, emailOf: (userId: string) => Promise<string | null>): WorkerStore {
  const rows = <T>(res: { data: T; error: { message: string; code?: string } | null }, what: string): T => {
    if (res.error) {
      console.error(`[worker] ${what} failed: ${res.error.code ?? ""} ${res.error.message.slice(0, 300)}`);
      throw new StoreError("The database request failed.");
    }
    return res.data;
  };
  const emailCache = new Map<string, string | null>();
  const email = async (u: string) => {
    if (!emailCache.has(u)) emailCache.set(u, await emailOf(u).catch(() => null));
    return emailCache.get(u)!;
  };
  const prefsOf = async (userIds: string[]) => {
    const out = new Map<string, ReturnType<typeof rowToPrefs>>();
    if (!userIds.length) return out;
    for (const r of rows(await c.from("notification_preferences").select("*").in("user_id", userIds), "prefs") as Row[]) out.set(r.user_id as string, rowToPrefs(r));
    return out;
  };

  return {
    async unprocessedDueReminders(now, limit) {
      // Reminders stay open after they were announced or expired, so the oldest ones can all be "already handled". Page through
      // them (oldest first, by due time) until enough unhandled ones are found, so a long overdue backlog never starves new ones.
      const PAGE = 300;
      const MAX_PAGES = 30;
      const fresh: Row[] = [];
      let cursor: string | null = null;
      const visited = new Set<string>();
      for (let page = 0; page < MAX_PAGES && fresh.length < limit; page++) {
        let q = c.from("reminders").select("*").in("status", ["scheduled", "snoozed"]).lte("due_at", now.toISOString()).order("due_at", { ascending: true }).limit(PAGE);
        if (cursor) q = q.gte("due_at", cursor); // >=, so reminders sharing the last due time of a full page are not skipped
        const rs = (rows(await q, "due reminders") as Row[]).filter((r) => !visited.has(r.id as string));
        if (!rs.length) break;
        rs.forEach((r) => visited.add(r.id as string));
        const done = rows(await c.from("notification_deliveries").select("reminder_id, due_at").eq("kind", "reminder").in("reminder_id", rs.map((r) => r.id as string)), "deliveries") as Row[];
        const seen = new Set(done.map((d) => `${d.reminder_id}|${Date.parse(d.due_at as string)}`));
        for (const r of rs) if (!seen.has(`${r.id}|${Date.parse(r.due_at as string)}`) && fresh.length < limit) fresh.push(r);
        if (rs.length < PAGE / 2) break; // a short page (after dropping ones already seen) means the end
        cursor = rs[rs.length - 1].due_at as string;
      }
      if (!fresh.length) return [];
      const users = [...new Set(fresh.map((r) => r.user_id as string))];
      const prefs = await prefsOf(users);
      const out: DueReminder[] = [];
      for (const userId of users) {
        const mine = fresh.filter((r) => r.user_id === userId);
        const memIds = [...new Set(mine.map((r) => r.memory_id as string))];
        const mems = rows(await c.from("memories").select("*").eq("user_id", userId).in("id", memIds), "memories") as Row[];
        const plans = rows(await c.from("plans").select("*").eq("user_id", userId).in("memory_id", memIds), "plans") as Row[];
        for (const r of mine) {
          const m = mems.find((x) => x.id === r.memory_id);
          if (!m) continue; // never use a memory that isn't this user's
          out.push({ userId, reminder: rowToReminder(r), memory: rowToMemory(m), plans: plans.filter((p) => p.memory_id === r.memory_id).map(rowToPlan), prefs: prefs.get(userId) ?? rowToPrefs(null) });
        }
      }
      return out;
    },

    async deliveryExists(userId, key) {
      return (rows(await c.from("notification_deliveries").select("id").eq("user_id", userId).eq("dedupe_key", key).limit(1), "delivery lookup") as Row[]).length > 0;
    },

    async insertDelivery(userId, d) {
      const res = rows(await c.from("notification_deliveries").upsert(deliveryToRow(d, userId), { onConflict: "user_id,dedupe_key", ignoreDuplicates: true }).select("id"), "queue delivery") as Row[];
      return res.length > 0;
    },

    async claimDeliveries(now, limit, leaseSeconds) {
      const claimed = rows(await c.rpc("claim_deliveries", { p_now: now.toISOString(), p_limit: limit, p_lease_seconds: leaseSeconds }), "claim deliveries") as Row[];
      const out: ClaimedDelivery[] = [];
      const users = [...new Set(claimed.map((r) => r.user_id as string))];
      const prefs = await prefsOf(users);
      for (const r of claimed) {
        const userId = r.user_id as string;
        let reminder = null;
        if (r.reminder_id) {
          const rr = rows(await c.from("reminders").select("*").eq("user_id", userId).eq("id", r.reminder_id as string).maybeSingle(), "reminder") as Row | null;
          reminder = rr ? rowToReminder(rr) : null;
        }
        out.push({ userId, delivery: rowToDelivery(r), prefs: prefs.get(userId) ?? rowToPrefs(null), email: r.channel === "email" ? await email(userId) : null, reminder });
      }
      return out;
    },

    async updateDelivery(id, patch) {
      const row: Row = { locked_until: null };
      if (patch.status !== undefined) row.status = patch.status;
      if (patch.reason !== undefined) row.reason = patch.reason;
      if (patch.attempts !== undefined) row.attempts = patch.attempts;
      if (patch.lastError !== undefined) row.last_error = patch.lastError;
      if (patch.scheduledFor !== undefined) row.scheduled_for = patch.scheduledFor;
      if (patch.sentAt !== undefined) row.sent_at = patch.sentAt;
      rows(await c.from("notification_deliveries").update(row).eq("id", id), "update delivery");
    },

    async sentCount(userId, since, channel) {
      return (rows(await c.from("notification_deliveries").select("id").eq("user_id", userId).eq("kind", "reminder").eq("channel", channel).eq("status", "sent").gte("sent_at", since.toISOString()).limit(1000), "count") as Row[]).length;
    },

    async briefingUsers() {
      const ps = rows(await c.from("notification_preferences").select("*").eq("briefing_enabled", true).eq("enabled", true), "briefing users") as Row[];
      return Promise.all(ps.map(async (r) => ({ userId: r.user_id as string, prefs: rowToPrefs(r), email: await email(r.user_id as string) })));
    },

    async snapshot(userId, now): Promise<Snapshot> {
      const [memories, reminders, actions, plans, prefs] = await Promise.all([
        c.from("memories").select("*").eq("user_id", userId),
        c.from("reminders").select("*").eq("user_id", userId),
        c.from("actions").select("*").eq("user_id", userId),
        c.from("plans").select("*").eq("user_id", userId),
        c.from("notification_preferences").select("*").eq("user_id", userId).maybeSingle(),
      ]);
      return {
        memories: (rows(memories, "memories") as Row[]).map(rowToMemory),
        reminders: (rows(reminders, "reminders") as Row[]).map(rowToReminder),
        actions: (rows(actions, "actions") as Row[]).map(rowToAction),
        plans: (rows(plans, "plans") as Row[]).map(rowToPlan),
        prefs: rowToPrefs(rows(prefs, "prefs") as Row | null),
        now,
      };
    },
  };
}
