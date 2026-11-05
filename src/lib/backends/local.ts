import "server-only";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { Plan, Reminder } from "../agent/schema";
import { Artifact } from "../artifacts";
import { CvDocument } from "../cv/types";
import { DEFAULT_PREFS, Delivery, NotificationPrefs } from "../notify/types";
import type { WorkerStore } from "../notify/worker";
import { Db as BaseDb, type Action, type Memory } from "../schema";
import { buildSeed } from "../seed";
import { cosine, validVector } from "../semantic";
import { PROCESSING_LEASE_MS, StoreError, type Backend, type FileStore, type Store } from "./types";

// ponytail: single-process JSON file store with a global write queue. This is the local demo backend;
// the Supabase backend (supabase.ts) is the real one.

export function dataDir() {
  // runtime data dir, not a build input — keep it out of output file tracing
  return path.resolve(/*turbopackIgnore: true*/ process.env.ACORN_DATA_DIR ?? ".data");
}
export function uploadsDir() {
  return path.join(dataDir(), "uploads");
}
const dbPath = () => path.join(dataDir(), "acorn.json");

// the demo file also holds Phase 4 data; files written before it load with these empty
const Db = BaseDb.extend({
  plans: z.array(Plan).default([]),
  artifacts: z.array(Artifact).default([]),
  reminders: z.array(Reminder).default([]),
  cvDocuments: z.array(CvDocument).default([]),
  notificationPrefs: NotificationPrefs.nullable().default(null),
  deliveries: z.array(Delivery).default([]),
});
type Db = z.infer<typeof Db>;

let queue: Promise<unknown> = Promise.resolve();

async function load(): Promise<Db> {
  try {
    return Db.parse(JSON.parse(await readFile(dbPath(), "utf8")));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    const seeded = { ...buildSeed(new Date()), plans: [], artifacts: [], reminders: [], cvDocuments: [], notificationPrefs: null, deliveries: [] };
    await save(seeded);
    return seeded;
  }
}

