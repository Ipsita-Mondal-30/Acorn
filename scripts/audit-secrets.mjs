// Secret exposure audit. Read-only. Prints WHICH variable or file and WHICH rule, never a secret's value.
//   node scripts/audit-secrets.mjs          (run `npm run build` first to include the browser-bundle check)
// Exit code 1 when something that must never leave your machine is somewhere it shouldn't be.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const results = [];
const add = (level, msg) => results.push([level, msg]);
const ok = (m) => add("OK  ", m);
const bad = (m) => add("FAIL", m);
const note = (m) => add("NOTE", m);

// ── 1. what is configured, and which of it is secret
const SECRET_NAME = /(KEY|SECRET|PASSWORD|TOKEN|DATABASE_URL|DIRECT_URL)/;
const envFile = path.join(root, ".env.local");
const values = new Map();
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && m[2].trim().replace(/^["']|["']$/g, "")) values.set(m[1], m[2].trim().replace(/^["']|["']$/g, ""));
  }
}
const secrets = [...values].filter(([k, v]) => SECRET_NAME.test(k) && !k.startsWith("NEXT_PUBLIC_") && v.length >= 8);
const publics = [...values].filter(([k]) => k.startsWith("NEXT_PUBLIC_"));
note(`.env.local defines ${values.size} variables: ${secrets.length} secret (${secrets.map(([k]) => k).join(", ") || "none"}), ${publics.length} public (${publics.map(([k]) => k).join(", ") || "none"}).`);
for (const [k] of publics) {
  if (SECRET_NAME.test(k.replace(/ANON_KEY|PUBLISHABLE_KEY/, ""))) bad(`${k} is NEXT_PUBLIC (sent to every browser) but its name says secret.`);
}
if (publics.some(([, v]) => /service_role|sb_secret_/.test(v))) bad("A NEXT_PUBLIC variable holds a service-role/secret key.");
else ok("No NEXT_PUBLIC variable holds a secret key.");

// ── 2. files git could commit (tracked + untracked, minus ignored)
let files = [];
try {
  files = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { encoding: "utf8" }).split("\n").filter(Boolean);
} catch {
  note("Not a git repository: scanning the working tree instead.");
}
const SKIP = /\.(png|jpg|jpeg|gif|webp|ico|pdf|docx|lock)$|package-lock\.json$/;
const RULES = [
  [/sk-(?:proj-)?[A-Za-z0-9_-]{24,}/, "OpenAI-style API key"],
  [/postgres(?:ql)?:\/\/[^\s:@/]+:[^\s@/]{4,}@/, "database URL with a password"],
  [/\bre_[A-Za-z0-9]{20,}\b/, "Resend-style API key"],
  [/\bsb_secret_[A-Za-z0-9_-]{16,}/, "Supabase secret key"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
  [/"role"\s*:\s*"service_role"/, "service_role token payload"],
];
let hits = 0;
for (const f of files) {
  if (SKIP.test(f) || !existsSync(f) || statSync(f).size > 2_000_000) continue;
  const text = readFileSync(f, "utf8");
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    for (const [re, why] of RULES) {
      if (re.test(line) && !/example|placeholder|FAKE|YOUR[-_ ]|<[^>]+>|xxxx|\*{3,}/i.test(line)) {
        hits++;
        bad(`${f}:${i + 1} looks like a ${why}.`);
      }
    }
    for (const [k, v] of secrets) {
      if (line.includes(v)) {
        hits++;
        bad(`${f}:${i + 1} contains the value of ${k}.`);
      }
    }
  });
}
if (!hits) ok(`${files.length} files that git could commit contain no secret-looking strings and none of the values in .env.local.`);
for (const f of [".env.local", ".env"]) if (files.includes(f)) bad(`${f} is not ignored: git would commit it.`);
if (existsSync(envFile) && !files.includes(".env.local")) ok(".env.local exists and is ignored by git.");
if (existsSync(".data") && files.some((f) => f.startsWith(".data/"))) bad(".data/ (local memories, uploads, CVs) is not ignored.");
else ok(".data/ (local memories and uploads) is ignored.");

// ── 3. the browser bundle (needs a build)
const bundleDirs = [".next/static", "public"].filter((d) => existsSync(d));
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const clientFiles = bundleDirs.flatMap(walk).filter((f) => /\.(js|css|html|json|txt|map)$/.test(f));
if (!existsSync(".next/static")) note("No build found (.next/static): run `npm run build` and re-run this to check the browser bundle.");
else {
  let leaked = 0;
  const names = secrets.map(([k]) => k).concat(["SUPABASE_SERVICE_ROLE_KEY", "CRON_SECRET", "META_API_KEY", "EMBEDDING_API_KEY", "EMAIL_API_KEY", "OPENAI_API_KEY", "DATABASE_URL", "DIRECT_URL"]);
  for (const f of clientFiles) {
    const text = readFileSync(f, "utf8");
    for (const [k, v] of secrets) {
      if (text.includes(v)) {
        leaked++;
        bad(`browser file ${f} contains the VALUE of ${k}.`);
      }
    }
    for (const n of new Set(names)) {
      if (text.includes(n)) {
        leaked++;
        bad(`browser file ${f} mentions the server-only variable ${n}.`);
      }
    }
  }
  if (!leaked) ok(`${clientFiles.length} browser files (.next/static, public) contain no secret value and no server-only variable name.`);
}

// ── 4. who reads each secret variable: only server code may
const srcFiles = (existsSync("src") ? walk("src") : []).filter((f) => /\.(ts|tsx)$/.test(f));
const secretNames = ["SUPABASE_SERVICE_ROLE_KEY", "CRON_SECRET", "META_API_KEY", "EMBEDDING_API_KEY", "EMAIL_API_KEY", "DATABASE_URL", "DIRECT_URL", "OPENAI_API_KEY"];
let uses = 0;
for (const f of srcFiles) {
  const text = readFileSync(f, "utf8");
  const mentioned = secretNames.filter((n) => text.includes(n));
  if (!mentioned.length) continue;
  uses++;
  const client = /^\s*["']use client["']/m.test(text);
  const isRoute = /src\/app\/.*route\.ts$/.test(f.replaceAll("\\", "/"));
  const serverOnly = /import ["']server-only["']/.test(text);
  if (client) bad(`${f} is a client component and mentions ${mentioned.join(", ")}.`);
  else if (!serverOnly && !isRoute && !/env\.ts$|startup-check\.ts$/.test(f)) bad(`${f} mentions ${mentioned.join(", ")} but is not marked server-only.`);
  note(`${f.replaceAll("\\", "/")} reads ${mentioned.join(", ")} (${client ? "CLIENT" : serverOnly ? "server-only module" : isRoute ? "route handler" : "config"}).`);
}
if (!results.some(([l, m]) => l === "FAIL" && /client component|not marked server-only/.test(m))) ok(`${uses} source files read secret variables; every one is server code.`);

for (const [l, m] of results) console.log(`${l}  ${m}`);
const failed = results.filter(([l]) => l === "FAIL").length;
console.log(failed ? `\n${failed} problem(s).` : "\nNo secret exposure found. (Values were compared but never printed.)");
process.exit(failed ? 1 : 0);
