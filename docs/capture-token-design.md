# Capture tokens: security design for review

**Status: DECIDED NOT TO BUILD Option B (capture token with a service-role module). Decision: stop at Shortcut (links and text through the browser) plus a native app/Share Extension using the user's own Supabase session (Option A). Nothing here is implemented and no migration exists. Reopen only if sending files from an iPhone Shortcut becomes a real requirement, and then review this design first.**
Purpose: let a client that cannot hold a browser session (an iPhone Shortcut, later a native Share Extension) save a link, text or
file to ONE user's Acorn, without ever weakening the guarantees the app has today (RLS, private storage, per-user ownership,
approval gates).

## Why tokens are not simply "an API key"

Today every private request is authenticated by the Supabase **session cookie**, and every query runs as that user so Postgres RLS
enforces ownership. A Shortcut has its own network stack and does not share Safari's cookies, and it cannot run Supabase's refresh
flow. Whatever replaces the cookie must (a) identify exactly one user, (b) be able to do only one thing, (c) be revocable at once, and
(d) not require a secret in the app that can read or write everyone's data.

## The central decision: how do the writes reach Postgres and Storage?

| Option | How | Service-role key in the app? | Verdict |
|---|---|---|---|
| **A. Supabase user JWT as the bearer** (native app / extension only) | The native app signs in with Supabase (email+password, same as the web), keeps the session in the iOS **Keychain** (shared with the extension through a Keychain access group). The extension sends `Authorization: Bearer <access token>`; the server builds its Supabase client with that token | **No** | Best for native. Reuses RLS, storage policies and the existing code path unchanged. Not usable from a Shortcut (cannot refresh tokens) |
| **B. Opaque capture token + a confined server-side admin module** | Shortcut sends `Authorization: Bearer acorn_cap_…`. The server looks the token up, then performs the write with a service-role client limited to ONE small module | **Yes**, server-only | The only way to let a Shortcut upload files. Largest blast radius: a bug in that module is a cross-user bug (RLS no longer helps) |
| C. Opaque token + `SECURITY DEFINER` SQL functions | Token hash is verified inside Postgres; a function inserts the memory row with the token's `user_id` | No | Works for link/text rows. **Cannot upload file bytes** (Storage needs a JWT or the service role), so it does not solve the Shortcut-files case. Optional for links/text |
| D. Mint short-lived user JWTs server-side | Server signs a JWT for the token's user | Needs the project **JWT secret**, as sensitive as the service role | Rejected |

**Recommendation:**
1. **Native app / Share Extension: use Option A.** No new secret, no token table, RLS untouched.
2. **Shortcuts: keep the browser hand-off for links and text (no token, no risk).** Only build Option B if sending *files* from a Shortcut is judged worth the added risk. If it is built, it must satisfy every control below. Option C can cover links/text without the service role, but adds no value over the browser hand-off, so it is not recommended.
3. **Never** put the service-role key in the browser, in client bundles, in logs, or in any module other than the confined one.

## If Option B is approved: the design

### Token
- Format `acorn_cap_<43 chars>` = 256 bits from a CSPRNG (base64url). The prefix lets secret scanners find leaked tokens and lets users recognise them.
- Shown **once**, at creation. Stored only as `SHA-256(token)` (a high-entropy random token does not need a slow hash or a salt). Looked up by hash; compared in constant time.
- One token per device/purpose, with a user-chosen name ("My iPhone"). Default expiry 90 days, user-selectable, never "forever". Max 5 live tokens per user.
- Scope list, initially only `capture:create`. A token can **create** memories (note, link, image, PDF). It cannot read, list, search, edit or delete anything, and cannot reach plans, reminders, the CV or settings.

### Storage of tokens (migration outline, NOT written)
`capture_tokens(id uuid pk, user_id uuid not null references auth.users on delete cascade, name text, token_hash bytea unique not null, prefix text, scopes text[], created_at, expires_at, revoked_at, last_used_at, use_count int)`.
RLS: owner can `select` (never `token_hash`: expose a view without it), `insert` through a server function only, and `update` only `revoked_at`. `anon` has no access. A second table `capture_audit(token_id, user_id, at, outcome, kind, bytes, ip_hash)` is append-only, owner-readable.

