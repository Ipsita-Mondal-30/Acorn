import { after } from "next/server";
import { captureFromShare } from "@/lib/share";
import { processMemory, saveCapture } from "@/lib/process";
import { isHeic, MAX_DOCUMENT_BYTES, MAX_UPLOAD_BYTES, UploadError, uploadKind } from "@/lib/uploads";
import { AuthError } from "@/lib/backends/types";
import { relativeRedirect } from "@/lib/http/redirect";
import { logError } from "@/lib/log";
import { UrlError } from "@/lib/url";

// Web Share Target (see app/manifest.ts): the installed Android app is offered in the share sheet, which sends the shared
// title/text/url and/or files here as a form POST. It only SAVES (each original is stored first) and then opens what was
// saved, which shows its own progress. Nothing is sent anywhere else, and nothing is done with it until the user decides.
// iOS Safari has no Web Share Target, so none of this is reached from the iOS share sheet (see docs/platform-sharing-audit.md).
//
// Every redirect is RELATIVE: behind a tunnel or proxy the app only sees its own address, and an absolute Location built
// from it would send the phone to "localhost".

type Fail = "empty" | "type" | "large" | "heic" | "failed" | "signin";
const fail = (code: Fail) => relativeRedirect(`/capture?share=${code}`);

/** Android can send several files at once; more than this are skipped (and said so), never silently dropped. */
export const MAX_SHARED_FILES = 10;

type Shared = { title?: string; text?: string; url?: string };

/** Where to send someone who isn't signed in, so a shared link or text survives the sign-in. Files can't: they are asked to share again. */
function signInThenCapture(shared: Shared, hadFile: boolean) {
  const to = new URL("/capture", "http://placeholder.invalid");
  if (hadFile) to.searchParams.set("share", "signin");
  for (const k of ["title", "text", "url"] as const) if (shared[k]) to.searchParams.set(k, shared[k]!.slice(0, k === "text" ? 20_000 : 2000));
  return relativeRedirect(`/login?next=${encodeURIComponent(to.pathname + to.search)}`);
}

type FileOutcome = { ok: true; id: string; created: boolean; pending: boolean } | { ok: false; why: Exclude<Fail, "empty" | "signin"> | "limit" };

/** One file, judged entirely on its own bytes and size: a bad file never affects the others. */
async function saveOne(file: File, caption: string): Promise<FileOutcome> {
  if (file.size > MAX_DOCUMENT_BYTES) return { ok: false, why: "large" };
  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = uploadKind(bytes); // from the bytes, never the name or declared type
  if (!kind) return { ok: false, why: isHeic(bytes) ? "heic" : "type" };
  if (kind === "image" && file.size > MAX_UPLOAD_BYTES) return { ok: false, why: "large" };
  try {
    const { memory, created } = await saveCapture({ kind, bytes, originalName: file.name, ...(caption ? { text: caption } : {}) });
    return { ok: true, id: memory.id, created, pending: memory.status === "pending" };
  } catch (e) {
    if (e instanceof AuthError) throw e; // not signed in: nothing is saved for anyone
    logError("share_file_failed", e); // type and size were checked above, so this is the store failing: say "failed", not "wrong type"
    return { ok: false, why: "failed" };
  }
}

export async function POST(req: Request) {
  let shared: Shared = {};
  let hadFile = false;
  try {
    const form = await req.formData().catch(() => null);
    if (!form) return fail("empty");
    const field = (k: string) => (typeof form.get(k) === "string" ? (form.get(k) as string) : undefined);
    shared = { title: field("title"), text: field("text"), url: field("url") };
    const files = form.getAll("file").filter((f): f is File => f instanceof File && f.size > 0);
    hadFile = files.length > 0;
    const queue = (id: string) => after(() => processMemory(id).catch((e) => logError("share_process_failed", e)));

    if (!hadFile) {
      const capture = captureFromShare(shared);
      if (!capture) return fail("empty");
      const { memory } = await saveCapture(capture);
      if (memory.status === "pending") queue(memory.id);
      return relativeRedirect(`/memories/${memory.id}?saved=1`);
    }

    // one or more files: each is validated and saved independently; the shared title/text is each one's caption
    const caption = [shared.title, shared.text].filter(Boolean).join("\n").trim().slice(0, 2000);
    const outcomes: FileOutcome[] = [];
    for (const [i, file] of files.entries()) outcomes.push(i >= MAX_SHARED_FILES ? { ok: false, why: "limit" } : await saveOne(file, caption));
    const saved = outcomes.filter((o): o is Extract<FileOutcome, { ok: true }> => o.ok);
    const skipped = outcomes.filter((o): o is Extract<FileOutcome, { ok: false }> => !o.ok);
    const queued = new Set<string>();
    for (const o of saved) {
      if (!o.pending || queued.has(o.id)) continue;
      queued.add(o.id);
      queue(o.id);
    }

    if (saved.length === 0) return fail((skipped[0]?.why === "limit" ? "large" : skipped[0]?.why) ?? "failed");
    // the common case, one file saved cleanly, opens that memory exactly as before
    if (saved.length === 1 && skipped.length === 0) return relativeRedirect(`/memories/${saved[0].id}?saved=1`);
    const dup = saved.filter((o) => !o.created).length;
    const why = [...new Set(skipped.map((o) => o.why))].join(",");
    const q = new URLSearchParams({ shared: String(new Set(saved.map((o) => o.id)).size), ...(skipped.length ? { skipped: String(skipped.length), why } : {}), ...(dup ? { dup: String(dup) } : {}) });
    return relativeRedirect(`/memories?${q}`);
  } catch (e) {
    if (e instanceof AuthError) return signInThenCapture(shared, hadFile);
    if (e instanceof UploadError) return fail("type");
    if (!(e instanceof UrlError)) logError("share_failed", e);
    return fail(e instanceof UrlError ? "empty" : "failed");
  }
}

/** Opening /share directly (or a share target configured for GET) goes to the capture form with the shared values filled in. */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const to = new URL("/capture", "http://placeholder.invalid");
  for (const k of ["title", "text", "url"]) {
    const v = u.searchParams.get(k);
    if (v) to.searchParams.set(k, v.slice(0, k === "text" ? 20_000 : 2000));
  }
  return relativeRedirect(`${to.pathname}${to.search}`);
}
