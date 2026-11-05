import { describe, expect, it } from "vitest";
import type { Memory } from "@/lib/schema";
import { isPlaceholderTitle, memoryTitle, mockDiagramSvg, visualAidPrompt, visualAidSource } from "@/lib/visual-aid";

// Offline only: no model is called. These pin what a Muse Image prompt may contain, which was the source of two defects found
// in the live check (a placeholder "Untitled" heading and an arrow between items no statement connected).

const NOTE = `Learn Redis caching
- allkeys-lru evicts the least recently used keys when memory is full
- volatile-ttl evicts the keys that will expire soonest
- maxmemory sets the memory limit for the dataset
- Cache-aside reads the cache first, then falls back to the database
I want to learn how these fit together.`;

const mem = (over: Partial<Memory> = {}, text: string | null = NOTE): Memory => ({
  id: "m1", createdAt: "2026-11-05T00:00:00Z", updatedAt: "2026-11-05T00:00:00Z", status: "ready", contentHash: "h", extraction: null, overrides: {}, isSample: false,
  source: { kind: "note", ...(text !== null ? { text } : {}) }, ...over,
});

describe("title selection", () => {
  it("never returns a placeholder, and prefers what the user set, then the reading, then what they wrote", () => {
    expect(["Untitled", "untitled note", "  ", "Note", "Screenshot", "image", "(none)", "---"].every((t) => isPlaceholderTitle(t))).toBe(true);
    expect(isPlaceholderTitle("Redis eviction")).toBe(false);
    expect(memoryTitle(mem({ overrides: { title: "My Redis notes" } }))).toBe("My Redis notes");
    const read = mem({ extraction: { title: "Redis caching basics", dates: [] } as unknown as Memory["extraction"] });
    expect(memoryTitle(read)).toBe("Redis caching basics");
    expect(memoryTitle(mem())).toBe("Learn Redis caching"); // the first line of the note, not a bullet
  });
  it("skips a placeholder title from the reading and falls back to something real", () => {
    expect(memoryTitle(mem({ extraction: { title: "Untitled", dates: [] } as unknown as Memory["extraction"] }))).toBe("Learn Redis caching");
    expect(memoryTitle(mem({ source: { kind: "url", url: "https://www.example.com/guides/redis" } }, null))).toBe("example.com/guides/redis");
    expect(memoryTitle(mem({ source: { kind: "image", originalName: "redis-cheatsheet.png" } }, null))).toBe("redis cheatsheet");
  });
  it("is null when the memory has no real title at all", () => {
    expect(memoryTitle(mem({}, null))).toBeNull();
    expect(memoryTitle(mem({}, "- just a bullet"))).toBeNull();
  });
});

describe("grounding: the picture can only be drawn from what the memory holds", () => {
  it("collects the user's bullets, extracted facts and study-pack notes, clipped and without duplicates", () => {
    const m = mem({ extraction: { title: "Redis", summary: "How Redis evicts keys.", dates: [], facts: [{ statement: "maxmemory sets the memory limit for the dataset", quote: "q", page: null, checked: false }, { statement: "short", quote: null, page: null, checked: false }] } as unknown as Memory["extraction"] });
    const src = visualAidSource(m, ["A cache-aside read checks the cache first.", "tiny"])!;
    expect(src.title).toBe("Redis");
    expect(src.statements).toContain("allkeys-lru evicts the least recently used keys when memory is full");
    expect(src.statements).toContain("A cache-aside read checks the cache first.");
    expect(src.statements.filter((s) => s.startsWith("maxmemory")).length).toBe(1); // the fact and the bullet are one statement
    expect(src.statements).not.toContain("short");
    expect(src.statements).not.toContain("tiny");
    expect(src.statements.length).toBeLessThanOrEqual(10);
    // nothing outside the memory: every statement is traceable to its text, a fact, or the notes passed in
    const allowed = [NOTE, "maxmemory sets the memory limit for the dataset", "A cache-aside read checks the cache first."].join("\n");
    for (const s of src.statements) expect(allowed).toContain(s);
  });
  it("uses a real title even when the reading is missing (the live-check defect)", () => {
    const src = visualAidSource(mem())!;
    expect(src.title).toBe("Learn Redis caching");
    expect(visualAidPrompt(src)).not.toMatch(/untitled/i);
  });
  it("does not use the sentence the user wrote about intent as a statement", () => {
    const src = visualAidSource(mem())!;
    expect(src.statements.join(" ")).not.toContain("I want to learn how these fit together");
  });
});

describe("prompt construction", () => {
  const prompt = visualAidPrompt(visualAidSource(mem())!);
  it("restricts the model to the statements and forbids invented facts", () => {
    expect(prompt).toMatch(/use ONLY the numbered statements/i);
    expect(prompt).toMatch(/Do not add facts, numbers, names, logos, examples, definitions or sources/);
    expect(prompt).toContain('1. allkeys-lru evicts the least recently used keys when memory is full');
    expect(prompt).toContain("4. Cache-aside reads the cache first, then falls back to the database");
  });
  it("forbids arrows and implied relationships unless a statement states one, and invented headings", () => {
    expect(prompt).toMatch(/do NOT draw arrows, connectors, flows, steps, hierarchies or cause-and-effect/);
    expect(prompt).toMatch(/separate, equal, labelled cards in a neat grid/);
    expect(prompt).toContain('use exactly this title as the only heading: "Learn Redis caching"');
    expect(prompt).toMatch(/Do not invent section headings/);
  });
  it("refuses a placeholder title or an empty source instead of building a prompt", () => {
    expect(() => visualAidPrompt({ title: "Untitled", summary: "", statements: ["a real statement here"] })).toThrow(/real title/);
    expect(() => visualAidPrompt({ title: "", summary: "", statements: ["a real statement here"] })).toThrow(/real title/);
    expect(() => visualAidPrompt({ title: "Redis", summary: "", statements: [] })).toThrow(/saved content/);
  });
});

describe("empty input is rejected", () => {
  it("returns no source for a memory with nothing to draw from", () => {
    expect(visualAidSource(mem({}, null))).toBeNull();
    expect(visualAidSource(mem({}, "x"))).toBeNull();
    expect(visualAidSource(mem({ source: { kind: "image", originalName: "a.png" } }, null))).toBeNull();
  });
  it("a memory with statements but no usable title still gets one from its own words, never a placeholder", () => {
    const src = visualAidSource(mem({}, "- allkeys-lru evicts the least recently used keys\n- maxmemory sets the memory limit"));
    expect(src).toBeNull(); // bullets only: no real title and no summary to take one from
  });
});

describe("the demo-mode diagram", () => {
  const svg = mockDiagramSvg(visualAidSource(mem())!);
  it("implies no order or connection, and says what it is", () => {
    expect(svg).not.toMatch(/marker|stroke-width="4"/); // no arrows
    expect(svg).toMatch(/No order or connection is implied/);
    expect(svg).toMatch(/not Muse Image/);
    expect(svg).toContain("Learn Redis caching");
  });
  it("escapes markup in saved text", () => {
    const evil = mem({}, "Topic\n- <script>alert(1)</script> & \"quotes\" go here safely");
    const out = mockDiagramSvg({ title: "T", summary: "", statements: ["<script>alert(1)</script> & \"quotes\""] });
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
    void evil;
  });
});
