import { describe, expect, it } from "vitest";
import { captureLink, initialFromParams, MAX_PARAM_TEXT } from "@/lib/capture-params";

// The iPhone Shortcut opens /capture with ?url=&text=&title= built by the Shortcuts "URL Encode" action, which behaves like
// encodeURIComponent. These tests send awkward content through exactly that and check the form is pre-filled with all of it.

const roundTrip = (parts: { url?: string; title?: string; text?: string }) => {
  const link = new URL(captureLink("https://acorn.example", parts));
  const q = Object.fromEntries(link.searchParams.entries()); // what the page's searchParams would hold
  return { link, filled: initialFromParams(q) };
};

describe("capture link round trip", () => {
  it("keeps ampersands, equals, hashes, plus signs, quotes, accents and emoji intact", () => {
    const url = "https://example.com/a?b=1&c=2#frag+plus";
    const text = `Tom & Jerry's "plan" = 100% done #1 + more. Café ☕ 日本語 🙂`;
    const { filled } = roundTrip({ url, text });
    expect(filled.url).toBe(url);
    expect(filled.text).toBe(text);
  });
  it("keeps line breaks and blank lines", () => {
    const text = "line one\nline two\n\nline four";
    expect(roundTrip({ text }).filled.text).toBe(text);
  });
  it("does not truncate long text (a 15,000-character page of text)", () => {
    const text = "paragraph about caching and eviction. ".repeat(400).trim();
    expect(text.length).toBeGreaterThan(14_000);
    const { link, filled } = roundTrip({ url: "https://example.com/long", text });
    expect(filled.text).toBe(text);
    expect(link.href.length).toBeGreaterThan(14_000);
  });
  it("caps text at the form's own limit rather than at 2,000", () => {
    const text = "x".repeat(MAX_PARAM_TEXT + 500);
    expect(roundTrip({ text }).filled.text).toHaveLength(MAX_PARAM_TEXT);
  });
  it("puts the title above the shared words, and takes a link out of the text when no url was sent", () => {
    expect(roundTrip({ title: "Great post", text: "Worth a read https://example.com/z" }).filled).toEqual({ url: "https://example.com/z", text: "Great post\n\nWorth a read" });
    expect(roundTrip({ url: "https://example.com/z", title: "T" }).filled).toEqual({ url: "https://example.com/z", text: "T" });
  });
  it("leaves out empty parts, and an empty share opens a plain capture form", () => {
    expect(captureLink("https://acorn.example/", {})).toBe("https://acorn.example/capture");
    expect(captureLink("https://acorn.example", { url: "https://e.com", text: "" })).toBe("https://acorn.example/capture?url=https%3A%2F%2Fe.com");
    expect(initialFromParams({})).toEqual({ url: "", text: "" });
  });
  it("a '+' that was NOT encoded reads as a space (so the Shortcut must use URL Encode, not Replace Text)", () => {
    const q = Object.fromEntries(new URL("https://acorn.example/capture?text=a+b").searchParams.entries());
    expect(initialFromParams(q).text).toBe("a b");
  });
  it("ignores repeated parameters instead of guessing which one was meant", () => {
    expect(initialFromParams({ url: ["https://a.example", "https://b.example"], text: "t" })).toEqual({ url: "", text: "t" });
  });
});
