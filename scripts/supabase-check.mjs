// Operator check for the Supabase setup: `npm run supabase:check`.
// Reads .env.local, validates the shape of every Supabase variable, and (only if the URL and anon key are set)
// makes read-only requests to the project. Prints variable NAMES and verdicts, never values. No Meta call, no writes.
import net from "node:net";

try {
  process.loadEnvFile(".env.local");
} catch {
  console.log("note: no .env.local found; checking the shell environment");
}
const env = (n) => process.env[n]?.trim() || "";
const results = [];
const ok = (m) => results.push(["ok  ", m]);
const bad = (m) => results.push(["FAIL", m]);
const warn = (m) => results.push(["warn", m]);
const verdict = (cond, good, problem) => (cond ? ok(good) : bad(problem));

// ── public settings
const url = env("NEXT_PUBLIC_SUPABASE_URL");
const anon = env("NEXT_PUBLIC_SUPABASE_ANON_KEY");
if (!url && !anon) warn("NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are not set: Acorn runs in local demo mode.");
else {
  if (!url) bad("NEXT_PUBLIC_SUPABASE_URL is missing (Project settings → API → Project URL).");
  if (!anon) bad("NEXT_PUBLIC_SUPABASE_ANON_KEY is missing (the anon / publishable key, NOT the service-role key).");
  if (url) {
    try {
      const u = new URL(url);
      if (u.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(u.hostname)) bad("NEXT_PUBLIC_SUPABASE_URL must be https.");
      else ok("NEXT_PUBLIC_SUPABASE_URL is a valid URL.");
    } catch {
      bad("NEXT_PUBLIC_SUPABASE_URL is not a valid URL.");
    }
  }
  if (/service_role|sb_secret_/.test(anon)) bad("NEXT_PUBLIC_SUPABASE_ANON_KEY looks like a SECRET key. Public variables are sent to browsers. Use the publishable/anon key.");
}
if (env("SUPABASE_SERVICE_ROLE_KEY")) ok("SUPABASE_SERVICE_ROLE_KEY is set (used only by the scheduled notification worker and operator scripts; no user request uses it).");
else warn("SUPABASE_SERVICE_ROLE_KEY is not set. Optional.");

