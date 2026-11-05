import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Plan, Reminder } from "../agent/schema";
import { Artifact } from "../artifacts";
import { CvDocument } from "../cv/types";
import { DEFAULT_PREFS, Delivery, NotificationPrefs } from "../notify/types";
import { Action, effective, Memory } from "../schema";
import { toVectorText, validVector } from "../semantic";
import { PROCESSING_LEASE_MS, StoreError, type Backend, type FileStore, type Store } from "./types";

export const BUCKET = "memory-images";
const MAX_RETRIES = 6;

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID.test(s);

// ───────────────────────── row mapping (pure, unit-tested) ─────────────────────────

/** What full-text search indexes: everything the memory says, never the user's private corrections' history. */
export function searchTextOf(m: Memory): string {
  const v = effective(m);
  const x = m.extraction;
  return [
    v.title,
    v.summary,
    v.intent,
    ...v.facts.map((f) => f.statement),
    ...(x?.entities.map((e) => e.name) ?? []),
    ...(x?.topics ?? []),
    m.source.text,
    m.source.originalName,
    m.source.url,
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 20_000);
}

export function memoryToRow(m: Memory, userId: string): Row {
  const v = effective(m);
  const { source } = m;
  return {
    id: m.id,
    user_id: userId,
    title: v.title.slice(0, 500),
    content_type: v.contentType,
    source_kind: source.kind,
    original_text: source.text ?? null,
    extracted_text: null, // nothing extracts text yet; stays null rather than duplicating the summary
    summary: v.summary.slice(0, 2000),
    source_url: source.url ?? null,
    storage_path: source.fileName ? `${userId}/${source.fileName}` : null,
    mime_type: source.mimeType ?? null,
    original_name: source.originalName ?? null,
    structured_metadata: { extraction: m.extraction, overrides: m.overrides, userIntent: m.userIntent ?? null },
    intent: v.intent,
    intent_confidence: v.suggestedIntent?.confidence ?? null,
    intent_kind: v.intentKind,
    intent_status: m.userIntent?.status ?? null,
    processing_status: m.status,
    error: m.error?.slice(0, 500) ?? null,
    content_hash: m.contentHash,
    search_text: searchTextOf(m),
  };
}

export function rowToMemory(row: Row): Memory {
  const meta = (row.structured_metadata ?? {}) as Row;
  const fileName = typeof row.storage_path === "string" ? row.storage_path.split("/").pop() : undefined;
  const orUndef = <T>(v: T | null | undefined) => (v === null || v === undefined ? undefined : v);
  const r = Memory.safeParse({
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    source: {
      kind: row.source_kind,
      text: orUndef(row.original_text),
      url: orUndef(row.source_url),
      fileName,
      mimeType: orUndef(row.mime_type),
      originalName: orUndef(row.original_name),
    },
    status: row.processing_status,
    error: orUndef(row.error),
    contentHash: row.content_hash,
    extraction: meta.extraction ?? null,
    overrides: meta.overrides ?? {},
    userIntent: orUndef(meta.userIntent),
    isSample: false,
  });
  if (!r.success) throw new StoreError("A saved memory could not be read (unexpected format).");
  return r.data;
}

function approvalStatus(a: Action): "not_required" | "pending" | "approved" | "rejected" {
  const seen = (s: string) => a.history.some((h) => h.state === s);
  if (seen("approved")) return "approved";
  if (a.state === "awaiting_approval") return "pending";
  if (a.state === "cancelled" && seen("awaiting_approval")) return "rejected";
  return "not_required";
}

export function actionToRow(a: Action, userId: string): Row {
  return {
    id: a.id,
    user_id: userId,
    memory_id: a.memoryId,
    title: a.title,
    description: a.detail,
    action_type: a.kind,
    status: a.state,
    related_memory_ids: [a.memoryId],
    proposed_plan: a.scheduledFor ? { scheduledFor: a.scheduledFor } : {},
    approval_status: approvalStatus(a),
    result: a.history.at(-1)?.note?.slice(0, 500) ?? null,
    verification_evidence: a.evidence ?? null,
    history: a.history,
  };
}

