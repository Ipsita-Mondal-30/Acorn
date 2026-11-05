import type { SupabaseClient } from "@supabase/supabase-js";
import type { TestDb } from "./pg";

// A tiny PostgREST/supabase-js stand-in that runs the SAME calls the app makes (from/select/eq/order/insert/upsert/
// update/delete/rpc, storage) against the in-process Postgres, as a given authenticated user. That puts the real
// store code in front of the real schema, constraints, triggers and Row-Level Security.

type Err = { message: string; code?: string } | null;
type Result = { data: unknown; error: Err };

class Query implements PromiseLike<Result> {
  private op: "select" | "insert" | "upsert" | "update" | "delete" = "select";
  private cols = "*";
  private filters: [string, unknown][] = [];
  private orderBy: string | null = null;
  private values: Record<string, unknown> | Record<string, unknown>[] | null = null;
  private conflict: string | null = null;
  private ignoreDup = false;
  private returning = false;
  private single = false;

  constructor(private run: (sql: string, params: unknown[]) => Promise<Result>, private table: string) {}

  select(cols = "*") {
    if (this.op === "select") this.cols = cols;
    else this.returning = true;
    return this;
  }
  insert(v: Query["values"]) { this.op = "insert"; this.values = v; return this; }
  upsert(v: Query["values"], o: { onConflict?: string; ignoreDuplicates?: boolean } = {}) {
    this.op = "upsert"; this.values = v; this.conflict = o.onConflict ?? null; this.ignoreDup = !!o.ignoreDuplicates; return this;
  }
  update(v: Query["values"]) { this.op = "update"; this.values = v; return this; }
  delete() { this.op = "delete"; return this; }
  eq(col: string, val: unknown) { this.filters.push([col, val]); return this; }
  in(col: string, vals: unknown[]) { this.filters.push([col, vals]); return this; }
  private ops: [string, string, unknown][] = [];
  lte(col: string, v: unknown) { this.ops.push([col, "<=", v]); return this; }
  gte(col: string, v: unknown) { this.ops.push([col, ">=", v]); return this; }
  lt(col: string, v: unknown) { this.ops.push([col, "<", v]); return this; }
  gt(col: string, v: unknown) { this.ops.push([col, ">", v]); return this; }
  is(col: string, v: null) { this.ops.push([col, v === null ? "is" : "=", v]); return this; }
  order(col: string, o: { ascending?: boolean } = {}) { this.orderBy = `${col} ${o.ascending === false ? "desc" : "asc"}`; return this; }
  private max: number | null = null;
  limit(n: number) { this.max = n; return this; }
  maybeSingle() { this.single = true; return this; }

  then<A, B>(ok?: ((r: Result) => A | PromiseLike<A>) | null, bad?: ((e: unknown) => B | PromiseLike<B>) | null) {
    return this.exec().then(ok, bad);
  }

  private async exec(): Promise<Result> {
    const t = `public.${this.table}`;
    const params: unknown[] = [];
    // in an UPDATE the new values are joined in as `v`, so columns must be qualified with the table to stay unambiguous
    const q = (c: string) => (this.op === "update" ? `${this.table}.${c}` : c);
    const conds = [
      ...this.filters.map(([c, v]) => (params.push(v), Array.isArray(v) ? `${q(c)}::text = any($${params.length}::text[])` : `${q(c)} = $${params.length}`)),
      ...this.ops.map(([c, op, v]) => (v === null ? `${q(c)} is null` : (params.push(v), `${q(c)} ${op} $${params.length}`))),
    ];
    const where = conds.length ? " where " + conds.join(" and ") : "";
    const rows = Array.isArray(this.values) ? this.values : this.values ? [this.values] : [];
    let sql: string;
    switch (this.op) {
      case "select":
        sql = `select ${this.cols === "*" ? "to_json(x.*)" : `to_json(x)`} as j from (select ${this.cols} from ${t}${where}${this.orderBy ? ` order by ${this.orderBy}` : ""}${this.max !== null ? ` limit ${Number(this.max)}` : ""}) x`;
        break;
      case "insert":
      case "upsert": {
        params.push(JSON.stringify(rows));
        const cols = Object.keys(rows[0] ?? {});
        const base = `insert into ${t} (${cols.join(",")}) select ${cols.join(",")} from json_populate_recordset(null::${t}, $${params.length}::json)`;
        const conflict =
          this.op === "insert" ? "" : this.ignoreDup
            ? ` on conflict (${this.conflict}) do nothing`
            : ` on conflict (${this.conflict ?? "id"}) do update set ${cols.filter((c) => !(this.conflict ?? "id").split(",").includes(c)).map((c) => `${c} = excluded.${c}`).join(", ") || "id = excluded.id"}`;
        sql = `with r as (${base}${conflict} returning *) select to_json(r.*) as j from r`;
        break;
      }
      case "update": {
        params.push(JSON.stringify(this.values));
        const cols = Object.keys(this.values as object);
        sql = `with r as (update ${t} set ${cols.map((c) => `${c} = v.${c}`).join(", ")} from json_populate_record(null::${t}, $${params.length}::json) v${where} returning ${this.table}.*) select to_json(r.*) as j from r`;
        break;
      }
      case "delete":
        sql = `with r as (delete from ${t}${where} returning *) select to_json(r.*) as j from r`;
        break;
    }
    const res = await this.run(sql, params);
    if (res.error) return res;
    const rowsOut = res.data as unknown[];
    if (this.single) {
      if (rowsOut.length > 1) return { data: null, error: { message: "multiple rows returned", code: "PGRST116" } };
      return { data: rowsOut[0] ?? null, error: null };
    }
    // a write without .select() returns no body
    if ((this.op === "insert" || this.op === "upsert" || this.op === "update" || this.op === "delete") && !this.returning) return { data: null, error: null };
    return { data: rowsOut, error: null };
  }
}

