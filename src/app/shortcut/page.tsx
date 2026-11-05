import type { Metadata } from "next";
import { headers } from "next/headers";
import { connection } from "next/server";
import { Suspense } from "react";
import { AikoSays } from "@/components/Aiko";
import { CardSkeleton } from "@/components/ui";

export const metadata: Metadata = { title: "Save to Acorn from iPhone" };

export default function ShortcutPage() {
  return (
    <div className="max-w-2xl space-y-8">
      <h1 className="sr-only">Save to Acorn from iPhone</h1>
      <AikoSays mood="curious" size={104} title="Save to Acorn from your iPhone">
        Safari can&apos;t put Acorn in the iPhone share sheet by itself. A small Shortcut can: it takes the link or text you share and opens it
        here, ready for you to save.
      </AikoSays>
      <Suspense fallback={<CardSkeleton count={1} />}>
        <Steps />
      </Suspense>
    </div>
  );
}

async function Steps() {
  await connection();
  const h = await headers();
  const host = (h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000").split(",")[0].trim();
  const proto = (h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https")).split(",")[0].trim();
  const origin = `${proto}://${host}`;
  return (
    <>
      <section className="rounded-3xl border-2 border-line bg-card p-5" aria-labelledby="addr">
        <h2 id="addr" className="font-display text-xl">Your Acorn address</h2>
        <p className="mt-1 text-sm text-ink-soft">Use exactly this in step 4. It is the address you are using right now.</p>
        <p className="mt-2 break-all rounded-xl bg-paper-deep px-3 py-2 font-mono text-sm" data-testid="shortcut-origin">{origin}</p>
        <p className="mt-2 text-sm text-ink-soft">The shortcut opens: <code className="break-all">{origin}/capture?url=&lt;link&gt;&amp;text=&lt;text&gt;</code></p>
      </section>
      <ol className="list-decimal space-y-3 pl-6 text-[15px]">
        <li>Open the <strong>Shortcuts</strong> app, tap <strong>+</strong> and name it <strong>Save to Acorn</strong>.</li>
        <li>Tap the <strong>i</strong> button, turn on <strong>Show in Share Sheet</strong>, and under <em>Share Sheet Types</em> keep <strong>URLs</strong>, <strong>Text</strong> and <strong>Safari web pages</strong> only.</li>
        <li>Add <strong>Get URLs from</strong> <em>Shortcut Input</em>, then <strong>URL Encode</strong> (set to <em>Encode</em>) on its result. Add <strong>Get Text from</strong> <em>Shortcut Input</em>, then <strong>URL Encode</strong> on that too.</li>
        <li>Add a <strong>Text</strong> action: <code className="break-all">{origin}/capture?url=</code> then the encoded URL, then <code>&amp;text=</code> then the encoded text.</li>
        <li>Add <strong>Open URLs</strong> and give it that text.</li>
      </ol>
      <p className="text-sm text-ink-soft">
        Then share a link from Safari (or text from any app), choose <strong>Save to Acorn</strong>, and tap <strong>Save</strong> on the page that opens.
        It never saves by itself. Full instructions, limits and checks are in <code>docs/cross-platform-capture-setup.md</code>.
      </p>
    </>
  );
}
