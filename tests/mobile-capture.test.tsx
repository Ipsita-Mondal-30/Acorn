// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }) }));

import { readClipboard, splitClipboard } from "@/components/clipboard";
import { CaptureForm } from "@/components/CaptureForm";
import { convertHeicToJpeg, HeicError, isHeicFile, MAX_SIDE, type HeicDeps } from "@/components/heic";
import { VoiceCapture } from "@/components/VoiceCapture";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const readText = (b: Blob) => new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.readAsText(b); });
const props = { maxUploadBytes: 8 * 1024 * 1024, maxDocumentBytes: 15 * 1024 * 1024, storageNote: "Stays on this machine." };

describe("clipboard parsing", () => {
  it("splits a link from the words around it and keeps the words exactly", () => {
    expect(splitClipboard("Great read https://example.com/a?x=1&y=2 \n\n\n\nsee section 3")).toEqual({ url: "https://example.com/a?x=1&y=2", text: "Great read \n\nsee section 3" });
    expect(splitClipboard("https://example.com/only")).toEqual({ url: "https://example.com/only", text: "" });
    expect(splitClipboard("  just words, no link  ")).toEqual({ url: null, text: "just words, no link" });
  });
  it("does not truncate long text at 2,000 characters", () => {
    const long = "word ".repeat(3000).trim();
    expect(splitClipboard(long).text).toBe(long);
  });
  it("explains itself when the clipboard is unavailable, denied or empty", async () => {
    expect(await readClipboard({ clipboard: undefined } as never)).toMatchObject({ ok: false, message: expect.stringMatching(/can't read the clipboard/) });
    expect(await readClipboard({ clipboard: { readText: async () => { throw new DOMException("no", "NotAllowedError"); } } } as never)).toMatchObject({ ok: false, message: expect.stringMatching(/Press and hold/) });
    expect(await readClipboard({ clipboard: { readText: async () => "   " } } as never)).toMatchObject({ ok: false, message: "The clipboard is empty." });
    expect(await readClipboard({ clipboard: { readText: async () => "hi" } } as never)).toEqual({ ok: true, text: "hi" });
  });
});

describe("capture form on a phone", () => {
  beforeEach(() => void 0);

  it("the link box is set up for a phone keyboard: no auto-capitalisation or correction of a URL, a Go key, 16px text", () => {
    render(<CaptureForm {...props} initialKind="url" />);
    const url = screen.getByLabelText("Link", { selector: "input[name=url]" }) as HTMLInputElement;
    expect(url.getAttribute("inputmode")).toBe("url");
    expect(url.getAttribute("autocapitalize")).toBe("none");
    expect(url.getAttribute("autocorrect")).toBe("off");
    expect(url.getAttribute("spellcheck")).toBe("false");
    expect(url.getAttribute("enterkeyhint")).toBe("go");
    expect(url.className).toMatch(/text-base/); // 16px: Safari zooms into smaller inputs
  });

  it("Paste fills the link box and the text box from one clipboard, and never saves by itself", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { readText: async () => "Worth reading https://example.com/post\nthe part about caching" } });
    render(<CaptureForm {...props} initialKind="url" />);
    fireEvent.click(screen.getByRole("button", { name: /paste from clipboard/i }));
    await waitFor(() => expect(screen.getByText(/Pasted\. Check it/)).toBeTruthy());
    expect((screen.getByLabelText("Link", { selector: "input[name=url]" }) as HTMLInputElement).value).toBe("https://example.com/post");
    expect((screen.getByLabelText(/Text from the page/) as HTMLTextAreaElement).value).toBe("Worth reading \nthe part about caching");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Paste in the note form puts everything into the note, and a refused clipboard says what to do", async () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: { readText: async () => "A note with a link https://example.com/x inside" } });
    render(<CaptureForm {...props} initialKind="note" />);
    fireEvent.click(screen.getByRole("button", { name: /paste from clipboard/i }));
    await waitFor(() => expect((screen.getByLabelText("Note", { selector: "textarea" }) as HTMLTextAreaElement).value).toBe("A note with a link https://example.com/x inside"));
    cleanup();
    vi.stubGlobal("navigator", { ...navigator, clipboard: { readText: async () => { throw new DOMException("denied", "NotAllowedError"); } } });
    render(<CaptureForm {...props} initialKind="note" />);
    fireEvent.click(screen.getByRole("button", { name: /paste from clipboard/i }));
    await waitFor(() => expect(screen.getByText(/Press and hold in the box and choose Paste/)).toBeTruthy());
  });

  it("the file picker offers images and PDFs, not HEIC (iOS then converts Photos picks to JPEG itself)", () => {
    render(<CaptureForm {...props} initialKind="image" />);
    const accept = (screen.getByLabelText(/Screenshot, photo or PDF/) as HTMLInputElement).getAttribute("accept")!;
    expect(accept.split(",")).toEqual(expect.arrayContaining(["image/png", "image/jpeg", "application/pdf"]));
    expect(accept).not.toMatch(/hei/);
  });
});