export type Bucket = Map<string, { bytes: Uint8Array; type: string }>;

/** `failNext` injects a database / storage failure for the next call that matches. */
export function pgrestClient(t: TestDb, userId: string | null, opts: { storage?: Bucket; service?: boolean } = {}) {
  const storage: Bucket = opts.storage ?? new Map();
  const failures: { match: RegExp; error: NonNullable<Err> }[] = [];
  const run = async (sql: string, params: unknown[]): Promise<Result> => {
    const hit = failures.findIndex((f) => f.match.test(sql));
    if (hit >= 0) return { data: null, error: failures.splice(hit, 1)[0].error };
    try {
      const exec = (q: (s: string, p: unknown[]) => Promise<{ rows: unknown[] }>) => q(sql, params);
      const r = opts.service ? await t.asService((q) => exec(q as never)) : userId ? await t.asUser(userId, (q) => exec(q as never)) : await t.asAnon((q) => exec(q as never));
      return { data: (r.rows as { j: unknown }[]).map((x) => x.j), error: null };
    } catch (e) {
      const err = e as { message: string; code?: string };
      return { data: null, error: { message: err.message, code: err.code } };
    }
  };

  const objectsOk = (path: string) => userId !== null && path.split("/")[0] === userId; // mirrors the storage policy (tested in SQL)
  const client = {
    from: (table: string) => new Query(run, table),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      const names = Object.keys(args);
      const res = await run(
        `select to_json(r.*) as j from public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(", ")}) r`,
        names.map((n) => args[n]),
      );
      return res;
    },
    storage: {
      from: () => ({
        async upload(path: string, bytes: Uint8Array, o: { contentType: string; upsert: boolean }) {
          const fail = failures.findIndex((f) => f.match.test("storage.upload"));
          if (fail >= 0) return { data: null, error: failures.splice(fail, 1)[0].error };
          if (!objectsOk(path)) return { data: null, error: { message: "new row violates row-level security policy" } };
          if (storage.has(path) && !o.upsert) return { data: null, error: { message: "The resource already exists" } };
          storage.set(path, { bytes, type: o.contentType });
          return { data: { path }, error: null };
        },
        async download(path: string) {
          const f = objectsOk(path) ? storage.get(path) : undefined;
          return f ? { data: new Blob([f.bytes as BlobPart], { type: f.type }), error: null } : { data: null, error: { message: "Object not found" } };
        },
        async remove(paths: string[]) {
          for (const p of paths) if (objectsOk(p)) storage.delete(p);
          return { data: [], error: null };
        },
        async createSignedUrl(path: string, seconds: number) {
          return objectsOk(path) && storage.has(path)
            ? { data: { signedUrl: `https://example.supabase.co/storage/v1/object/sign/memory-images/${path}?token=t&ttl=${seconds}` }, error: null }
            : { data: null, error: { message: "Object not found" } };
        },
      }),
    },
  };
  return { client: client as unknown as SupabaseClient, storage, pendingFailures: () => failures.length, failNext: (match: RegExp, error: NonNullable<Err> = { message: "boom", code: "XX000" }) => failures.push({ match, error }) };
}
