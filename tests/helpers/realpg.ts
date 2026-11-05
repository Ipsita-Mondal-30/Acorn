import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { STUBS } from "./pg";

// A DISPOSABLE, real PostgreSQL server with the real pgvector extension, started in a temp directory on a unix socket
// (no TCP port, no credentials, nothing shared) and deleted afterwards. It is used only where PGlite cannot load
// pgvector. If PostgreSQL + pgvector aren't installed the suite is SKIPPED and says so; it is never reported as passed.

const CANDIDATES = [process.env.PGBIN, ...[18, 17, 16, 15].flatMap((v) => [`/opt/homebrew/opt/postgresql@${v}/bin`, `/usr/lib/postgresql/${v}/bin`])].filter(Boolean) as string[];

export function findPostgres(): { bin: string } | null {
  for (const bin of CANDIDATES) {
    if (!existsSync(path.join(bin, "initdb")) || !existsSync(path.join(bin, "pg_ctl")) || !existsSync(path.join(bin, "psql"))) continue;
    const share = spawnSync(path.join(bin, "pg_config"), ["--sharedir"], { encoding: "utf8" }).stdout.trim();
    if (share && existsSync(path.join(share, "extension", "vector.control"))) return { bin };
  }
  return null;
}

export const MIGRATIONS = path.resolve(__dirname, "../../supabase/migrations");
export const ROLLBACK = path.resolve(__dirname, "../../supabase/rollback");
export const migration = (name: string) => readFileSync(path.join(MIGRATIONS, name), "utf8");
export const migrationFiles = () => readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();

// macOS: the postmaster refuses to start ("became multithreaded") unless it has a valid locale
const ENV = { ...process.env, LC_ALL: "en_US.UTF-8", LANG: "en_US.UTF-8" };

export class DisposablePg {
  private dir = mkdtempSync(path.join(os.tmpdir(), "pgv-"));
  private sock = path.join(this.dir, "s");
  constructor(private bin: string) {}

  start() {
    execFileSync(path.join(this.bin, "initdb"), ["-D", path.join(this.dir, "data"), "-U", "postgres", "-A", "trust", "--no-sync", "-E", "UTF8"], { stdio: "ignore", env: ENV });
    execFileSync("mkdir", [this.sock]);
    execFileSync(
      path.join(this.bin, "pg_ctl"),
      ["-D", path.join(this.dir, "data"), "-o", `-k ${this.sock} -c listen_addresses= -c fsync=off -c synchronous_commit=off`, "-l", path.join(this.dir, "log"), "-w", "start"],
      { stdio: "ignore", env: ENV },
    );
  }
  stop() {
    try {
      execFileSync(path.join(this.bin, "pg_ctl"), ["-D", path.join(this.dir, "data"), "-m", "immediate", "-w", "stop"], { stdio: "ignore", env: ENV });
    } finally {
      rmSync(this.dir, { recursive: true, force: true });
    }
  }

  /** Run SQL in database `db`, optionally as an authenticated user / anon (RLS applies), and return the output rows (cells split on "|"). */
  sql(text: string, opts: { db?: string; as?: { user: string | null; role?: "authenticated" | "anon" } } = {}): string[][] {
    const pre = opts.as ? `set role ${opts.as.role ?? "authenticated"};\n${opts.as.user ? `set request.jwt.claim.sub = '${opts.as.user}';\n` : ""}` : "";
    const r = spawnSync(path.join(this.bin, "psql"), ["-h", this.sock, "-U", "postgres", "-d", opts.db ?? "postgres", "-X", "-q", "-A", "-t", "-F", "|", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
      input: pre + text,
      encoding: "utf8",
      env: ENV,
    });
    if (r.status !== 0) throw new Error(r.stderr.trim() || `psql exited ${r.status}`);
    return r.stdout.split("\n").filter(Boolean).map((l) => l.split("|"));
  }

  /** A fresh database with the Supabase-like stubs, the vector extension in schema `extensions`, and the given migrations. */
  createDb(name: string, files: string[]) {
    this.sql(`create database ${name}`);
    // roles are cluster-wide, so create them only once across the databases of this server
    const stubs = STUBS.replace(/create role (\w+) nologin( bypassrls)?;/g, (_m, r, b = "") => `do $$ begin if not exists (select 1 from pg_roles where rolname = '${r}') then create role ${r} nologin${b}; end if; end $$;`);
    this.sql(`${stubs}\ncreate schema extensions;\ngrant usage on schema extensions to anon, authenticated;\ncreate extension vector with schema extensions;`, { db: name });
    for (const f of files) this.sql(migration(f), { db: name });
  }
}
