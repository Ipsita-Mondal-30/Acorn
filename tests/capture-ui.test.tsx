// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const refresh = vi.fn();
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push, replace: vi.fn() }) }));

import { CaptureForm, QuickCapture } from "@/components/CaptureForm";
import { ProcessingWatcher } from "@/components/ProcessingWatcher";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  refresh.mockReset();
  push.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const ID = "22222222-2222-4222-8222-222222222222";
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const pendingMemory = { id: ID, status: "pending", source: { kind: "note" } };

describe("QuickCapture", () => {
  it("confirms the save straight away with 'I saved that for you', without waiting for understanding", async () => {
    fetchMock.mockResolvedValue(reply(201, { memory: pendingMemory, created: true }));
    render(<QuickCapture />);
    fireEvent.change(screen.getByLabelText("Quick note"), { target: { value: "Learn Redis caching" } });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    expect(await screen.findByText(/Yay! I saved that for you/)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1); // one request: no follow-up processing call from the browser
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ kind: "note", text: "Learn Redis caching" });
    expect((screen.getByLabelText("Quick note") as HTMLTextAreaElement).value).toBe("");
    expect(screen.getByRole("link", { name: "See what I found" }).getAttribute("href")).toBe(`/memories/${ID}`);
    expect(refresh).toHaveBeenCalled();
  });

  it("does not save twice on a double tap", async () => {
    let release!: (r: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((r) => (release = r)));
    render(<QuickCapture />);
    fireEvent.change(screen.getByLabelText("Quick note"), { target: { value: "once" } });
    const save = screen.getByRole("button", { name: "Save note" });
    fireEvent.click(save);
    fireEvent.click(save);
    expect(await screen.findByText(/reading this/)).toBeTruthy();
    await act(async () => release(reply(201, { memory: pendingMemory, created: true })));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("tells the user a repeat is a duplicate, and keeps their text when saving fails", async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { memory: { ...pendingMemory, status: "ready" }, created: false }));
    render(<QuickCapture />);
    fireEvent.change(screen.getByLabelText("Quick note"), { target: { value: "again" } });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    expect(await screen.findByText(/already saved this/)).toBeTruthy();

    fetchMock.mockResolvedValueOnce(reply(503, { error: "Couldn't store the file. Please try again." }));
    fireEvent.change(screen.getByLabelText("Quick note"), { target: { value: "keep me" } });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    expect(await screen.findByText(/Couldn't store the file/)).toBeTruthy();
    expect((screen.getByLabelText("Quick note") as HTMLTextAreaElement).value).toBe("keep me");
  });
});

describe("CaptureForm", () => {
  const form = (initial?: { url: string; text: string }) => render(<CaptureForm maxUploadBytes={8 * 1024 * 1024} maxDocumentBytes={15 * 1024 * 1024} storageNote="" initial={initial} />);

  it("saves a link, then opens the new memory where its progress is shown", async () => {
    fetchMock.mockResolvedValue(reply(201, { memory: { ...pendingMemory, source: { kind: "url" } }, created: true }));
    form();
    fireEvent.click(screen.getByLabelText("Link"));
    fireEvent.change(screen.getByLabelText("Link", { selector: "input[name=url]" }), { target: { value: "https://example.com/post" } });
    fireEvent.click(screen.getByRole("button", { name: "Save to Acorn" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/memories/${ID}?saved=1`));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ kind: "url", url: "https://example.com/post" });
  });

  it("stays on the form with a clear message when the save fails", async () => {
    fetchMock.mockResolvedValue(reply(400, { error: "That doesn't look like a valid URL." }));
    form({ url: "https://example.com/x", text: "" });
    fireEvent.click(screen.getByRole("button", { name: "Save to Acorn" }));
    expect(await screen.findByText(/valid URL/)).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
  });

  it("fills in a link and words shared from the phone but saves nothing until the user taps Save", () => {
    form({ url: "https://example.com/shared", text: "Worth reading" });
    expect((screen.getByLabelText("Link", { selector: "input[name=url]" }) as HTMLInputElement).value).toBe("https://example.com/shared");
    expect((screen.getByLabelText(/Text from the page/) as HTMLTextAreaElement).value).toBe("Worth reading");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an oversized file before uploading it", async () => {
    form();
    fireEvent.click(screen.getByLabelText("Image or PDF"));
    const big = new File([new Uint8Array(20 * 1024 * 1024)], "big.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText(/Screenshot, photo or PDF/), { target: { files: [big] } });
    expect(await screen.findByText(/larger than 8 MB/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("ProcessingWatcher", () => {
  it("re-reads the page while work is running, and stops when it unmounts", () => {
    vi.useFakeTimers();
    const { unmount } = render(<ProcessingWatcher />);
    vi.advanceTimersByTime(5_100);
    expect(refresh).toHaveBeenCalledTimes(2);
    unmount();
    vi.advanceTimersByTime(10_000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("nudges a save that never started, once, through the normal process endpoint", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(reply(200, { memory: { id: ID, status: "ready" } }));
    render(<ProcessingWatcher stalled={[ID]} />);
    await vi.advanceTimersByTimeAsync(10_500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/memories/${ID}`);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ op: "process" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up after a few minutes instead of polling forever", () => {
    vi.useFakeTimers();
    render(<ProcessingWatcher />);
    vi.advanceTimersByTime(3 * 60_000 + 3_000);
    const n = refresh.mock.calls.length;
    vi.advanceTimersByTime(60_000);
    expect(refresh.mock.calls.length).toBe(n);
  });
});