export function rowToAction(row: Row): Action {
  const plan = (row.proposed_plan ?? {}) as Row;
  const r = Action.safeParse({
    id: row.id,
    memoryId: row.memory_id,
    title: row.title,
    detail: row.description ?? "",
    kind: row.action_type,
    state: row.status,
    history: row.history ?? [],
    evidence: row.verification_evidence ?? undefined,
    scheduledFor: typeof plan.scheduledFor === "string" ? plan.scheduledFor : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
  if (!r.success) throw new StoreError("A saved action could not be read (unexpected format).");
  return r.data;
}

export function planToRow(p: Plan, userId: string): Row {
  return { id: p.id, user_id: userId, memory_id: p.memoryId, action_id: p.actionId, workflow: p.workflow, status: p.status, doc: p };
}

export function rowToPlan(row: Row): Plan {
  // the document is the source of truth; columns are copies for querying
  const r = Plan.safeParse({ ...(row.doc as Row), id: row.id, memoryId: row.memory_id, actionId: row.action_id, status: row.status });
  if (!r.success) throw new StoreError("A saved plan could not be read (unexpected format).");
  return r.data;
}

export function artifactToRow(a: Artifact, userId: string): Row {
  return { id: a.id, user_id: userId, memory_id: a.memoryId, parent_id: a.parentId, kind: a.kind, status: a.status, provider: a.provider, model: a.model, doc: a };
}

export function rowToArtifact(row: Row): Artifact {
  const r = Artifact.safeParse({ ...(row.doc as Row), id: row.id, memoryId: row.memory_id, parentId: row.parent_id, status: row.status });
  if (!r.success) throw new StoreError("A saved artifact could not be read (unexpected format).");
  return r.data;
}

export function reminderToRow(r: Reminder, userId: string): Row {
  return {
    id: r.id,
    user_id: userId,
    memory_id: r.memoryId,
    action_id: r.actionId,
    title: r.title,
    note: r.note,
    due_at: r.dueAt,
    kind: r.kind,
    timezone: r.timezone,
    snooze_count: r.snoozeCount,
    status: r.status,
    history: r.history,
  };
}

export function rowToReminder(row: Row): Reminder {
  const r = Reminder.safeParse({
    id: row.id,
    memoryId: row.memory_id,
    actionId: row.action_id ?? null,
    title: row.title,
    note: row.note ?? "",
    dueAt: new Date(row.due_at as string).toISOString(),
    kind: row.kind ?? "manual",
    timezone: row.timezone ?? null,
    snoozeCount: row.snooze_count ?? 0,
    status: row.status,
    history: row.history ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
  if (!r.success) throw new StoreError("A saved reminder could not be read (unexpected format).");
  return r.data;
}

export function cvToRow(d: CvDocument, userId: string): Row {
  return {
    id: d.id,
    user_id: userId,
    source: d.source,
    file_name: d.fileName,
    original_name: d.originalName,
    file_kind: d.fileKind,
    mime_type: d.mimeType,
    byte_size: d.byteSize,
    text_content: d.text,
    text_sha256: d.textSha256,
    parsed: d.parsed,
    parser_version: d.parserVersion,
    readable: d.readable,
    is_current: d.isCurrent,
    created_at: d.createdAt,
    replaced_at: d.replacedAt,
  };
}

export function rowToCv(row: Row): CvDocument {
  const r = CvDocument.safeParse({
    id: row.id,
    source: row.source,
    fileName: row.file_name ?? null,
    originalName: row.original_name ?? null,
    fileKind: row.file_kind ?? null,
    mimeType: row.mime_type ?? null,
    byteSize: row.byte_size ?? null,
    text: row.text_content,
    textSha256: row.text_sha256,
    parsed: row.parsed,
    parserVersion: row.parser_version,
    readable: row.readable,
    isCurrent: row.is_current,
    createdAt: new Date(row.created_at as string).toISOString(),
    replacedAt: row.replaced_at ? new Date(row.replaced_at as string).toISOString() : null,
  });
  if (!r.success) throw new StoreError("A saved CV could not be read (unexpected format).");
  return r.data;
}

const hhmm = (t: unknown) => (typeof t === "string" ? t.slice(0, 5) : null);

export function prefsToRow(p: NotificationPrefs, userId: string): Row {
  return {
    user_id: userId,
    enabled: p.enabled,
    in_app: p.inApp,
    email: p.email,
    timezone: p.timezone,
    quiet_start: p.quietStart,
    quiet_end: p.quietEnd,
    max_per_day: p.maxPerDay,
    briefing_enabled: p.briefingEnabled,
    briefing_hour: p.briefingHour,
    snoozed_suggestions: p.snoozedSuggestions,
  };
}

export function rowToPrefs(row: Row | null): NotificationPrefs {
  if (!row) return DEFAULT_PREFS;
  const r = NotificationPrefs.safeParse({
    enabled: row.enabled,
    inApp: row.in_app,
    email: row.email,
    timezone: row.timezone,
    quietStart: hhmm(row.quiet_start),
    quietEnd: hhmm(row.quiet_end),
    maxPerDay: row.max_per_day,
    briefingEnabled: row.briefing_enabled,
    briefingHour: row.briefing_hour,
    snoozedSuggestions: row.snoozed_suggestions ?? {},
  });
  if (!r.success) throw new StoreError("Saved notification settings could not be read (unexpected format).");
  return r.data;
}

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);

export function rowToDelivery(row: Row): Delivery {
  const r = Delivery.safeParse({
    id: row.id,
    reminderId: row.reminder_id ?? null,
    kind: row.kind,
    channel: row.channel,
    status: row.status,
    reason: row.reason ?? null,
    attempts: row.attempts,
    lastError: row.last_error ?? null,
    scheduledFor: iso(row.scheduled_for),
    sentAt: iso(row.sent_at),
    readAt: iso(row.read_at),
    lockedUntil: iso(row.locked_until),
    dueAt: iso(row.due_at),
    dedupeKey: row.dedupe_key,
    payload: row.payload,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
  if (!r.success) throw new StoreError("A saved notification could not be read (unexpected format).");
  return r.data;
}

export function deliveryToRow(d: Delivery, userId: string): Row {
  return {
    id: d.id,
    user_id: userId,
    reminder_id: d.reminderId,
    kind: d.kind,
    channel: d.channel,
    status: d.status,
    reason: d.reason,
    attempts: d.attempts,
    last_error: d.lastError,
    scheduled_for: d.scheduledFor,
    sent_at: d.sentAt,
    read_at: d.readAt,
    locked_until: d.lockedUntil,
    due_at: d.dueAt,
    dedupe_key: d.dedupeKey,
    payload: d.payload,
  };
}

// ───────────────────────── store ─────────────────────────

/** Turn a PostgREST failure into a StoreError with a safe message; details go to the server log only. */
function check<T>(res: { data: T; error: { message: string; code?: string } | null }, what: string): T {
  if (res.error) {
    console.error(`[store] ${what} failed: ${res.error.code ?? ""} ${res.error.message.slice(0, 300)}`);
    throw new StoreError("The database request failed. Please try again.");
  }
  return res.data;
}

const omit = (row: Row, keys: string[]): Row => Object.fromEntries(Object.entries(row).filter(([k]) => !keys.includes(k)));

const topicNames = (m: Memory) =>
  [...new Set((m.extraction?.topics ?? []).map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0 && t.length <= 60))].slice(0, 12);

/**
 * Store bound to ONE signed-in user's client. Every query runs as that user, so RLS is the real access control;
 * the `user_id` filters here are for clarity and index use, not security.
 */
export function supabaseStore(c: SupabaseClient, userId: string): Store {
  async function rawMemory(id: string): Promise<Row | null> {
    if (!isUuid(id)) return null; // a malformed id is "not found", not a database type error
    return check(await c.from("memories").select("*").eq("id", id).maybeSingle(), "get memory") as Row | null;
  }
  async function rawAction(id: string): Promise<Row | null> {
    if (!isUuid(id)) return null;
    return check(await c.from("actions").select("*").eq("id", id).maybeSingle(), "get action") as Row | null;
  }

  /** Derived data: a failed tag sync never fails the memory update. */
  async function syncTags(m: Memory) {
    try {
      const names = topicNames(m);
      const del = await c.from("memory_tags").delete().eq("memory_id", m.id);
      if (del.error) throw del.error;
      if (!names.length) return;
      const tags = await c.from("tags").upsert(names.map((name) => ({ user_id: userId, name })), { onConflict: "user_id,name" }).select("id");
      if (tags.error) throw tags.error;
      const links = await c.from("memory_tags").insert((tags.data ?? []).map((t) => ({ memory_id: m.id, tag_id: t.id, user_id: userId })));
      if (links.error) throw links.error;
    } catch (e) {
      console.error(`[store] tag sync failed for memory ${m.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const store: Store = {
    async listMemories() {
      const rows = check(await c.from("memories").select("*").order("created_at", { ascending: false }), "list memories");
      return (rows as Row[]).map(rowToMemory);
    },

    async fullText(query, limit = 50) {
      const q = query.trim();
      if (!q) return new Map();
      const rows = check(await c.rpc("search_memories_fts", { p_query: q.slice(0, 500), p_limit: limit }), "full-text search") as { id: string; rank: number }[];
      return new Map(rows.map((r) => [r.id, r.rank]));
    },

    async embeddingHashes(model) {
      const rows = check(
        await c.from("memory_embeddings").select("memory_id, source_hash").eq("model", model).limit(5000),
        "list embeddings",
      ) as { memory_id: string; source_hash: string }[];
      return new Map(rows.map((r) => [r.memory_id, r.source_hash]));
    },

    async saveEmbedding(memoryId, { provider, model, vector, sourceHash }) {
      if (!validVector(vector)) throw new StoreError("The embedding is empty or invalid.");
      if (!isUuid(memoryId)) return false;
      const memory = await rawMemory(memoryId);
      if (!memory) return false; // not found, or someone else's (RLS hides it)
      check(
        await c.from("memory_embeddings").upsert(
          { memory_id: memoryId, user_id: userId, provider, model, dims: vector.length, embedding_vec: toVectorText(vector), source_hash: sourceHash },
          { onConflict: "memory_id,model" },
        ),
        "save embedding",
      );
      return true;
    },

    async similarMemories(model, query, { limit, minSimilarity }) {
      if (!validVector(query)) throw new StoreError("The query embedding is empty or invalid.");
      const rows = check(
        await c.rpc("match_memories", { p_model: model, p_query: toVectorText(query), p_limit: limit, p_min_similarity: minSimilarity ?? null }),
        "similarity search",
      ) as { memory_id: string; similarity: number }[];
      return new Map(rows.map((r) => [r.memory_id, r.similarity]));
    },

    async getMemory(id) {
      const row = await rawMemory(id);
      return row ? rowToMemory(row) : null;
    },

    async insertMemory(m) {
      const rows = check(
        await c.from("memories").upsert(memoryToRow(m, userId), { onConflict: "user_id,content_hash", ignoreDuplicates: true }).select(),
        "insert memory",
      ) as Row[];
      if (rows.length) return { memory: rowToMemory(rows[0]), created: true };
      const existing = check(
        await c.from("memories").select("*").eq("content_hash", m.contentHash).maybeSingle(),
        "find duplicate memory",
      ) as Row | null;
      if (!existing) throw new StoreError("The database request failed. Please try again.");
      return { memory: rowToMemory(existing), created: false };
    },

    async updateMemory(id, patch) {
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        const cur = await rawMemory(id);
        if (!cur) return null;
        const next = patch(rowToMemory(cur));
        const changes = omit(memoryToRow(next, userId), ["id", "user_id", "content_hash"]);
        // compare-and-swap on rev: if someone else wrote in between, no row matches and we re-read and retry
        const rows = check(await c.from("memories").update(changes).eq("id", id).eq("rev", cur.rev as number).select(), "update memory") as Row[];
        if (rows.length) {
          const saved = rowToMemory(rows[0]);
          if (saved.extraction) await syncTags(saved);
          return saved;
        }
      }
      throw new StoreError("This memory is being changed by someone else. Please try again.");
    },

    async deleteMemory(id) {
      if (!isUuid(id)) return null;
      const rows = check(await c.from("memories").delete().eq("id", id).select(), "delete memory") as Row[];
      return rows.length ? rowToMemory(rows[0]) : null; // actions and tag links go with it (ON DELETE CASCADE)
    },

    async listActions(memoryId) {
      if (memoryId !== undefined && !isUuid(memoryId)) return [];
      let q = c.from("actions").select("*");
      if (memoryId) q = q.eq("memory_id", memoryId);
      return (check(await q.order("updated_at", { ascending: false }), "list actions") as Row[]).map(rowToAction);
    },

    async getAction(id) {
      const row = await rawAction(id);
      return row ? rowToAction(row) : null;
    },

    async claimProcessing(id, opts) {
      if (!isUuid(id)) return { memory: null, claimed: false };
      // the claim is one UPDATE inside Postgres (see claim_memory_processing), so two callers can't both win
      const rows = check(
        await c.rpc("claim_memory_processing", { p_id: id, p_force: !!opts.force, p_lease_seconds: PROCESSING_LEASE_MS / 1000 }),
        "claim processing",
      ) as Row[];
      if (rows.length) return { memory: rowToMemory(rows[0]), claimed: true };
      return { memory: await store.getMemory(id), claimed: false };
    },

    async mutateAction(id, fn) {
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        const cur = await rawAction(id);
        if (!cur) return null;
        const next = fn(rowToAction(cur));
        const changes = omit(actionToRow(next, userId), ["id", "user_id", "memory_id"]);
        const rows = check(await c.from("actions").update(changes).eq("id", id).eq("rev", cur.rev as number).select(), "update action") as Row[];
        if (rows.length) return rowToAction(rows[0]);
      }
      throw new StoreError("This action is being changed by someone else. Please try again.");
    },

    async upsertAction(a) {
      const rows = check(await c.from("actions").upsert(actionToRow(a, userId), { onConflict: "id" }).select(), "save action") as Row[];
      return rowToAction(rows[0]);
    },

    async listPlans(memoryId) {
      if (memoryId !== undefined && !isUuid(memoryId)) return [];
      let q = c.from("plans").select("*").order("created_at", { ascending: false });
      if (memoryId) q = q.eq("memory_id", memoryId);
      return (check(await q, "list plans") as Row[]).map(rowToPlan);
    },
    async getPlan(id) {
      if (!isUuid(id)) return null;
      const row = check(await c.from("plans").select("*").eq("id", id).maybeSingle(), "get plan") as Row | null;
      return row ? rowToPlan(row) : null;
    },
    async upsertPlan(p) {
      const rows = check(await c.from("plans").upsert(planToRow(p, userId), { onConflict: "id" }).select(), "save plan") as Row[];
      return rowToPlan(rows[0]);
    },
    async mutatePlan(id, fn) {
      if (!isUuid(id)) return null;
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        const cur = check(await c.from("plans").select("*").eq("id", id).maybeSingle(), "get plan") as Row | null;
        if (!cur) return null;
        const next = fn(rowToPlan(cur));
        const changes = omit(planToRow(next, userId), ["id", "user_id", "memory_id", "action_id"]);
        const rows = check(await c.from("plans").update(changes).eq("id", id).eq("rev", cur.rev as number).select(), "update plan") as Row[];
        if (rows.length) return rowToPlan(rows[0]);
      }
      throw new StoreError("This plan is being changed by someone else. Please try again.");
    },

    async listArtifacts(opts = {}) {
      if ((opts.memoryId !== undefined && !isUuid(opts.memoryId)) || (opts.parentId !== undefined && !isUuid(opts.parentId))) return [];
      let q = c.from("artifacts").select("*").order("created_at", { ascending: false });
      if (opts.memoryId) q = q.eq("memory_id", opts.memoryId);
      if (opts.parentId) q = q.eq("parent_id", opts.parentId);
      if (opts.kind) q = q.eq("kind", opts.kind);
      return (check(await q, "list artifacts") as Row[]).map(rowToArtifact);
    },
    async getArtifact(id) {
      if (!isUuid(id)) return null;
      const row = check(await c.from("artifacts").select("*").eq("id", id).maybeSingle(), "get artifact") as Row | null;
      return row ? rowToArtifact(row) : null;
    },
    async upsertArtifact(a) {
      const rows = check(await c.from("artifacts").upsert(artifactToRow(a, userId), { onConflict: "id" }).select(), "save artifact") as Row[];
      return rowToArtifact(rows[0]);
    },
    async mutateArtifact(id, fn) {
      if (!isUuid(id)) return null;
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        const cur = check(await c.from("artifacts").select("*").eq("id", id).maybeSingle(), "get artifact") as Row | null;
        if (!cur) return null;
        const next = fn(rowToArtifact(cur));
        const changes = omit(artifactToRow(next, userId), ["id", "user_id", "memory_id", "parent_id"]);
        const rows = check(await c.from("artifacts").update(changes).eq("id", id).eq("rev", cur.rev as number).select(), "update artifact") as Row[];
        if (rows.length) return rowToArtifact(rows[0]);
      }
      throw new StoreError("This item is being changed by someone else. Please try again.");
    },
    async deleteArtifact(id) {
      if (!isUuid(id)) return null;
      const row = check(await c.from("artifacts").delete().eq("id", id).select(), "delete artifact") as Row[];
      return row[0] ? rowToArtifact(row[0]) : null;
    },

    async listReminders(opts = {}) {
      if (opts.memoryId !== undefined && !isUuid(opts.memoryId)) return [];
      let q = c.from("reminders").select("*").order("due_at", { ascending: true });
      if (opts.memoryId) q = q.eq("memory_id", opts.memoryId);
      if (opts.status) q = q.in("status", opts.status);
      return (check(await q, "list reminders") as Row[]).map(rowToReminder);
    },
    async getReminder(id) {
      if (!isUuid(id)) return null;
      const row = check(await c.from("reminders").select("*").eq("id", id).maybeSingle(), "get reminder") as Row | null;
      return row ? rowToReminder(row) : null;
    },
    async upsertReminder(r) {
      const rows = check(await c.from("reminders").upsert(reminderToRow(r, userId), { onConflict: "id" }).select(), "save reminder") as Row[];
      return rowToReminder(rows[0]);
    },
    async mutateReminder(id, fn) {
      if (!isUuid(id)) return null;
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        const cur = check(await c.from("reminders").select("*").eq("id", id).maybeSingle(), "get reminder") as Row | null;
        if (!cur) return null;
        const next = fn(rowToReminder(cur));
        const changes = omit(reminderToRow(next, userId), ["id", "user_id", "memory_id", "action_id"]);
        const rows = check(await c.from("reminders").update(changes).eq("id", id).eq("rev", cur.rev as number).select(), "update reminder") as Row[];
        if (rows.length) return rowToReminder(rows[0]);
      }
      throw new StoreError("This reminder is being changed by someone else. Please try again.");
    },

    async getPrefs() {
      const row = check(await c.from("notification_preferences").select("*").eq("user_id", userId).maybeSingle(), "get preferences") as Row | null;
      return rowToPrefs(row);
    },
    async setPrefs(patch) {
      const row = check(await c.from("notification_preferences").select("*").eq("user_id", userId).maybeSingle(), "get preferences") as Row | null;
      const next = NotificationPrefs.parse({ ...rowToPrefs(row), ...patch });
      check(await c.from("notification_preferences").upsert(prefsToRow(next, userId), { onConflict: "user_id" }), "save preferences");
      return next;
    },
    async listDeliveries(opts = {}) {
      if (opts.reminderId !== undefined && !isUuid(opts.reminderId)) return [];
      let q = c.from("notification_deliveries").select("*").order("created_at", { ascending: false }).limit(opts.limit ?? 100);
      if (opts.reminderId) q = q.eq("reminder_id", opts.reminderId);
      if (opts.kind) q = q.eq("kind", opts.kind);
      if (opts.unreadOnly) q = q.eq("channel", "in_app").eq("status", "sent").is("read_at", null);
      return (check(await q, "list notifications") as Row[]).map(rowToDelivery);
    },
    async markDeliveriesRead(ids, now) {
      let q = c.from("notification_deliveries").update({ read_at: now.toISOString() }).eq("channel", "in_app").eq("status", "sent").is("read_at", null);
      if (ids !== "all") {
        const good = ids.filter(isUuid);
        if (!good.length) return 0;
        q = q.in("id", good);
      }
      return (check(await q.select("id"), "mark read") as Row[]).length;
    },
    async cancelDeliveries(reminderId, reason) {
      if (!isUuid(reminderId)) return 0;
      const rows = check(await c.from("notification_deliveries").update({ status: "skipped", reason }).eq("reminder_id", reminderId).eq("status", "pending").select("id"), "cancel notifications") as Row[];
      return rows.length;
    },

    async getCvDocument() {
      const row = check(await c.from("cv_documents").select("*").eq("is_current", true).maybeSingle(), "get cv") as Row | null;
      return row ? rowToCv(row) : null;
    },
    async listCvDocuments() {
      return (check(await c.from("cv_documents").select("*").order("created_at", { ascending: false }), "list cvs") as Row[]).map(rowToCv);
    },
    async saveCvDocument(doc) {
      // the unique "one current CV" index means the old one must stop being current before the new one is inserted
      const prev = check(await c.from("cv_documents").select("id").eq("is_current", true).maybeSingle(), "find current cv") as { id: string } | null;
      if (prev) check(await c.from("cv_documents").update({ is_current: false, replaced_at: doc.createdAt }).eq("id", prev.id), "retire cv");
      try {
        const rows = check(await c.from("cv_documents").insert(cvToRow({ ...doc, isCurrent: true, replacedAt: null }, userId)).select(), "save cv") as Row[];
        return rowToCv(rows[0]);
      } catch (e) {
        if (prev) await c.from("cv_documents").update({ is_current: true, replaced_at: null }).eq("id", prev.id); // put the old one back
        throw e;
      }
    },
    async updateCvDocument(id, fn) {
      if (!isUuid(id)) return null;
      const cur = check(await c.from("cv_documents").select("*").eq("id", id).maybeSingle(), "get cv") as Row | null;
      if (!cur) return null;
      const next = fn(rowToCv(cur));
      const changes = omit(cvToRow(next, userId), ["id", "user_id"]);
      const rows = check(await c.from("cv_documents").update(changes).eq("id", id).select(), "update cv") as Row[];
      return rows.length ? rowToCv(rows[0]) : null;
    },
    async deleteCvDocuments() {
      const rows = check(await c.from("cv_documents").select("id, file_name"), "list cvs") as { id: string; file_name: string | null }[];
      for (const r of rows) check(await c.from("cv_documents").delete().eq("id", r.id), "delete cv");
      return { versions: rows.length, files: rows.map((r) => r.file_name).filter((n): n is string => Boolean(n)) };
    },
  };

  return store;
}

// ───────────────────────── files ─────────────────────────

export function supabaseFiles(c: SupabaseClient, userId: string): FileStore {
  const pathOf = (fileName: string) => `${userId}/${fileName}`;
  return {
    async put(fileName, bytes, mimeType) {
      const { error } = await c.storage.from(BUCKET).upload(pathOf(fileName), bytes, { contentType: mimeType, upsert: false });
      if (error) {
        console.error(`[files] upload failed: ${error.message.slice(0, 300)}`);
        throw new StoreError("Couldn't store the image. Please try again.");
      }
    },
    async get(fileName) {
      const { data, error } = await c.storage.from(BUCKET).download(pathOf(fileName));
      if (error || !data) return null;
      return { bytes: new Uint8Array(await data.arrayBuffer()), mimeType: data.type };
    },
    async remove(fileName) {
      const { error } = await c.storage.from(BUCKET).remove([pathOf(fileName)]);
      if (error) console.error(`[files] remove failed: ${error.message.slice(0, 300)}`); // best effort: the row is already gone
    },
    async signedUrl(fileName, expiresInSeconds) {
      const { data, error } = await c.storage.from(BUCKET).createSignedUrl(pathOf(fileName), expiresInSeconds);
      return error || !data ? null : data.signedUrl;
    },
  };
}

export function supabaseBackend(c: SupabaseClient, userId: string): Backend {
  return { kind: "supabase", store: supabaseStore(c, userId), files: supabaseFiles(c, userId) };
}