// ── database URLs (used only to apply migrations, never by the running app)
function checkDb(name) {
  const raw = env(name);
  if (!raw) return warn(`${name} is not set (needed only to apply migrations from your machine).`);
  const m = raw.match(/^(postgres(?:ql)?):\/\/([^/?#]*)(\/[^?#]*)?(\?.*)?$/);
  if (!m) return bad(`${name} is not a postgres:// URL.`);
  const authority = m[2];
  const at = authority.lastIndexOf("@");
  if (at < 0) return bad(`${name} has no user@host part.`);
  const userinfo = authority.slice(0, at);
  const hostport = authority.slice(at + 1);
  const colon = userinfo.indexOf(":");
  const password = colon < 0 ? "" : userinfo.slice(colon + 1);
  if (!password) bad(`${name} has no password.`);
  if (/[@/?#\[\]]/.test(password.replace(/%[0-9a-fA-F]{2}/g, ""))) {
    bad(`${name}: the password contains a reserved character (@ / ? # [ ]). Percent-encode it (@ becomes %40) or reset the password to letters and digits.`);
  }
  if (userinfo.slice(0, colon < 0 ? undefined : colon).includes("@")) bad(`${name}: the user name contains an unencoded @.`);
  const host = hostport.replace(/:\d+$/, "");
  if (!/^[a-z0-9.-]+$/i.test(host) || !/\.(supabase\.(com|co)|pooler\.supabase\.com)$/.test(host)) {
    bad(`${name}: host "${host}" does not look like a Supabase host (expected something like aws-0-<region>.pooler.supabase.com or db.<ref>.supabase.co).`);
  }
  if (!/:\d+$/.test(hostport)) warn(`${name} has no port (5432 session pooler, 6543 transaction pooler).`);
  if (!results.some(([l, t]) => l === "FAIL" && t.startsWith(name))) ok(`${name} is well formed.`);
  return { host, port: Number((hostport.match(/:(\d+)$/) ?? [])[1] ?? 5432) };
}
const targets = [checkDb("DATABASE_URL"), checkDb("DIRECT_URL")].filter((t) => t && typeof t === "object");

const tcp = (host, port) =>
  new Promise((res) => {
    const s = net.connect({ host, port, timeout: 5000 });
    s.on("connect", () => (s.destroy(), res(true)));
    s.on("error", () => res(false));
    s.on("timeout", () => (s.destroy(), res(false)));
  });
for (const t of targets) {
  if (!/^[a-z0-9.-]+$/i.test(t.host)) continue;
  verdict(await tcp(t.host, t.port), `${t.host}:${t.port} accepts connections.`, `${t.host}:${t.port} is unreachable (wrong host or port, or a network block).`);
}

// ── project probes (read-only)
if (url && anon && !results.some(([l, t]) => l === "FAIL" && /SUPABASE_(URL|ANON)/.test(t))) {
  const base = new URL(url).origin;
  const get = async (p, headers = {}) => {
    try {
      return await fetch(base + p, { headers: { apikey: anon, ...headers }, signal: AbortSignal.timeout(10_000) });
    } catch {
      return null;
    }
  };
  const health = await get("/auth/v1/health");
  verdict(health?.ok, "Auth service answers with this anon key.", `Auth service did not accept the URL/anon key${health ? ` (HTTP ${health.status})` : " (unreachable)"}.`);
  for (const table of ["profiles", "memories", "actions", "tags", "memory_tags", "reminders"]) {
    const r = await get(`/rest/v1/${table}?select=id&limit=1`);
    if (!r) bad(`${table}: unreachable.`);
    else if (r.status === 404) bad(`${table}: table not found. Apply the migrations in supabase/migrations.`);
    else if (r.status === 200) {
      const rows = await r.json().catch(() => null);
      verdict(!(Array.isArray(rows) && rows.length), `${table}: exists, and returns no rows to an anonymous request.`, `${table}: an ANONYMOUS request returned rows. RLS is not protecting this table!`);
    } else ok(`${table}: exists, anonymous access refused (HTTP ${r.status}).`);
  }
  // Later migrations (embeddings, plans, CV documents). A missing table is a WARN, not a failure: those features stay off until
  // the migration is applied. A table that answers an anonymous request with rows is always a failure.
  for (const [table, migration] of [["memory_embeddings", "20261031030000 + 20261101000000"], ["plans", "20261102000000"], ["cv_documents", "20261103000000"], ["notification_preferences", "20261104000000"], ["notification_deliveries", "20261104000000"]]) {
    const r = await get(`/rest/v1/${table}?select=id&limit=1`);
    if (!r) warn(`${table}: unreachable.`);
    else if (r.status === 404) warn(`${table}: not created yet (migration ${migration}). The matching feature stays off until you apply it.`);
    else if (r.status === 200) {
      const rows = await r.json().catch(() => null);
      verdict(!(Array.isArray(rows) && rows.length), `${table}: exists, and returns no rows to an anonymous request.`, `${table}: an ANONYMOUS request returned rows. RLS is not protecting this table!`);
    } else ok(`${table}: exists, anonymous access refused (HTTP ${r.status}).`);
  }
  // anon has no EXECUTE on this function, so PostgREST answers 404 whether or not it exists: it can only be
  // confirmed with a database connection (or by searching in the app after signing in).
  const fn = await get("/rest/v1/rpc/search_memories_fts", { "content-type": "application/json" });
  if (fn?.ok) bad("search_memories_fts answered an ANONYMOUS request.");
  else ok("search_memories_fts is not callable anonymously (existence is confirmed by applying the migration, not by this check).");
  const bucket = await get("/storage/v1/object/public/memory-images/probe.png");
  if (bucket?.ok) bad("memory-images is PUBLIC.");
  else if (bucket && [400, 404].includes(bucket.status)) ok("memory-images is not publicly readable.");
  else warn("Could not confirm the memory-images bucket state.");
}

for (const [l, m] of results) console.log(`${l}  ${m}`);
const failed = results.filter(([l]) => l === "FAIL").length;
console.log(failed ? `\n${failed} problem(s).` : "\nNo problems found. (This check cannot sign in as a user; test signup/login in the app.)");
process.exit(failed ? 1 : 0);
