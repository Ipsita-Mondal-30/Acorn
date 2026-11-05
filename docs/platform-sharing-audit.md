# Platform sharing audit: Android and iOS

Audit only. No application code, `.env.local` or Supabase data was changed, no tunnel was started for it, and no device was available.
**Nothing below is "device verified".** Statuses say exactly what kind of evidence exists.

Evidence levels used: **Implemented** (code exists) · **Automated-test verified** (a test in this repo passes) · **Browser verified** (seen working in a real
desktop browser or over HTTP through the earlier tunnel) · **Device verified** (tried on a real phone: none yet) · **Unsupported** (the platform cannot do it) ·
**Requires implementation** (not built).

## 1. What exists today

| Piece | Where | What it does |
|---|---|---|
| Manifest | `src/app/manifest.ts` | name, `start_url: /`, `display: standalone`, 192/512 PNG icons from `/pwa-icon/[size]`, theme `#5f9340`, and `share_target` (see below) |
| Share target | same file | `POST /share`, `multipart/form-data`, params `title`, `text`, `url`, and one file field `file` accepting png/jpeg/webp/gif/pdf |
| Share handler | `src/app/share/route.ts` | saves first (original stored), queues understanding with `after()`, replies `303` to `/memories/:id?saved=1`. Errors go to `/capture?share=empty|type|large|failed|signin`. Redirects are **relative** (fixed after a tunnel test showed absolute ones pointed phones at `localhost`) |
| Text/link parsing | `src/lib/share.ts` | Android often puts the link in `text`; a safe http(s) URL there becomes a link capture, the shared words are kept, nothing invented |
| Capture page | `src/app/capture/page.tsx`, `CaptureForm.tsx` | paste, link, file picker (image/PDF), voice; `/capture?url=&text=&title=` pre-fills and **never saves by itself** |
| Validation | `src/lib/uploads.ts` | type from the **bytes** (never name or declared MIME); images <= 8 MB, PDFs <= 15 MB; png/jpeg/webp/gif/pdf only |
| Duplicates | `src/lib/process.ts` `saveCapture` | content hash (text, URL, or file bytes): the same share returns the existing memory; processing is claimed atomically so the model reads it once |
| Auth (cloud) | `src/proxy.ts`, `supabase/user.ts` | session **cookies** only. Signed-out page requests (including `/share`) are redirected by the proxy to `/login?next=<path>`; `/api/*` answers 401 |
| Persistence | Supabase store + RLS | every row and file is per user (`user_id`, RLS, same-user foreign keys, storage policies by folder) |
| Service worker | **none** | no `serviceWorker` registration, no `sw.js` |
| iOS meta | `layout.tsx` | `appleWebApp: { capable: true, title: "Acorn" }`; **no `apple-touch-icon` link** |
| API tokens | **none** | no bearer-token or API-key authentication anywhere |

Facts that matter later:
- Only one file is read from a share (`form.get("file")`). Android can send several; the rest are dropped silently.
- Signed-out share in **cloud mode**: the proxy intercepts the POST before the route runs, redirects to `/login?next=%2Fshare`, and the shared body is lost. The route-level handling that carries a shared link through sign-in (`signInThenCapture`) is only reached if the proxy let the request through but storage then refused it. **Gap: a signed-out cloud share loses its content.** (Local demo mode has no login, so the tests do not show this.)
- The proxy's own login redirect is built from `request.nextUrl`, so behind a tunnel or proxy that rewrites `Host` it can have the same "localhost" problem the share route had. A real deployed host is unaffected. Not yet observed, only inferred from the code.
- iOS photos are HEIC by default. Acorn rejects HEIC ("type"). Safari's file picker usually converts to JPEG for web uploads; a Shortcut or native extension sending the raw file would be rejected unless it converts first.
- Instagram posts are login-walled: Acorn saves the link and the user's note but cannot read the post (`src/lib/platforms.ts`). That is by design and honest.

## 2. Android (Chrome)

