# The demo journey: capture → understand → remember → recommend → approve → follow through

One flow, in demo mode, with no network and no key. It is pinned by `tests/demo-journey.test.ts` and was walked through in a browser.

## Run it

```bash
npm run demo            # http://localhost:3200 (add -- --port 3300 to change it; add -- --prod after `npm run build` for a production build)
```

`npm run demo` forces every paid or outward path off whatever `.env.local` says (mock provider, real calls off, call budget 0, no model key,
no embeddings, no email, local storage), keeps its data in `.demo-data/` (your own `.data/` is never touched), and turns on the replay below
when the saved real result file exists. It prints what is real and what is not when it starts.

**Reminders that fire.** A reminder is delivered by the scheduler. In the demo, run `npm run demo:tick` (it calls the same `/api/cron/tick` a
scheduler would, with a secret generated in `.demo-data/`). Create a reminder whose time has passed or is a minute away, run the tick, and it
appears in the **Inbox**. Email is never sent in demo mode.

**Search queries that work on the demo data:** the six "Try" suggestions under the search box (pinned by `tests/search-examples.test.ts`),
and for the real job listing "job listing about Kafka and PostgreSQL". Search matches by words, not meaning: a question phrased with none of
the saved words honestly returns "No reliable match".

`ACORN_DEMO_REPLAY=1` is opt-in and demo-only. It replays the SAVED result of the one real Muse Spark 1.3 request that was verified live
(`artifacts/meta-live/2026-11-03T17-55-24-748Z-ok.json`, git-ignored) when, and only when, Acorn's built-in job-listing screenshot is
saved. The memory then shows "Read by Meta muse-spark-1.3", the real latency and token counts, and a "Saved result, replayed" note.
No request is made. Every other item is read by the mock and says so. Without the file, replay refuses with a clear error.

## Steps (each one persists, and each says what it is)

1. **Voice.** Capture → Voice → record → stop → listen back or discard → Transcribe. Demo mode does not listen: the transcript box is
   empty and says so; type "I want to learn Redis, build a project around it and finish it this week." → *Save as a memory*.
   (With a key and real calls on, the same screen uses Muse Voice Transcribe: verified live once with synthetic speech.)
2. **Muse Spark extraction as evidence.** Capture → Image → Try a sample → *Job listing screenshot*. The memory shows the real extraction
   (company, role, four requirements, deadline 15 Jan 2027, nine facts with their quotes). All nine are labelled **AI-read, not verified**.
3. **Related memories.** Open that memory: *What Aiko noticed* connects it to earlier memories that mention PostgreSQL and Kafka, with the
   reason for each link. Nothing is planned or decided by this.
4. **Today.** Home (and `/today`) lists what needs you, unfinished learning, deadlines, unfinished intentions and what was noticed. Every
   line has a "Why:". The voice memory appears as a question ("Acorn guessed... waiting for your answer"), not as a plan.
5. **Decide and approve.** Open the voice memory → *Yes, learn it* → *Make a plan* → *Approve and run*. Nothing runs before approval.
6. **Learn and follow through.** The study pack is built from the memory's own facts (Acorn's deterministic engine, not a model). Mark a
   card known, tick a question, pick the revision date (Acorn never picks one). Today now says "Continue learning" with the progress.
7. **Visual aid.** On the same memory: *Create visual aid*. In demo mode a labelled diagram is drawn by Acorn; with real calls on, Muse
   Image draws it from the same statements. Either way it is shown as AI-created and not source evidence, titled with the memory's real
   title, and never replaces or edits the memory's facts.

## What is real and what is not

| Part | Status |
|---|---|
| Muse Spark reading of the job screenshot | Real result, saved from one live request; **replayed** here, not re-run |
| Muse Voice Transcribe, Muse Image | Each verified live once; **not** run in this demo (mock stand-ins, labelled) |
| SAM 3.1 | Two live attempts returned no regions. **Not part of this demo** and not shown in the screenshot flow |
| Region reading with Muse Spark | Not attempted live |
| Related memories, Today, plans, reminders, study pack | Real Acorn logic over stored data (no model) |
| A full live Meta flow end to end | **Not verified.** Do not claim it |

## Phone demo

Nothing on a phone has been verified. To try it: run `npm run demo -- --prod`, then expose it yourself with a tunnel
(`cloudflared tunnel --url http://localhost:3200`). The tunnel makes the login-free demo reachable by anyone with the address, so stop it
when done. Steps and device checks are in `docs/cross-platform-capture-setup.md`.

## Sample data

Acorn's local store starts with built-in sample memories (a passport form, a Lumen job, a recipe...). Today and Home mark anything that
comes from them with a **Sample** tag, list your own items first, and leave them out of the "N things need you" greeting.

## Android sharing

The installed web app registers as an Android share target (links, text, screenshots, PDFs); the handler is covered by
`tests/share-android.test.ts` (including duplicates, signed-out and failed processing). It needs HTTPS to install on a phone, and it has
**not** been tried on a real phone. **iOS share sheet support is not verified and is not claimed** (iOS does not support web share targets
for installed web apps in the same way).
