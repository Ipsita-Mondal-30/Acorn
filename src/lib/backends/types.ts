import type { Plan, Reminder, ReminderStatus } from "../agent/schema";
import type { Artifact, ArtifactKind } from "../artifacts";
import type { CvDocument } from "../cv/types";
import type { Delivery, NotificationPrefs } from "../notify/types";
import type { Action, Memory } from "../schema";

/** A "processing" memory older than this is a crashed run, not a live one, and may be claimed again. */
export const PROCESSING_LEASE_MS = 2 * 60_000;

/** Raised when a private cloud operation is attempted without a signed-in user. Maps to HTTP 401. */
export class AuthError extends Error {
  name = "AuthError";
  constructor(message = "Please sign in to continue.") {
    super(message);
  }
}

/** The database/storage failed. The message is safe to show; details are logged server-side. */
export class StoreError extends Error {
  name = "StoreError";
}

/** Everything the app persists about memories and actions. One implementation per backend. */
export interface Store {
  listMemories(): Promise<Memory[]>;
  getMemory(id: string): Promise<Memory | null>;
  /** Idempotent: the same contentHash returns the existing memory instead of a duplicate. */
  insertMemory(m: Memory): Promise<{ memory: Memory; created: boolean }>;
  updateMemory(id: string, patch: (m: Memory) => Memory): Promise<Memory | null>;
  /** Removes the memory and its actions; returns what was removed (so its file can be cleaned up), or null. */
  deleteMemory(id: string): Promise<Memory | null>;
  listActions(memoryId?: string): Promise<Action[]>;
  getAction(id: string): Promise<Action | null>;
  /**
   * Database full-text search over what memories say: memory id -> rank (higher is better). Empty for the local demo
   * store, which has no search index. It only supplies candidates and rank; search.ts still explains every match.
   */
  fullText(query: string, limit?: number): Promise<Map<string, number>>;
  /** Which memories already have a vector for this model, and the hash of the text it was made from (to find stale ones). */
  embeddingHashes(model: string): Promise<Map<string, string>>;
  /**
   * Insert or replace one memory's embedding for a model. False when the memory doesn't exist (or isn't yours).
   * Throws StoreError for an empty, non-finite or all-zero vector.
   */
  saveEmbedding(memoryId: string, e: { provider: string; model: string; vector: number[]; sourceHash: string }): Promise<boolean>;
  /**
   * The signed-in user's memories closest to `query` by cosine similarity (1 = same direction), best first. Supabase runs
   * this in Postgres (pgvector, RLS-scoped); the local store computes it in memory. Throws StoreError when the query's
   * size differs from the stored vectors' size for this model.
   */
  similarMemories(model: string, query: number[], opts: { limit: number; minSimilarity?: number }): Promise<Map<string, number>>;
  /** Atomically move a memory to "processing" and report whether the caller now owns the run. */
  claimProcessing(id: string, opts: { force?: boolean }, now?: Date): Promise<{ memory: Memory | null; claimed: boolean }>;
  /** Serialised read-modify-write on one action. */
  mutateAction(id: string, fn: (a: Action) => Action): Promise<Action | null>;
  upsertAction(a: Action): Promise<Action>;

  /** Execution plans (Phase 4). One per memory workflow; the executor is the only writer. */
  listPlans(memoryId?: string): Promise<Plan[]>;
  getPlan(id: string): Promise<Plan | null>;
  upsertPlan(p: Plan): Promise<Plan>;
  /** Serialised read-modify-write on one plan (no lost updates between two requests). */
  mutatePlan(id: string, fn: (p: Plan) => Plan): Promise<Plan | null>;

  listReminders(opts?: { memoryId?: string; status?: ReminderStatus[] }): Promise<Reminder[]>;
  getReminder(id: string): Promise<Reminder | null>;
  upsertReminder(r: Reminder): Promise<Reminder>;
  mutateReminder(id: string, fn: (r: Reminder) => Reminder): Promise<Reminder | null>;

  /** What Meta's voice, image and segmentation models made from memories (see artifacts.ts). */
  listArtifacts(opts?: { memoryId?: string; kind?: ArtifactKind; parentId?: string }): Promise<Artifact[]>;
  getArtifact(id: string): Promise<Artifact | null>;
  upsertArtifact(a: Artifact): Promise<Artifact>;
  /** Serialised read-modify-write on one artifact. */
  mutateArtifact(id: string, fn: (a: Artifact) => Artifact): Promise<Artifact | null>;
  /** Removes it and returns what was removed (so its stored file can be cleaned up), or null. */
  deleteArtifact(id: string): Promise<Artifact | null>;

  /** The signed-in user's notification settings (defaults until they change something). */
  getPrefs(): Promise<NotificationPrefs>;
  setPrefs(patch: Partial<NotificationPrefs>): Promise<NotificationPrefs>;
  /** Delivery history / inbox, newest first. */
  listDeliveries(opts?: { reminderId?: string; kind?: "reminder" | "briefing"; unreadOnly?: boolean; limit?: number }): Promise<Delivery[]>;
  /** Mark in-app notifications read. Returns how many changed. */
  markDeliveriesRead(ids: string[] | "all", now: Date): Promise<number>;
  /** Cancel what hasn't been sent yet for a reminder (it was done, dismissed, snoozed or rescheduled). */
  cancelDeliveries(reminderId: string, reason: string): Promise<number>;

  /** The current CV, or null. Each user has at most one current CV; older versions are kept. */
  getCvDocument(): Promise<CvDocument | null>;
  listCvDocuments(): Promise<CvDocument[]>;
  /** Make `doc` the current CV; the previous current one is kept as history. */
  saveCvDocument(doc: CvDocument): Promise<CvDocument>;
  updateCvDocument(id: string, fn: (d: CvDocument) => CvDocument): Promise<CvDocument | null>;
  /** Delete every CV version; returns how many there were and the stored file names so the caller can remove the files. */
  deleteCvDocuments(): Promise<{ versions: number; files: string[] }>;
}

/** Where uploaded image bytes live. `fileName` is always the random `<uuid>.<ext>` the app generated. */
export interface FileStore {
  put(fileName: string, bytes: Uint8Array, mimeType: string): Promise<void>;
  get(fileName: string): Promise<{ bytes: Uint8Array; mimeType: string } | null>;
  remove(fileName: string): Promise<void>;
  /** Cloud only: a short-lived URL for an authorised viewer. Local files are served by the app instead. */
  signedUrl?(fileName: string, expiresInSeconds: number): Promise<string | null>;
}

export type Backend = { kind: "local" | "supabase"; store: Store; files: FileStore };
