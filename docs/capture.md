# Capture, understanding and sharing

## How a save works
1. **Capture** (`POST /api/memories`, or the share sheet → `POST /share`): the input is validated, the original is stored
   (file first, then the database row) and the reply is sent. The memory is `pending`. Nothing a model does can lose it.
2. **Understand** runs after the reply (`after()`): `pending → processing → ready | failed`. A failure is written on the
   memory with a readable reason; the original is untouched.
3. **Retry**: "Understand it now" / "Try again" on the memory page (`POST /api/memories/:id {op:"process"}`; atomic claim,
   so two taps never run twice). A save still `pending` 10 s after the page opened is nudged once automatically.
4. **Duplicates**: the same content (same bytes, or same text/URL) returns the existing memory (`created: false`).
5. Pages that show a working memory refresh themselves every 2.5 s and stop after 3 minutes.

## Sharing from a phone
| Platform | Share a link/text/image/PDF *into* Acorn | How |
|---|---|---|
| Android, Chrome | Yes, once Acorn is installed ("Add to Home screen" / "Install app") | Web Share Target in `/manifest.webmanifest` → `POST /share` |
| iPhone / iPad, Safari | **No** (Safari does not implement Web Share Target) | Open Acorn, tap *Capture*, paste or pick a file; or a Shortcut that opens `/capture?url=…&text=…` (pre-fills the form; you tap Save) |

Requirements and limits:
- Installing a PWA and receiving shares needs **HTTPS** (or `localhost` on the same device). A phone cannot install
  `http://192.168.x.x:3000`; use a secure tunnel for the demo, or run Chrome on the same machine.
- You must be signed in. If not, the share lands on the login page and the shared content is **not** kept; share again after signing in.
- Some Android apps send a link in `text` instead of `url`; Acorn handles both. Shared files are checked by their bytes (PNG, JPEG, WebP, GIF, PDF).
- Share target support depends on the Android browser and version; verify on the demo device.

## Meta (one real image request)
```bash
AI_PROVIDER=meta AI_ENABLE_REAL_CALLS=true   # in .env.local, plus META_API_KEY
META_LIVE_IMAGE_CONFIRM=yes npm run meta:check:image
```
Sends the fictional sample job screenshot once (call budget forced to 1) and prints provider, model, title, content type,
fact counts, intent guess, latency and token usage. It refuses to run unless all four conditions are met.
