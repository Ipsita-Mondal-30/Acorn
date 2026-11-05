import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

// In-process Postgres that mimics the pieces of Supabase the migrations lean on (roles, auth.uid(), storage
// tables), then applies the REAL migration files. RLS is only enforced for non-superusers, so tests act as
// `anon` / `authenticated` via SET ROLE, exactly as PostgREST does.

export const STUBS = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;

  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

  create schema storage;
  create table storage.buckets (
    id text primary key, name text, public boolean default false,
    file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (
    id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets (id),
    name text, owner uuid default auth.uid());
  alter table storage.objects enable row level security;
  create function storage.foldername(name text) returns text[] language sql immutable as
    $$ select (string_to_array(name, '/'))[1:greatest(array_length(string_to_array(name, '/'), 1) - 1, 0)] $$;

  grant usage on schema auth, storage, public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to service_role;
  alter default privileges in schema public grant all on functions to service_role;
  grant select, insert, update, delete on storage.objects to authenticated;
  grant select on storage.buckets to authenticated;
`;

export type TestDb = Awaited<ReturnType<typeof makeDb>>;

export async function makeDb() {
  const db = new PGlite();
  await db.exec(STUBS);
  const dir = path.resolve(__dirname, "../../supabase/migrations");
  // PGlite 0.5 cannot load the pgvector extension, so the pgvector migration is applied only by the disposable-PostgreSQL
  // suite (tests/pgvector.integration.test.ts), never faked here.
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql") && !f.includes("pgvector")).sort()) {
    await db.exec(readFileSync(path.join(dir, f), "utf8"));
  }

  const signUp = async (email: string) => {
    const r = await db.query<{ id: string }>("insert into auth.users (email) values ($1) returning id", [email]);
    return r.rows[0].id;
  };

  /** Run `fn` as an authenticated user (RLS applies). */
  async function asUser<T>(userId: string, fn: (q: PGlite["query"]) => Promise<T>): Promise<T> {
    await db.exec("set role authenticated");
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [userId]);
    try {
      return await fn(db.query.bind(db));
    } finally {
      await db.exec("reset role");
      await db.query("select set_config('request.jwt.claim.sub', '', false)");
    }
  }

  async function asAnon<T>(fn: (q: PGlite["query"]) => Promise<T>): Promise<T> {
    await db.exec("set role anon");
    try {
      return await fn(db.query.bind(db));
    } finally {
      await db.exec("reset role");
    }
  }

  /** Run `fn` as Supabase's service role: bypasses row-level security, has no auth.uid() (what a scheduled worker is). */
  async function asService<T>(fn: (q: PGlite["query"]) => Promise<T>): Promise<T> {
    await db.exec("set role service_role");
    try {
      return await fn(db.query.bind(db));
    } finally {
      await db.exec("reset role");
    }
  }

  return { db, signUp, asUser, asAnon, asService };
}
