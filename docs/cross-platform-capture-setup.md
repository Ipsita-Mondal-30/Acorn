# Cross-platform capture: setup, limits and device checks

Read with `docs/platform-sharing-audit.md` (the audit) and `docs/capture-token-design.md` (the token design, not built).

**What has been verified:** automated tests (listed per feature) and, earlier, a few HTTP requests through a tunnel. **No real Android or
iPhone has been used for any of this.** Every item marked "needs a device" is unverified, and nothing here claims otherwise.

## 1. What changed in this round

| Change | Why | Verified by |
|---|---|---|
| A signed-out share is no longer redirected by the login proxy (only `POST /share`); the route saves nothing without a user and sends the person to sign in with the shared link/text carried to the capture form | the proxy used to drop the shared body | `tests/auth-proxy.test.ts` (real proxy, stubbed session), `tests/share-multi.test.ts` |
| Shared text and links survive sign-in without the old 2,000-character cut (text up to 20,000, link 2,000) | content loss | `tests/share-multi.test.ts`, `tests/capture-params.test.ts` |
| Several files in one share: each is validated on its own bytes and size, saved on its own, duplicates still collapse, at most 10 per share, and a summary says what was saved or skipped and why | Android can send many files; only the first was read | `tests/share-multi.test.ts` (12) |
| Every redirect is relative (share route, login proxy, auth callback and sign-out); sign-out compares the browser's real host, not the origin's own | behind a tunnel the app saw `https://localhost:3103` and sent phones there; sign-out would have refused a tunnel user | `tests/auth-proxy.test.ts`, `tests/share-android.test.ts`, `tests/cloud.test.ts` |
| HEIC photos get their own message instead of "unsupported type"; the capture form converts a HEIC to JPEG **on the device** when the browser can decode it (Safari can) and otherwise explains what to do | iPhone photos | `tests/share-multi.test.ts`, `tests/mobile-capture.test.tsx` |
| `apple-touch-icon` (180 px PNG), manifest `id`/`lang`/`categories`, `viewport-fit=cover`, matching colours | iPhone Home Screen icon and standalone mode | `tests/pwa-ios.test.ts` |
| Mobile form: link box without auto-capitalise/correct, Go key, 16 px text; **Paste from clipboard** button; voice recorder resumes iOS's suspended audio context and supports the prefixed constructor | Safari behaviour | `tests/mobile-capture.test.tsx` |
| `/shortcut` page and this guide for the iPhone Shortcut; `/capture` pre-fill logic moved to a tested function | iOS has no share target | `tests/capture-params.test.ts` |
| Capture-token **design** (decided not to build; native uses the user's Supabase session instead) | security review first | `docs/capture-token-design.md` |

## 2. Android (Chrome): set up

Requirements: an **HTTPS** address (a deployed domain or a tunnel), the Chrome browser, and the app **installed**.
1. Open your Acorn address in Chrome.
2. Chrome menu, **Install app** (or **Add to Home screen**). Only an installed app is offered in the share sheet.
3. From another app, share a link, some text, a screenshot or a PDF and pick **Acorn**. Share several images at once to save them all.
4. You land on the saved item (one share) or on **Memories** with a note like "Saved 3 items from your share. Skipped 1: it isn't a PNG, JPEG, WebP, GIF or PDF" (several).
Needs a device: whether Chrome installs Acorn **without a service worker** (there is none; if only a shortcut is offered, a minimal service worker is the known fix), and which apps show Acorn in their share sheet.

## 3. iPhone: what works and what does not

- Installing Acorn to the Home Screen does **not** add it to the iPhone share sheet. iOS Safari has no Web Share Target. Acorn makes no such claim.
- What works without anything extra (needs a device to confirm): open Acorn in Safari or from the Home Screen, tap **Capture**, then **paste** (there is a *Paste from clipboard* button), pick an image or PDF from Photos or Files, or record a voice note.
- HEIC: the Photos picker normally hands Safari's upload a JPEG. If a HEIC reaches the form, Safari converts it to JPEG on the device; any other browser tells you what to do. The server never converts HEIC.
- Signing in: a Home Screen app and Safari keep **separate** sessions on iOS, so sign in in whichever one you use.

### The "Save to Acorn" Shortcut (links and text)

This is the interim way to put Acorn in the share sheet. It needs **no token**: the Shortcut opens your Acorn capture page in Safari with the shared content filled in, and you tap **Save**. It never saves by itself.

The same steps are shown, with your own address filled in, at **`/shortcut`** in Acorn. Action names below are from memory of the Shortcuts app and can differ slightly between iOS versions; each action has a plain-language equivalent. **The Shortcut was not built or run on a device while writing this.**

1. Shortcuts app, **+**, name it `Save to Acorn`.
2. Tap **i** (details): turn on **Show in Share Sheet**; under **Share Sheet Types** leave only **URLs**, **Text** and **Safari web pages**. Leave "If there's no input" as *Continue* or choose *Ask for Text* so it can also be run on its own.
3. Add **Get URLs from Input** (input: *Shortcut Input*). Add **URL Encode** and give it that result, **mode: Encode**. Name the result `link`.
4. Add **Get Text from Input** (*Shortcut Input*) then **URL Encode** (*Encode*). Name the result `words`.
5. Add a **Text** action containing exactly `https://YOUR-ACORN-ADDRESS/capture?url=` + `link` + `&text=` + `words`. (Use the address `/shortcut` shows you.)
6. Add **Open URLs** with that Text as input.

Notes that matter:
- The encoding step must be **URL Encode**, not "Replace Text". An unencoded `&`, `#` or `+` would cut or change the content. `tests/capture-params.test.ts` pins how the page reads encoded `& = # + " é ☕ 🙂`, line breaks and 15,000-character text.
- The page keeps up to 20,000 characters of text and 2,000 of a link. Longer text is cut at that limit, visibly, in the box before you save.
- "Success or failure": the Shortcut only opens the page. Success is the **Save** tap, which shows "Yay! I saved that for you" and opens the memory. If Safari shows a login page, sign in; the link/text come back after sign-in. Shortcuts cannot report whether Acorn saved it.
- Sharing from Instagram gives a link; Acorn saves the link and your note but cannot read a private post. Screenshot the post and use the picker for the content itself.
- Sharing an **image or PDF** to this Shortcut is **not supported yet**: it needs the capture-token endpoint (design only). Use the file picker.

### Known limitations
- No native iPhone share-sheet entry without a Shortcut, an app, or a native Share Extension.
- No device verification of anything on this page.
- Files from a Shortcut: **not planned.** Decision: no capture-token endpoint. iPhone files go through the in-app picker now, and through a native Share Extension (section 5) later.
- Only the first 10 files of one Android share are saved.
- A shared file cannot survive a sign-in (it is held only in that request); the person is told to share it again. Links and text do survive.
- The capture token system, rate limiting and a settings page for tokens do not exist.

## 4. Manual device tests (to be done; none done yet)

Record device model, OS and browser version for each result.

**Android (Chrome, HTTPS address)**
1. Install: **Install app** offered? If only *Add to Home screen*, note it.
2. Share a page link from Chrome; a text selection with and without a link; a Gallery screenshot; a PDF from Files. Each ends on the right memory.
3. Share 3 images at once: one summary banner, 3 memories. Share 2 images + a `.docx`: 2 saved, banner says 1 skipped.
4. Share the same image twice: one memory, banner or page says nothing was duplicated.
5. Cloud mode, signed out: share a link; sign in; the capture form shows the link. Share an image signed out: after sign-in you are told to share again.
6. Airplane mode, share: a clear failure, nothing lost on the phone.
7. Voice: record 10 s, listen back, discard, record again, transcribe.

**iPhone (Safari, then Home Screen)**
1. Add to Home Screen: icon is the green acorn (not a page screenshot), name "Acorn", opens full screen, no browser bar; content clears the notch and home bar.
2. Confirm Acorn is **not** in the share sheet (expected).
3. Capture: paste a link (Paste from clipboard shows Safari's *Paste* prompt), paste text, pick a Photos image (note whether the upload is JPEG or HEIC), pick a Files PDF.
4. Build the Shortcut above. Share a Safari page: Safari opens `/capture` with the link filled in; nothing is saved until you tap Save. Repeat with text containing `&`, `#`, `+`, emoji and a paragraph break; with ~5,000 words.
5. Voice: record, listen back, transcribe; check the microphone prompt and what happens if the screen locks mid-recording.
6. Signed out: run the Shortcut; sign in; the content is still in the form.

## 5. Future native Share Extension (architecture)

Only if the Shortcut proves too clumsy. One backend stays; the iPhone gets a small native layer.
- **Targets:** an iOS app (or an Expo development build with a share-extension plugin) plus a **Share Extension** target; an **App Group** shared by both; Apple Developer Program membership, signing, TestFlight.
- **Auth (Option A in the token design):** the app signs in with Supabase and stores the session in the **Keychain** (shared with the extension through a keychain access group). The extension sends the Supabase access token as `Authorization: Bearer`; the server builds its Supabase client with it, so RLS and storage policies apply exactly as on the web. No capture token and no service-role key are needed.
- **Capture:** the extension accepts URLs, text, images and PDFs, converts HEIC to JPEG on device, writes the payload to the App Group container and uploads with a **background `URLSession`** (extensions have tight memory limits and exit quickly), to the same validated endpoints (`/api/memories`). The containing app finishes or retries and shows status.
- **Backend change:** accept a bearer user token on the existing capture endpoints (one small change in the server Supabase client); nothing else.
- **Effort:** about 1 to 2 weeks plus device and store work. Sources and cautions are in the audit.