| Question | Answer |
|---|---|
| Implemented | Web Share Target for links, text, images, PDFs; installable manifest; duplicate handling; failure redirects; pending indicator on the memory page |
| Automated-test verified | `tests/share-android.test.ts` (15) and `tests/capture-flow.test.ts`: manifest shape, link in `text`, plain text, screenshot stored untouched with caption, PDF, mislabelled file type, empty/oversized, duplicate link and image (one memory, one reading), signed-out redirect for the route-level path, processing failure kept as `failed`, relative redirects behind a proxy |
| Seen over HTTP | A tunnel to a production build answered manifest, icon, `GET /share` and `POST /share` correctly (checked with curl, not a browser share) |
| Needs HTTPS | Yes. Install and the share target only work on an HTTPS origin (localhost is exempt on the same device only) |
| Needs installation | Yes. Android lists a web app in the share sheet only once it is **installed** (WebAPK), not as a browser bookmark |
| Needs a real device | Installability without a service worker (Chrome's install criteria have changed over time; unverified), Acorn appearing in the share sheet, each source app (Chrome, Instagram, Gallery, Files) sending what the tests assume, multiple-file shares, share while signed out |
| Known gaps | signed-out cloud share loses content (above); multiple files dropped; no service worker (fallback: add a minimal fetch handler if Install app is missing) |

## 3. iOS (Safari, Home Screen web app)

**iOS Safari does not support Web Share Target**, so the manifest `share_target` does nothing there and Acorn will **not** appear in the native share sheet.
Installing the web app (Add to Home Screen) does not change that. WebKit's request for it is open and unassigned
([WebKit bug 194593](https://bugs.webkit.org/show_bug.cgi?id=194593); a late-2025 research note reaches the same conclusion:
[Web Share Target for iOS PWAs](https://tangled.org/zzstoatzz.io/plyr.fm/blob/main/docs/research/2025-12-19-web-share-target-ios-pwa.md)).
I found no sign that has changed; recheck before relying on it.

| Capability | State on iOS |
|---|---|
| Add to Home Screen, standalone | The manifest and `appleWebApp` meta are present. Needs a device. Add an `apple-touch-icon` link to be safe (currently only manifest icons) |
| Share a link from Safari | **Unsupported** natively. Interim: Apple Shortcut that opens `/capture?url=...&text=...` (pre-fills; the user taps Save; uses the existing signed-in Safari session, no token needed) |
| Share Instagram content | Instagram shares a link: same as above, and Acorn cannot read the post. Saving the image to Photos, or taking a screenshot, then using the file path is the reliable route |
| Share an image from Photos / a PDF from Files | **Unsupported** as a share target. Options: in-app **file picker** (Photos / Files via the capture page: implemented, device unverified, HEIC is normally converted by Safari); or a Shortcut posting the file, which needs a token endpoint and a "Convert Image to JPEG" step |
| Copy/paste capture | Works: paste into the capture box. Browser-level only, device unverified |
| Voice recording | Implemented with `getUserMedia` + WebAudio (works in Safari and Home Screen apps on current iOS, needs a user tap, microphone permission, HTTPS). Device unverified |
| Apple Shortcuts | **Feasible, not built.** Shortcuts run their own network stack and **do not share Safari's cookies**, so posting to `/api/memories` needs token auth, which does not exist. Shortcuts can appear in the share sheet ("Show in Share Sheet", input types such as URLs, images, PDFs); shortcuts launched from the share sheet have limited memory, so large files can fail ([Apple's Shortcuts guide](https://support.apple.com/guide/shortcuts/apd7644168e1/ios)). A multipart upload from a Shortcut is reported to work but I found no Apple documentation of the exact settings: test on a device |
| Native Share Extension | Possible, **needs a separate iOS app target** (App Extension), Apple Developer Program membership, signing and TestFlight/App Store distribution, and a way to authenticate to the backend (see section 6). The extension should write the payload to an **App Group** container and upload with a background `URLSession` task, because extensions have tight memory limits and exit quickly ([discussion of the pattern](https://developer.apple.com/forums/thread/706218)). It talks to the same Next.js backend over HTTPS |

## 4. Compatibility matrix

| Feature | Android Chrome | iOS Safari | Status | Requirements |
|---|---|---|---|---|
| Installable web app | Yes, expected | Add to Home Screen | Implemented; **device unverified** on both | HTTPS; add `apple-touch-icon` (iOS); service worker may be needed (Android, unverified) |
| Listed in native share sheet | Yes after install | **No** | Android: Implemented + automated-test verified (handler only), device unverified. iOS: **Unsupported** | Android needs install + HTTPS |
| Share a URL | `POST /share` | Shortcut opening `/capture?url=` | Android: Automated-test verified. iOS: Requires implementation (the Shortcut itself; the target page exists) | Shortcut built on a device |
| Share plain text | `POST /share` | Shortcut -> `/capture?text=` | Android: Automated-test verified. iOS: Requires implementation | as above |
| Share a screenshot / image | `POST /share` file | File picker only; Shortcut needs token endpoint | Android: Automated-test verified. iOS picker: Implemented, device unverified. iOS share: Requires implementation | Token endpoint + JPEG conversion (Shortcut) |
| Share a PDF | `POST /share` file | File picker; Shortcut needs token endpoint | Android: Automated-test verified. iOS: as above | same |
| Instagram | link via share sheet; post unreadable by design | link via Shortcut; screenshot/image via picker | Implemented (honest limits); device unverified | none new |
| Copy/paste | Yes | Yes | Implemented; Browser verified on desktop | none |
| Voice recording | Yes | Yes, in Safari/Home Screen | Implemented; Browser verified on desktop Chrome with a synthetic microphone; **device unverified** | HTTPS, mic permission |
| Duplicate prevention | Yes | Yes (same backend) | Automated-test verified | none |
| Signed-out sharing | Route handles it; **proxy intercepts first in cloud mode and drops the shared content** | n/a (no share) | **Requires implementation** | let `/share` through the proxy, or carry params through login |
| Multiple files in one share | Only the first is read | n/a | **Requires implementation** (decision: read all or tell the user) | small change |
| Token auth for Shortcuts / native extension | n/a | needed | **Requires implementation** | see below |
| Native iOS share extension | n/a | none exists | **Requires implementation** | Apple developer account, app target |

## 5. Missing components (ordered by value and effort)

1. **Signed-out share fix (small).** Exclude `/share` POST from the proxy's login redirect (the route already answers with a login redirect that preserves a link/text) or carry the shared fields through `next`.
2. **`apple-touch-icon` link and an install hint for iOS (small).**
3. **A capture token for non-browser clients (medium, security-sensitive).** A per-user revocable token (hashed at rest, shown once, scoped to "capture only") accepted as `Authorization: Bearer` on one endpoint, e.g. `POST /api/capture`, which must resolve to the token's user and keep every RLS/ownership guarantee (no service-role shortcut that skips them). Needed by both Shortcuts-with-files and any native extension.
4. **A published "Save to Acorn" Shortcut (small once 3 exists):** share-sheet input URLs/text/images/PDFs, convert images to JPEG, `Get Contents of URL` POST to `/api/capture`, show the result. A zero-token variant exists today for links and text only (open `/capture?url=...`).
5. **Minimal service worker (small, conditional):** only if Chrome on a real device will not install Acorn without one.
6. **Native shell (large, optional):** see below.

## 6. Architectures compared

| Option | Android | iOS share sheet | Backend change | Effort | Verdict |
|---|---|---|---|---|---|
| 1. Existing PWA | Good (after device check) | None; manual paste/picker only | none | done | Not enough for iOS |
| 2. PWA + Apple Shortcuts | PWA share target | Share-sheet entry via a Shortcut; links/text today, files after the token endpoint | one token endpoint (3) | 1 to 3 days plus device testing | **Best fast option** |
| 3. Expo / React Native app with a share extension | Native intent | Native share extension (e.g. `expo-share-intent`: needs a custom dev client, not Expo Go, and a prebuild step) | token/auth + same endpoint | 1 to 2+ weeks, Apple developer account, TestFlight; would duplicate the UI or wrap the web app | Good only if a store app is wanted anyway |
| 4. Separate native iOS Share Extension (Swift) | n/a | Native, most reliable, files via App Group + background upload | same token endpoint | 1 to 2 weeks, Xcode project, signing, ongoing iOS maintenance | Most reliable, most work, no code reuse |

Dependencies for 3 and 4: Apple Developer Program, an iOS device, a token endpoint or a native Supabase sign-in (shared Keychain access group between app and extension), HTTPS backend on a stable domain.

## 7. Recommendation

**One backend, two capture paths, no rewrite.**

1. Keep the PWA as the product and the **Android** path (share target). Fix the signed-out gap, then verify on a real phone.
2. **iOS now: PWA + a Shortcut.** Phase A (no backend change): a Shortcut that opens `/capture?url=&text=` for links and text, plus the in-app file picker for Photos and Files. Phase B: add the capture-token endpoint and extend the Shortcut to send images and PDFs.
3. Build a **native Share Extension only if** Shortcuts prove too fiddly for users. When that day comes, reuse the same token endpoint (option 4 for the smallest footprint, option 3 only if a full app is wanted).

For the sources you named: **Instagram** (a link on both platforms; Acorn saves the link and your note and cannot read the post: screenshot it if the content matters), **Chrome** (link: Android share target, iOS Shortcut), **Gallery/Photos** (Android share target; iOS picker, then Shortcut with the token), **Files** (same).

## 8. Manual device tests (none done yet)

Android (Chrome, a real phone, HTTPS URL):
1. Open the URL; confirm the manifest is detected (Chrome menu shows **Install app**, not only **Add to Home screen**). If only a shortcut is offered, record that and add a service worker.
2. Install. From Chrome, share a page: Acorn is in the sheet; you land on the memory with "Waiting to be understood", then it updates.
3. Share selected text (with and without a link), a screenshot from Gallery, a PDF from Files, and an Instagram post link ("Share to..."). Check each memory's kind, caption and original.
4. Share the same link twice: one memory. Share two images at once: note what happens (expected: only the first).
5. Sign out (cloud mode), share a link: record whether the link survives sign-in (expected today: it does not).
6. Turn on airplane mode, share: record the failure message.
7. Voice: record 10 s, listen back, discard once, transcribe once.

iPhone (Safari, then Home Screen app, HTTPS URL):
1. Add to Home Screen; open it standalone; check the icon and name.
2. Confirm Acorn is **not** in the native share sheet (the expected result).
3. Capture: paste a link, paste text, pick a Photos image (record the file type sent: HEIC or JPEG), pick a PDF from Files.
4. Shortcut A (links/text): build it, share a Safari page, confirm `/capture` opens pre-filled and nothing saves until you tap Save.
5. Voice: record, listen back, transcribe; check the microphone prompt and what happens if the screen locks.
6. After the token endpoint exists: Shortcut B from Photos, Files and Instagram; check a large PDF (memory limit) and a HEIC photo (conversion).

Record device model, OS and browser version for every result.
