// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }) }));

import { VoiceCapture } from "@/components/VoiceCapture";
import { VisualAidPanel } from "@/components/VisualAid";
import type { Artifact } from "@/lib/artifacts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("VoiceCapture", () => {
  beforeEach(() => {
    vi.stubGlobal("AudioContext", class {});
  });

  it("says plainly when the browser can't record", () => {
    vi.stubGlobal("AudioContext", undefined);
    render(<VoiceCapture />);
    expect(screen.getByText(/can't record audio/i)).toBeTruthy();
    expect((screen.getByRole("button", { name: /start recording/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a blocked microphone gives a clear, recoverable message", async () => {
    const denied = Object.assign(new DOMException("no", "NotAllowedError"));
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn().mockRejectedValue(denied) } });
    render(<VoiceCapture />);
    fireEvent.click(screen.getByRole("button", { name: /start recording/i }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Microphone access was blocked/));
    expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy();
  });
});

const aid = (over: Partial<Artifact> = {}): Artifact => ({
  id: "a1", memoryId: "m1", parentId: null, kind: "visual_aid", status: "ready", provider: "mock", model: "mock-diagram", fileName: "11111111-1111-4111-8111-111111111111.svg", mimeType: "image/svg+xml",
  input: {}, output: { title: "Redis caching", basedOn: ["maxmemory sets the memory limit"], prompt: "p", aiGenerated: true, note: "Demo diagram" }, attempts: 1, error: null, latencyMs: 12, usage: null,
  confirmedMemoryId: null, createdAt: "2026-11-05T00:00:00Z", updatedAt: "2026-11-05T00:00:00Z", ...over,
});

describe("VisualAidPanel", () => {
  it("labels a generated picture as AI-created and not evidence, and never calls itself Meta in demo mode", () => {
    render(<VisualAidPanel memoryId="m1" aids={[aid()]} ready real={false} />);
    expect(screen.getByText("AI-created illustration")).toBeTruthy();
    expect(screen.getByText("Not source evidence")).toBeTruthy();
    expect(screen.getByText(/Demo stand-in/)).toBeTruthy();
    expect(screen.queryByText(/Powered by Meta/)).toBeNull();
    expect(screen.getByText(/Demo mode draws a simple diagram itself/)).toBeTruthy();
  });

  it("a real Muse Image result is attributed to the model", () => {
    render(<VisualAidPanel memoryId="m1" aids={[aid({ provider: "meta", model: "muse-image-1.0" })]} ready real />);
    expect(screen.getByText(/Powered by Meta muse-image-1.0/)).toBeTruthy();
    expect(screen.getByText(/about \$0.01 per picture/)).toBeTruthy();
  });

  it("shows the reason for a failure with a retry, and only generates when the button is pressed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ artifact: {} }), { status: 201, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    render(<VisualAidPanel memoryId="m1" aids={[aid({ status: "failed", fileName: null, error: { kind: "timeout", message: "Meta API timed out after 120s.", at: "x" } })]} ready real />);
    expect(fetchMock).not.toHaveBeenCalled(); // nothing is generated on its own
    expect(screen.getByRole("alert").textContent).toMatch(/timed out/);
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/artifacts/a1", expect.objectContaining({ method: "POST" })));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ op: "retry" });
  });

  it("is disabled until the memory has been read", () => {
    render(<VisualAidPanel memoryId="m1" aids={[]} ready={false} real={false} />);
    expect((screen.getByRole("button", { name: /create visual aid/i }) as HTMLButtonElement).disabled).toBe(true);
  });
});