async function save(db: Db) {
  await mkdir(dataDir(), { recursive: true });
  const tmp = `${dbPath()}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(db, null, 2));
  await rename(tmp, dbPath()); // atomic replace, no half-written file on crash
}

/** Serialised read-modify-write. */
function mutate<T>(fn: (db: Db) => T | Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const db = await load();
    const result = await fn(db);
    await save(Db.parse(db));
    return result;
  });
  queue = run.catch(() => {});
  return run;
}

function read<T>(fn: (db: Db) => T): Promise<T> {
  const run = queue.then(async () => fn(await load()));
  queue = run.catch(() => {});
  return run;
}

const store: Store = {
  listMemories: () => read((db) => [...db.memories].sort((a, b) => b.createdAt.localeCompare(a.createdAt))),

  fullText: async () => new Map(),

  embeddingHashes: (model) => read((db) => new Map(db.embeddings.filter((e) => e.model === model).map((e) => [e.memoryId, e.sourceHash]))),

  saveEmbedding: (memoryId, { provider, model, vector, sourceHash }) => {
    if (!validVector(vector)) throw new StoreError("The embedding is empty or invalid.");
    return mutate((db) => {
      if (!db.memories.some((m) => m.id === memoryId)) return false;
      db.embeddings = db.embeddings.filter((e) => !(e.memoryId === memoryId && e.model === model));
      db.embeddings.push({ memoryId, provider, model, vector, sourceHash });
      return true;
    });
  },

  similarMemories: (model, query, { limit, minSimilarity }) =>
    read((db) => {
      const rows = db.embeddings.filter((e) => e.model === model);
      if (rows[0] && rows[0].vector.length !== query.length) {
        throw new StoreError(`The query has ${query.length} dimensions but model ${model} stores ${rows[0].vector.length}.`);
      }
      return new Map(
        rows
          .map((e) => [e.memoryId, cosine(query, e.vector)] as const)
          .filter(([, sim]) => minSimilarity === undefined || sim >= minSimilarity)
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, limit),
      );
    }),

  getMemory: (id) => read((db) => db.memories.find((m) => m.id === id) ?? null),

  insertMemory: (m) =>
    mutate((db) => {
      const existing = db.memories.find((x) => x.contentHash === m.contentHash);
      if (existing) return { memory: existing, created: false };
      db.memories.push(m);
      return { memory: m, created: true };
    }),

  updateMemory: (id, patch) =>
    mutate((db) => {
      const i = db.memories.findIndex((m) => m.id === id);
      if (i < 0) return null;
      db.memories[i] = { ...patch(db.memories[i]), updatedAt: new Date().toISOString() };
      return db.memories[i];
    }),

  deleteMemory: (id) =>
    mutate((db) => {
      const i = db.memories.findIndex((m) => m.id === id);
      if (i < 0) return null;
      const [removed] = db.memories.splice(i, 1);
      db.actions = db.actions.filter((a) => a.memoryId !== id);
      db.embeddings = db.embeddings.filter((e) => e.memoryId !== id);
      db.plans = db.plans.filter((p) => p.memoryId !== id);
      db.artifacts = db.artifacts.filter((a) => a.memoryId !== id);
      const gone = new Set(db.reminders.filter((r) => r.memoryId === id).map((r) => r.id));
      db.reminders = db.reminders.filter((r) => r.memoryId !== id);
      db.deliveries = db.deliveries.filter((d) => !d.reminderId || !gone.has(d.reminderId));
      return removed;
    }),

  listActions: (memoryId) =>
    read((db) =>
      db.actions
        .filter((a) => !memoryId || a.memoryId === memoryId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    ),

  getAction: (id) => read((db) => db.actions.find((a) => a.id === id) ?? null),

  claimProcessing: (id, opts, now = new Date()) =>
    mutate((db) => {
      const m = db.memories.find((x) => x.id === id);
      if (!m) return { memory: null, claimed: false };
      const live = m.status === "processing" && now.getTime() - Date.parse(m.updatedAt) < PROCESSING_LEASE_MS;
      const wanted = m.status === "pending" || m.status === "failed" || m.status === "processing" || opts.force;
      if (live || !wanted) return { memory: m, claimed: false };
      m.status = "processing";
      m.error = undefined;
      m.updatedAt = now.toISOString();
      return { memory: m as Memory, claimed: true };
    }),

  mutateAction: (id, fn) =>
    mutate((db) => {
      const i = db.actions.findIndex((x) => x.id === id);
      if (i < 0) return null;
      db.actions[i] = fn(db.actions[i]);
      return db.actions[i];
    }),

  listArtifacts: (opts) =>
    read((db) =>
      db.artifacts
        .filter((a) => (!opts?.memoryId || a.memoryId === opts.memoryId) && (!opts?.kind || a.kind === opts.kind) && (!opts?.parentId || a.parentId === opts.parentId))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    ),
  getArtifact: (id) => read((db) => db.artifacts.find((a) => a.id === id) ?? null),
  upsertArtifact: (a) =>
    mutate((db) => {
      const i = db.artifacts.findIndex((x) => x.id === a.id);
      if (i < 0) db.artifacts.push(a);
      else db.artifacts[i] = a;
      return a;
    }),
  mutateArtifact: (id, fn) =>
    mutate((db) => {
      const i = db.artifacts.findIndex((x) => x.id === id);
      if (i < 0) return null;
      db.artifacts[i] = { ...fn(db.artifacts[i]), updatedAt: new Date().toISOString() };
      return db.artifacts[i];
    }),
  deleteArtifact: (id) =>
    mutate((db) => {
      const i = db.artifacts.findIndex((x) => x.id === id);
      if (i < 0) return null;
      const [removed] = db.artifacts.splice(i, 1);
      return removed;
    }),
  listPlans: (memoryId) =>
    read((db) => db.plans.filter((p) => !memoryId || p.memoryId === memoryId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))),
  getPlan: (id) => read((db) => db.plans.find((p) => p.id === id) ?? null),
  upsertPlan: (p) =>
    mutate((db) => {
      const i = db.plans.findIndex((x) => x.id === p.id);
      if (i < 0) db.plans.push(p);
      else db.plans[i] = p;
      return p;
    }),
  mutatePlan: (id, fn) =>
    mutate((db) => {
      const i = db.plans.findIndex((x) => x.id === id);
      if (i < 0) return null;
      db.plans[i] = fn(db.plans[i]);
      return db.plans[i];
    }),

  listReminders: (opts = {}) =>
    read((db) =>
      db.reminders
        .filter((r) => (!opts.memoryId || r.memoryId === opts.memoryId) && (!opts.status || opts.status.includes(r.status)))
        .sort((a, b) => a.dueAt.localeCompare(b.dueAt)),
    ),
  getReminder: (id) => read((db) => db.reminders.find((r) => r.id === id) ?? null),
  upsertReminder: (r) =>
    mutate((db) => {
      if (!db.memories.some((m) => m.id === r.memoryId)) throw new StoreError("That memory doesn't exist.");
      const i = db.reminders.findIndex((x) => x.id === r.id);
      if (i < 0) db.reminders.push(r);
      else db.reminders[i] = r;
      return r;
    }),
  mutateReminder: (id, fn) =>
    mutate((db) => {
      const i = db.reminders.findIndex((x) => x.id === id);
      if (i < 0) return null;
      db.reminders[i] = fn(db.reminders[i]);
      return db.reminders[i];
    }),

  getPrefs: () => read((db) => db.notificationPrefs ?? DEFAULT_PREFS),
  setPrefs: (patch) =>
    mutate((db) => {
      db.notificationPrefs = NotificationPrefs.parse({ ...(db.notificationPrefs ?? DEFAULT_PREFS), ...patch });
      return db.notificationPrefs;
    }),
  listDeliveries: (opts = {}) =>
    read((db) =>
      db.deliveries
        .filter((d) => (!opts.reminderId || d.reminderId === opts.reminderId) && (!opts.kind || d.kind === opts.kind) && (!opts.unreadOnly || (d.channel === "in_app" && d.status === "sent" && !d.readAt)))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
        .slice(0, opts.limit ?? 100),
    ),
  markDeliveriesRead: (ids, now) =>
    mutate((db) => {
      let n = 0;
      for (const d of db.deliveries) {
        if (d.channel === "in_app" && d.status === "sent" && !d.readAt && (ids === "all" || ids.includes(d.id))) {
          d.readAt = now.toISOString();
          n++;
        }
      }
      return n;
    }),
  cancelDeliveries: (reminderId, reason) =>
    mutate((db) => {
      let n = 0;
      for (const d of db.deliveries) {
        if (d.reminderId === reminderId && d.status === "pending") {
          Object.assign(d, { status: "skipped", reason, updatedAt: new Date().toISOString() });
          n++;
        }
      }
      return n;
    }),

  getCvDocument: () => read((db) => db.cvDocuments.find((d) => d.isCurrent) ?? null),
  listCvDocuments: () => read((db) => [...db.cvDocuments].sort((a, b) => b.createdAt.localeCompare(a.createdAt))),
  saveCvDocument: (doc) =>
    mutate((db) => {
      const now = doc.createdAt;
      db.cvDocuments = db.cvDocuments.map((d) => (d.isCurrent ? { ...d, isCurrent: false, replacedAt: now } : d));
      db.cvDocuments.push({ ...doc, isCurrent: true, replacedAt: null });
      return doc;
    }),
  updateCvDocument: (id, fn) =>
    mutate((db) => {
      const i = db.cvDocuments.findIndex((d) => d.id === id);
      if (i < 0) return null;
      db.cvDocuments[i] = fn(db.cvDocuments[i]);
      return db.cvDocuments[i];
    }),
  deleteCvDocuments: () =>
    mutate((db) => {
      const files = db.cvDocuments.map((d) => d.fileName).filter((n): n is string => Boolean(n));
      const versions = db.cvDocuments.length;
      db.cvDocuments = [];
      return { versions, files };
    }),

  upsertAction: (a: Action) =>
    mutate((db) => {
      const i = db.actions.findIndex((x) => x.id === a.id);
      if (i < 0) db.actions.push(a);
      else db.actions[i] = a;
      return a;
    }),
};

const SAFE_NAME = /^[0-9a-f-]{36}\.(png|jpg|webp|gif|pdf|docx|txt|wav|svg)$/;
const MIME = {
  png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif", pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", txt: "text/plain", wav: "audio/wav", svg: "image/svg+xml",
} as const;

const files: FileStore = {
  async put(fileName, bytes) {
    await mkdir(uploadsDir(), { recursive: true });
    await writeFile(path.join(uploadsDir(), fileName), bytes, { flag: "wx" });
  },
  async get(fileName) {
    const m = SAFE_NAME.exec(fileName);
    if (!m) return null; // also blocks path traversal: no slashes or dots beyond the extension
    try {
      return { bytes: new Uint8Array(await readFile(path.join(uploadsDir(), fileName))), mimeType: MIME[m[1] as keyof typeof MIME] };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  },
  async remove(fileName) {
    if (SAFE_NAME.test(fileName)) await unlink(path.join(uploadsDir(), fileName)).catch(() => {});
  },
};

export const localBackend: Backend = { kind: "local", store, files };

// ───────────────────────── scheduled worker (local demo store) ─────────────────────────
// One user, no accounts: the same worker logic runs against the JSON file. "local" is the only user id.

const LOCAL_USER = "local";

export const localWorkerStore: WorkerStore = {
  unprocessedDueReminders: (now, limit) =>
    read((db) => {
      const prefs = db.notificationPrefs ?? DEFAULT_PREFS;
      return db.reminders
        .filter((r) => (r.status === "scheduled" || r.status === "snoozed") && Date.parse(r.dueAt) <= now.getTime())
        .filter((r) => !db.deliveries.some((d) => d.kind === "reminder" && d.reminderId === r.id && Date.parse(d.dueAt ?? "") === Date.parse(r.dueAt)))
        .sort((a, b) => a.dueAt.localeCompare(b.dueAt))
        .slice(0, limit)
        .flatMap((reminder) => {
          const memory = db.memories.find((m) => m.id === reminder.memoryId);
          return memory ? [{ userId: LOCAL_USER, reminder, memory, plans: db.plans.filter((p) => p.memoryId === memory.id), prefs }] : [];
        });
    }),
  deliveryExists: (_u, key) => read((db) => db.deliveries.some((d) => d.dedupeKey === key)),
  insertDelivery: (_u, d) =>
    mutate((db) => {
      if (db.deliveries.some((x) => x.dedupeKey === d.dedupeKey)) return false;
      db.deliveries.push(d);
      return true;
    }),
  claimDeliveries: (now, limit, leaseSeconds) =>
    mutate((db) => {
      const prefs = db.notificationPrefs ?? DEFAULT_PREFS;
      const taken = db.deliveries
        .filter((d) => d.status === "pending" && Date.parse(d.scheduledFor) <= now.getTime() && (!d.lockedUntil || Date.parse(d.lockedUntil) <= now.getTime()))
        .sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor))
        .slice(0, limit);
      for (const d of taken) d.lockedUntil = new Date(now.getTime() + leaseSeconds * 1000).toISOString();
      return taken.map((d) => ({
        userId: LOCAL_USER,
        delivery: structuredClone(d),
        prefs,
        email: process.env.NOTIFY_LOCAL_EMAIL?.trim() || null,
        reminder: d.reminderId ? (db.reminders.find((r) => r.id === d.reminderId) ?? null) : null,
      }));
    }),
  updateDelivery: (id, patch) =>
    mutate((db) => {
      const d = db.deliveries.find((x) => x.id === id);
      if (d) Object.assign(d, patch, { lockedUntil: null, updatedAt: new Date().toISOString() });
    }),
  sentCount: (_u, since, channel) => read((db) => db.deliveries.filter((d) => d.kind === "reminder" && d.channel === channel && d.status === "sent" && d.sentAt && Date.parse(d.sentAt) >= since.getTime()).length),
  briefingUsers: () => read((db) => (db.notificationPrefs?.briefingEnabled ? [{ userId: LOCAL_USER, prefs: db.notificationPrefs, email: process.env.NOTIFY_LOCAL_EMAIL?.trim() || null }] : [])),
  snapshot: (_u, now) => read((db) => ({ memories: db.memories as Memory[], reminders: db.reminders, actions: db.actions, plans: db.plans, prefs: db.notificationPrefs ?? DEFAULT_PREFS, now })),
};