### Endpoint
`POST /api/capture` with `Authorization: Bearer …`. No cookies are read or trusted on this route, so there is no CSRF surface; CORS stays closed (Shortcuts are not browsers). JSON for note/link, multipart for one file. Every failure is a generic `401` for any token problem (unknown, revoked, expired), so the endpoint is not an oracle.

### The confined admin module (`src/lib/capture-token/admin.ts`, the only file that may import the service-role client)
Allowed operations, nothing else:
1. `verify(token) -> { userId, tokenId } | null` (checks hash, not revoked, not expired, scope).
2. `putFile(userId, name, bytes, mime)` writing **only** to `<userId>/<uuid>.<ext>` in the existing private bucket.
3. `insertMemory(userId, memory)` that sets `user_id` itself from step 1; it never accepts a user id from the request.
A lint rule/test fails the build if the service-role client is imported anywhere else, and a test proves a token for user A can never write a row or object under user B's id.

### Validation (reuse, do not re-implement)
- The **same** functions as the web path: type from the **bytes** (`uploadKind`), image <= 8 MB, PDF <= 15 MB, HEIC refused with its message, URL through `parseSafeUrl` (SSRF rules), text <= 20,000 characters, one file per request.
- Request body size capped before reading (Content-Length and while streaming).

### Duplicates
The same `saveCapture` content hash and unique `(user_id, content_hash)` already used by the web: a retried upload returns the existing memory (`created: false`). An optional `Idempotency-Key` header is accepted and remembered for 24 hours.

### Rate limiting and abuse
- Per token: 30 requests/minute and 300/day, and 50 MB/day uploaded; per user across tokens: 1,000 memories/day; per IP (hashed): 120/minute for failed authentications. Limits live in Postgres (a counter table with a unique `(token_id, window)` upsert) so they survive restarts and multiple instances. Exceeding returns `429` with `Retry-After`.
- Repeated failures from one IP back off exponentially. A token that hits the daily cap is flagged in the audit table and shown to the owner.

### Revocation and lifecycle
- Settings page: list tokens (name, prefix, created, last used, expires), **Create**, **Revoke**. Revocation is immediate (checked on every request; no caching).
- Deleting the account cascades. "Revoke all" is one click. Changing the password does not revoke tokens by default (they are independent credentials), so the UI says so.
- The response to a suspected leak is documented: revoke, create a new one, check the audit list.

### Logging
Never log a token, an Authorization header, file bytes or content. Log token id, user id, outcome, size and kind only. Use the existing log redaction.

### Things that must stay true
RLS on every table unchanged. Private bucket unchanged (paths still start with the user id, storage policies unchanged). The approval gate for plans and actions is untouched: a capture token can only add a memory in `pending` state, which is then understood and shown to the user as a suggestion.

## Test plan (before any code merges)
- Token A cannot create under user B; revoked, expired, wrong-scope and malformed tokens all give the same `401`.
- Oversized body, wrong MIME, HEIC, SSRF URL, 21,000-character text, two files: each rejected with the right status and nothing stored.
- Duplicate upload returns the existing memory; the same file twice with different names too.
- Rate limits trigger at the documented numbers and reset; limits hold across two server instances.
- The service-role client is imported in exactly one module (build-time check).
- No response, log line or error contains the token or a hash of it.
- A pglite RLS test proves the capture tables cannot be read or changed by another user and that `token_hash` is never selectable by the owner.

## Open questions for the reviewer
1. Is sending **files** from a Shortcut worth introducing the service-role key to the app runtime? If not, stop at: Shortcut = links/text via the browser, native app = Option A.
2. Token lifetime and count limits (proposed 90 days, 5 tokens).
3. Where to host rate-limit counters if the app is deployed on several instances (Postgres as proposed, or the platform's edge limiter).
4. Whether an email notification should be sent when a token is created or hits its cap.
