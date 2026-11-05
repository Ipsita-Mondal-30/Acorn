import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { localBackend } from "./backends/local";
import { supabaseBackend } from "./backends/supabase";
import type { Backend, Store } from "./backends/types";
import type { NotificationPrefs } from "./notify/types";
import { storageMode } from "./env";
import type { Plan, Reminder, ReminderStatus } from "./agent/schema";
import type { Artifact } from "./artifacts";
import { buildCvDocument } from "./cv/build";
import type { CvDocument } from "./cv/types";
import type { Action, Memory } from "./schema";
import { createServerSupabase } from "./supabase/server";
import { requireUser } from "./supabase/user";

// Service boundary for persistence. Routes, pages and process.ts call these functions; which backend answers
// (local JSON demo store, or Supabase acting as the signed-in user) is decided here, per request.

export { dataDir, uploadsDir } from "./backends/local";
export { AuthError, PROCESSING_LEASE_MS, StoreError } from "./backends/types";

/** The backend for the current request. In cloud mode this throws AuthError unless someone is signed in. */
export async function backend(): Promise<Backend> {
  if (storageMode() === "local") return localBackend;
  const user = await requireUser();
  return supabaseBackend(await createServerSupabase(), user.id);
}

export const newId = () => randomUUID();
export const hashContent = (...parts: (string | undefined)[]) =>
  createHash("sha256").update(parts.map((p) => p ?? "").join("\u0000")).digest("hex");

export const listMemories = async () => (await backend()).store.listMemories();
export const fullTextIds = async (query: string, limit?: number) => (await backend()).store.fullText(query, limit);
export const embeddingHashes = async (model: string) => (await backend()).store.embeddingHashes(model);
export const saveEmbedding = async (memoryId: string, e: { provider: string; model: string; vector: number[]; sourceHash: string }) =>
  (await backend()).store.saveEmbedding(memoryId, e);
export const similarMemories = async (model: string, query: number[], opts: { limit: number; minSimilarity?: number }) =>
  (await backend()).store.similarMemories(model, query, opts);
export const getMemory = async (id: string) => (await backend()).store.getMemory(id);
/** Idempotent: same contentHash returns the existing memory instead of a duplicate. */
export const insertMemory = async (m: Memory) => (await backend()).store.insertMemory(m);
export const updateMemory = async (id: string, patch: (m: Memory) => Memory) => (await backend()).store.updateMemory(id, patch);
export const deleteMemory = async (id: string) => (await backend()).store.deleteMemory(id);
export const listActions = async (memoryId?: string) => (await backend()).store.listActions(memoryId);
export const getAction = async (id: string) => (await backend()).store.getAction(id);
/** Atomically move a memory to "processing"; a live run (inside PROCESSING_LEASE_MS) is never taken over. */
export const claimProcessing = async (id: string, opts: { force?: boolean }, now = new Date()) =>
  (await backend()).store.claimProcessing(id, opts, now);
/** Serialised read-modify-write on one action, so concurrent requests can't overwrite each other. */
export const mutateAction = async (id: string, fn: (a: Action) => Action) => (await backend()).store.mutateAction(id, fn);
export const upsertAction = async (a: Action) => (await backend()).store.upsertAction(a);
export const listPlans = async (memoryId?: string) => (await backend()).store.listPlans(memoryId);
export const getPlan = async (id: string) => (await backend()).store.getPlan(id);
export const upsertPlan = async (p: Plan) => (await backend()).store.upsertPlan(p);
export const mutatePlan = async (id: string, fn: (p: Plan) => Plan) => (await backend()).store.mutatePlan(id, fn);
export const listReminders = async (opts?: { memoryId?: string; status?: ReminderStatus[] }) => (await backend()).store.listReminders(opts);
export const getReminder = async (id: string) => (await backend()).store.getReminder(id);
export const upsertReminder = async (r: Reminder) => (await backend()).store.upsertReminder(r);
export const mutateReminder = async (id: string, fn: (r: Reminder) => Reminder) => (await backend()).store.mutateReminder(id, fn);
export const listArtifacts = async (opts?: Parameters<Store["listArtifacts"]>[0]) => (await backend()).store.listArtifacts(opts);
export const getArtifact = async (id: string) => (await backend()).store.getArtifact(id);
export const upsertArtifact = async (a: Artifact) => (await backend()).store.upsertArtifact(a);
export const mutateArtifact = async (id: string, fn: (a: Artifact) => Artifact) => (await backend()).store.mutateArtifact(id, fn);
export const deleteArtifact = async (id: string) => (await backend()).store.deleteArtifact(id);
export const getPrefs = async () => (await backend()).store.getPrefs();
export const setPrefs = async (patch: Partial<NotificationPrefs>) => (await backend()).store.setPrefs(patch);
export const listDeliveries = async (opts?: Parameters<Store["listDeliveries"]>[0]) => (await backend()).store.listDeliveries(opts);
export const markDeliveriesRead = async (ids: string[] | "all", now = new Date()) => (await backend()).store.markDeliveriesRead(ids, now);
export const cancelDeliveries = async (reminderId: string, reason: string) => (await backend()).store.cancelDeliveries(reminderId, reason);
export const getCvDocument = async () => (await backend()).store.getCvDocument();
export const listCvDocuments = async () => (await backend()).store.listCvDocuments();
export const saveCvDocument = async (d: CvDocument) => (await backend()).store.saveCvDocument(d);
export const updateCvDocument = async (id: string, fn: (d: CvDocument) => CvDocument) => (await backend()).store.updateCvDocument(id, fn);
export const deleteCvDocuments = async () => (await backend()).store.deleteCvDocuments();

/** The current CV as plain text plus its structured parse, or null. */
export async function getCv() {
  const d = await getCvDocument();
  return d ? { id: d.id, text: d.text, parsed: d.parsed, updatedAt: d.createdAt } : null;
}
/** Paste (or clear, with null) the CV. Uploads go through cv/service.ts. */
export async function setCv(text: string | null) {
  if (text === null) {
    await deleteCvDocuments();
    return null;
  }
  await saveCvDocument(buildCvDocument({ source: "paste", text }));
  return getCv();
}

export type { Backend };
