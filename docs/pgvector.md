# pgvector: how embeddings are stored, searched and migrated

## Status
- **Code and migration: done and tested** against a real, disposable PostgreSQL with the real pgvector extension.
- **Applied to your Supabase project: NO.** Nothing in this repo touches the live project; you apply migrations.
- **Vector dimension: NOT chosen**, on purpose. No embedding model is selected (Meta's Model API documents none), so any number would be invented. The column is an untyped `extensions.vector`; each row records its `dims`, and `match_memories()` rejects a query whose size differs from what is stored for that model.
- **Decision required from you:** pick an embedding provider/model (OpenAI-compatible `POST {base}/embeddings`). Its output size (commonly 384 to 3072) then becomes `EMBEDDING_DIMENSIONS`. Optionally tighten the column to `vector(N)` and add an HNSW index (see the header of the migration). Until then semantic search is off and search is keyword-only.

## What the migration does (`20261101000000_pgvector_embeddings.sql`)
1. `create extension vector with schema extensions` (Supabase's convention; Dashboard → Database → Extensions shows it).
2. Adds `provider` and `embedding_vec extensions.vector` to `memory_embeddings`, copies any existing `real[]` vectors across, and makes the old `embedding` column optional. **It drops nothing.** Ownership, composite foreign key to `memories (id, user_id)`, cascade delete and the four RLS policies are unchanged (they were created by `20261031030000`).
3. Adds `match_memories(p_model, p_query, p_limit, p_min_similarity)`: cosine similarity (`1 - (a <=> b)`), best first, limit clamped to 1–200.

### Why SECURITY INVOKER
The function runs with the caller's rights, so RLS on `memory_embeddings` is enforced by Postgres itself and the function needs no extra privilege. It also filters `user_id = auth.uid()` explicitly, raises "not signed in" when there is no user, sets `search_path = ''` (every name is schema-qualified), and `execute` is revoked from `public`/`anon` and granted to `authenticated` only. No service-role key is involved anywhere in search.

### Existing `real[]` data
Nothing was ever applied to your project, so there are no real vectors to convert. If you had applied `20261031030000` and run indexing, the pgvector migration converts those rows exactly (real[] → vector). Vectors from the **test embedder** are not real and should be discarded, not migrated: they only exist in test databases.

## Applying it (you do this)
1. Back up: Dashboard → Database → Backups (or `pg_dump`). Nothing below deletes memories.
2. Apply in order the migrations not yet applied: `20261031030000_memory_embeddings.sql`, then `20261101000000_pgvector_embeddings.sql` (SQL editor or `supabase db push`).
3. Verify: `select extname from pg_extension where extname='vector';` returns a row, and `select count(*) from memory_embeddings where embedding_vec is null;` returns 0.
4. Set the embedding variables (below), restart, then **backfill**: sign in and `POST /api/embeddings` (e.g. from the browser console: `fetch('/api/embeddings',{method:'POST'}).then(r=>r.json())`). It reports `embedded`, `upToDate`, `failed`. Run it again until `failed` is 0; it only touches memories with no current vector.
5. Check: `GET /api/embeddings` shows `indexed` equal to `memories`; try a different-wording search.
6. Only after you are satisfied for a while: optionally run `supabase/rollback/cleanup_real_array_embeddings.sql` to drop the old column (the one destructive step; it refuses while any row lacks a vector).

## Rollback
`supabase/rollback/20261101000000_pgvector_embeddings.down.sql` copies vectors written since the migration back into `real[]`, removes `match_memories`, `embedding_vec` and `provider`, and restores the old constraint. Memories are untouched. It cannot be run after the cleanup script (re-run indexing instead).

## Switching models later
Vectors are keyed by `(memory_id, model)`, so a new model gets new rows beside the old ones; the app searches only the configured model. Backfill, verify, then delete the old model's rows if you want the space.

## Local testing
- `npm test` runs everything. `tests/pgvector.integration.test.ts` starts a throwaway PostgreSQL in a temp directory (unix socket only, nothing shared), applies the real migrations and tests real pgvector. It needs PostgreSQL ≥ 15 with pgvector installed (`brew install postgresql@18 pgvector`); set `PGBIN` to its `bin` directory if it isn't in the usual Homebrew/apt path. If it can't find one it prints "SKIPPED" and the tests are reported as skipped, not passed.
- PGlite (used by the other database tests) cannot load pgvector, so it applies every migration except the pgvector one.
- `tests/supabase-embeddings.test.ts` uses a fake client and checks request/response mapping only.
- Retrieval, ranking and weights are tested with a deterministic concept embedder (`tests/helpers/fake-embedder.ts`). It is a test fixture, not a model.

## Ranking knobs (all uncalibrated until a real model is connected)
| Variable | Default | Meaning |
|---|---|---|
| `SEARCH_SEMANTIC_WEIGHT` | 10 | what a perfect (1.0) vector match adds to the score |
| `SEARCH_KEYWORD_WEIGHT` | 1 | multiplier on everything that isn't semantic |
| `SEARCH_MIN_SIMILARITY` | 0.35 | ignore vector matches below this cosine similarity |
| `SEARCH_SEMANTIC_LIMIT` | 20 | nearest memories fetched per query |

The defaults are placeholders chosen against the test embedder. Calibrate them on a labelled query set (add one under `evals/`) once a provider is connected; cosine scores differ a lot between models.

## Cost estimate
No provider is chosen, so no price exists to quote and Acorn makes **no** embedding calls today. The shape of the cost: one embedding per memory (~100–1500 input tokens of title, summary, facts and the user's text) plus one per search query (a few tokens); re-embedding only when a memory's text changes. A few hundred memories is typically cents at current commodity embedding prices, but confirm against your chosen provider's rate card. Supabase pgvector adds no per-query charge beyond normal database usage; storage is `4 × dims` bytes per vector (e.g. 6 KB at 1536).
