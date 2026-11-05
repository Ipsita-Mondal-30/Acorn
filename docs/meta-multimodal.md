# Meta multimodal integrations

Acorn uses three more Meta models beside Muse Spark. All calls are server-side, go through the one Meta client
(`src/lib/ai/meta-client.ts`: same key, base URL, call budget, retries, logging), and are gated by the same locks as before:
`AI_PROVIDER=meta`, `META_API_KEY`, `AI_ENABLE_REAL_CALLS=true`, and `ACORN_MAX_MODEL_CALLS`.
In demo mode nothing is sent anywhere, and every demo result says it is a stand-in.

| Feature | Model | Endpoint (docs read 2026-11-05) | Request | Where |
|---|---|---|---|---|
| Voice notes | `muse-voice-transcribe-1.0` | `POST /v1/asr/transcribe` | `multipart/form-data`: `request` (JSON: model, audioEncoding `WAV`, mode `PUSH_TO_TALK`, optional `languageBias`) + `audio` (mono 16-bit PCM WAV, 16 or 24 kHz, <= 10 min / 32 MB). `Accept: application/json` -> `{sessionId, transcript, audioDurationMs, turns}` | `src/lib/ai/transcribe.ts` |
| Visual aid | `muse-image-1.0` | `POST /v1/images/generations` | JSON: `model`, `prompt`, `n: 1`, `size: "1792x1024"` (an aspect ratio), `response_format: "b64_json"`, `output_format: "png"`. Billed $0.01 per image | `src/lib/ai/image.ts` |
| Explore image | `sam-3.1` | `POST /v1/responses` | JSON: one user message with `input_text` (a short noun phrase) and `input_image` (data URL), `stream: true`, `store: false`, `metadata.include_confidence: "true"`; `Accept: text/event-stream`. Boxes come back as `<id><\|box;x1=..;y1=..;x2=..;y2=..;w=..;h=..;c=..\|>` in source pixels | `src/lib/ai/sam.ts` |
| Read a region | `muse-spark-1.3` | `POST /v1/chat/completions` (existing) | the image plus the region's pixel box; JSON-schema output | `src/lib/ai/region.ts` |

## How it fits the memory system

Things the models make are stored as **artifacts** (`src/lib/artifacts.ts`, table `public.artifacts`), separate from a memory's
source and facts so a generated picture or a transcript can never be mistaken for evidence. Each artifact records the
provider and model, status (`processing` / `ready` / `failed`), attempts, a short safe error, latency, usage when returned,
its input/output metadata, the memory it belongs to, and (for readings) the segmentation it came from. A row is written
**before** the model is called, so a timeout leaves a visible record with Retry.

- **Voice:** record in the browser (WAV is encoded client-side), preview, discard or transcribe. The original audio is kept in
  private storage. The transcript is editable; **Save as a memory** creates a normal note memory that Muse Spark reads like
  any other, so Acorn only *suggests* an intention. Nothing is confirmed and no date is invented ("this week" is not a date).
- **Visual aid:** a button on the memory page (never automatic). The prompt contains only the memory's own title, summary,
  extracted statements and bullet points, and instructs the model to add nothing else. The image is stored privately, shown as
  "AI-created illustration / Not source evidence", and regenerating keeps earlier ones.
- **Explore image (hidden by default):** the panel is shown only when `ACORN_ENABLE_EXPLORE_IMAGE=1`, because SAM 3.1 returned no regions in two live checks. SAM only says *where*. Boxes are drawn over the **original** image (it is never altered). The user picks a
  region, Muse Spark reads it ("AI-read, not verified"), and only **Save as a linked memory** stores it.
- **Today with Acorn** (`/today`, and the list on Home): built from persisted memories, plans, reminders and artifacts. Every
  entry has a "Why:" line. Nothing is invented; approvals stay with the user.
- **Meta model usage** (`/usage`): one row per stored model use with provider, model, status, duration, tokens when returned,
  attempts and error kind. Demo stand-ins are labelled and never counted as Meta. It is not a bill.

## Demo mode (no network, no key)

Voice gives an empty transcript (the user types what they said); images are a labelled SVG diagram drawn from the same
statements; SAM and region reading work only for Acorn's built-in sample screenshots, using hand-measured fixture boxes
(`src/lib/ai/sam-fixtures.ts`) and the sample's known text. None of it is shown as a Meta result.

## Not done / limits (be honest)

- SAM **masks** are not decoded or drawn (the base85 raster format needs a decoder that is not in this repo); boxes only.
- Segmentation uses `stream: true` as documented; the non-streaming response shape is not documented, so it is not used.
- Chat Completions image input and this file's request shapes are covered by tests with a stubbed `fetch`; **none of the three
  new endpoints has been called live** (no paid request was authorised). See the verification list in the final report.
- Image generation can take a minute or two; it runs inside the request (no job queue), with a 150 s client timeout.
- Recordings are capped at 5 minutes (the API allows 10) and 10 MB.

## Database

`supabase/migrations/20261105000000_meta_artifacts.sql` adds `artifacts` (RLS, same-user foreign keys) and lets the private
bucket hold `audio/wav` and `image/svg+xml`. Rollback: `supabase/rollback/20261105000000_meta_artifacts.down.sql`.
**It has not been applied to any database.** Apply it deliberately, as with the earlier migrations.

## Environment

No new variables are required. Existing, optional: `META_IMAGE_MODEL` (default `muse-image-1.0`), `META_TRANSCRIPTION_MODEL`
(`muse-voice-transcribe-1.0`), `META_SEGMENTATION_MODEL` (`sam-3.1`), `META_TIMEOUT_MS`.

## First live check (needs approval: each is a paid request)

Per the pricing page: transcription $0.18/hour (a 10-second clip is about half a cent), image $0.01, SAM $2.50 per 1,000 images,
plus Muse Spark tokens for the region reading. Suggested single-request checks, in this order: one 10-second voice note, one
visual aid, one SAM search on the sample job screenshot, then one region reading.