describe("HEIC", () => {
  const heicFile = (name = "IMG_0042.HEIC", type = "image/heic") => new File([new Uint8Array([1, 2, 3])], name, { type });
  const deps = (over: Partial<HeicDeps> = {}, size = { width: 4032, height: 3024 }): HeicDeps => ({
    decode: async () => ({ ...size, release: vi.fn() }),
    encode: async (_img, w, h) => new Blob([`jpeg ${w}x${h}`], { type: "image/jpeg" }),
    ...over,
  });

  it("recognises HEIC by type or extension only", () => {
    expect(isHeicFile({ name: "a.HEIC", type: "" })).toBe(true);
    expect(isHeicFile({ name: "a.jpg", type: "image/heif" })).toBe(true);
    expect(isHeicFile({ name: "a.jpg", type: "image/jpeg" })).toBe(false);
  });
  it("converts to a JPEG with the same name, scaled down to the size cap, and frees the decoded image", async () => {
    const release = vi.fn();
    const out = await convertHeicToJpeg(heicFile(), deps({ decode: async () => ({ width: 8000, height: 6000, release }) }));
    expect(out.name).toBe("IMG_0042.jpg");
    expect(out.type).toBe("image/jpeg");
    expect(await readText(out)).toBe(`jpeg ${MAX_SIDE}x${Math.round(6000 * (MAX_SIDE / 8000))}`);
    expect(release).toHaveBeenCalled();
    expect(await readText(await convertHeicToJpeg(heicFile(), deps()))).toBe("jpeg 4032x3024"); // small enough: not resized
  });
  it("fails cleanly when the browser can't decode or encode it, and still frees the image", async () => {
    await expect(convertHeicToJpeg(heicFile(), deps({ decode: async () => { throw new HeicError("This browser can't open HEIC photos."); } }))).rejects.toThrow(/can't open HEIC/);
    const release = vi.fn();
    await expect(convertHeicToJpeg(heicFile(), deps({ decode: async () => ({ width: 10, height: 10, release }), encode: async () => null }))).rejects.toThrow(/couldn't be converted/);
    expect(release).toHaveBeenCalled();
    await expect(convertHeicToJpeg(heicFile(), deps({ encode: async () => new Blob([]) }))).rejects.toThrow(/couldn't be converted/);
    await expect(convertHeicToJpeg(new File(["x"], "a.png", { type: "image/png" }), deps())).rejects.toThrow(/isn't a HEIC/);
  });
  it("in the form, a HEIC pick that this browser can't convert explains what to do instead and uploads nothing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("createImageBitmap", undefined);
    render(<CaptureForm {...props} initialKind="image" />);
    fireEvent.change(screen.getByLabelText(/Screenshot, photo or PDF/), { target: { files: [heicFile()] } });
    await waitFor(() => expect(screen.getByText(/can't convert HEIC photos/)).toBeTruthy());
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("voice recording on iOS Safari", () => {
  it("resumes a suspended AudioContext inside the tap, uses the prefixed constructor when it is all there is, and releases the microphone", async () => {
    const resume = vi.fn(async () => {});
    const stopTrack = vi.fn();
    class Ctx {
      state = "suspended";
      sampleRate = 48000;
      destination = {};
      resume = resume;
      close = vi.fn(async () => {});
      createMediaStreamSource = () => ({ connect: vi.fn(), disconnect: vi.fn() });
      createScriptProcessor = () => ({ connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: null });
    }
    vi.stubGlobal("AudioContext", undefined);
    Object.defineProperty(window, "webkitAudioContext", { configurable: true, value: Ctx });
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] })) } });
    render(<VoiceCapture />);
    expect((screen.getByRole("button", { name: /start recording/i }) as HTMLButtonElement).disabled).toBe(false); // supported via the prefix
    fireEvent.click(screen.getByRole("button", { name: /start recording/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy());
    expect(resume).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(stopTrack).toHaveBeenCalled();
    delete (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext;
  });
});
