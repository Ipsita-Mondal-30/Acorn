import { describe, expect, it } from "vitest";
import { mockProvider } from "@/lib/ai/mock";
import type { ExtractInput } from "@/lib/ai/provider";
import { ExtractionOutput } from "@/lib/schema";

const now = new Date(2026, 9, 27); // Tue 27 Oct 2026, local time
const run = async (input: Omit<ExtractInput, "now">) => {
  const raw = { ...input, now };
  const out = ExtractionOutput.parse((await mockProvider.extractMemory(raw)).data);
  const source = [raw.text, raw.url, raw.originalName].filter(Boolean).join("\n");
  for (const e of out.evidence) expect(source).toContain(e.quote);
  for (const d of out.dates) expect(source).toContain(d.evidence);
  expect(out.title.length).toBeLessThanOrEqual(80);
  return out;
};

describe("mock extractor", () => {
  it("extracts a job listing with evidence", async () => {
    const out = await run({
      kind: "note",
      text: `Acme Robotics is hiring a Senior Backend Engineer
Location: Berlin (hybrid)
Requirements:
- 5+ years of experience with Postgres
- Strong TypeScript skills
- Experience running Kubernetes in production
Apply by Nov 12 at https://acme.example/careers/backend`,
    });
    expect(out.contentType).toBe("job");
    expect(out.job?.company).toBe("Acme Robotics");
    expect(out.job?.role).toBe("Senior Backend Engineer");
    expect(out.job?.location).toBe("Berlin (hybrid)");
    expect(out.job?.requirements).toHaveLength(3);
    expect(out.job?.applyUrl).toBe("https://acme.example/careers/backend");
    expect(out.job?.deadline).toBe("2026-11-12");
    const supports = out.evidence.map((e) => e.supports);
    expect(supports).toEqual(expect.arrayContaining(["company", "role", "deadline", "contentType"]));
    expect(out.nextActions.map((a) => a.kind)).toEqual(expect.arrayContaining(["apply", "review"]));
    expect(out.nextActions.some((a) => a.label === "Compare with my CV")).toBe(true);
    expect(out.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it("recognises a recipe", async () => {
    const out = await run({
      kind: "note",
      text: `Weeknight dal
Ingredients:
- 200g red lentils
- 1 tsp turmeric
- 2 cloves garlic
Simmer for 25 minutes, then cook the tadka.`,
    });
    expect(out.contentType).toBe("recipe");
    expect(out.title).toBe("Weeknight dal");
    expect(out.entities.filter((e) => e.kind === "ingredient").map((e) => e.name)).toEqual(["red lentils", "turmeric", "garlic"]);
    expect(out.nextActions[0].kind).toBe("cook");
    expect(out.job).toBeNull();
  });

  it("treats a technical screenshot caption as technical, but with low image confidence", async () => {
    const out = await run({
      kind: "image",
      text: "Postgres query plan — the missing index makes p99 latency spike",
      originalName: "explain-analyze.png",
      image: { bytes: new Uint8Array([0x89, 0x50]), mimeType: "image/png" },
    });
    expect(out.contentType).toBe("technical");
    expect(out.entities).toContainEqual({ name: "postgres", kind: "technology" });
    expect(out.nextActions[0].kind).toBe("learn");
    expect(out.confidence).toBeLessThanOrEqual(0.3);
    expect(out.uncertainties[0]).toMatch(/cannot read image pixels/);
  });

  it("resolves relative dates against now", async () => {
    const out = await run({ kind: "note", text: "Submit the visa form by next Friday" });
    expect(out.dates).toEqual([
      { date: "2026-10-30", label: "Deadline (next Friday)", isDeadline: true, evidence: "Submit the visa form by next Friday" },
    ]);
    expect(out.uncertainties.some((u) => u.includes("next Friday"))).toBe(true);
    expect(out.nextActions.some((a) => a.kind === "remind")).toBe(true);
  });

  it("parses absolute and other relative date forms", async () => {
    const out = await run({ kind: "note", text: "Dentist 2026-12-01\nTalk on 12 November 2026\ncall tomorrow\nreview next week" });
    expect(out.dates.map((d) => d.date)).toEqual(["2026-12-01", "2026-11-12", "2026-10-28", "2026-11-03"]);
  });

  it("is honest about an image with no caption", async () => {
    const out = await run({ kind: "image", originalName: "IMG_2041.jpg", image: { bytes: new Uint8Array([0xff, 0xd8, 0xff]), mimeType: "image/jpeg" } });
    expect(out.confidence).toBeLessThanOrEqual(0.15);
    expect(out.uncertainties).toContain("Demo mode cannot read image pixels; extraction based on caption/filename only.");
    expect(out.title).toBe("Image: IMG_2041.jpg");
  });

  it("finds a person to reconnect with", async () => {
    const out = await run({ kind: "note", text: "Reconnect with Priya Shah — she moved to Stripe" });
    expect(out.contentType).toBe("person");
    expect(out.entities).toContainEqual({ name: "Priya Shah", kind: "person" });
    expect(out.nextActions[0]).toEqual({ kind: "reconnect", label: "Reconnect with Priya Shah" });
  });

  it("does not invent anything for a URL in demo mode", async () => {
    const out = await run({ kind: "url", url: "https://example.com/blog/b-tree-internals" });
    expect(out.uncertainties.some((u) => u.includes("does not fetch"))).toBe(true);
    expect(out.job).toBeNull();
  });
});
