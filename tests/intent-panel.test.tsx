// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, replace: vi.fn() }) }));

import { api } from "@/components/api";
import { IntentPanel, useMutation } from "@/components/MemoryControls";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ID = "11111111-1111-4111-8111-111111111111";
const undecided = { intentKind: null, intentStatus: "suggested", intentNote: null, suggestedIntent: null } as never;

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  refresh.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const open = () => {
  render(<IntentPanel memoryId={ID} view={undecided} />);
  fireEvent.click(screen.getByRole("button", { name: "Set what I want" }));
};

describe("IntentPanel", () => {
  it("opens the intent picker only when asked, and sends nothing by opening it", () => {
    render(<IntentPanel memoryId={ID} view={undecided} />);
    expect(screen.queryByRole("button", { name: "Learn it" })).toBeNull();
    const toggle = screen.getByRole("button", { name: "Set what I want" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "Learn it" })).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("selecting Learn it sends the PATCH with the cookie-authenticated JSON payload, then refreshes", async () => {
    fetchMock.mockResolvedValue(json(200, { ok: true }));
    open();
    fireEvent.click(screen.getByRole("button", { name: "Learn it" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`/api/memories/${ID}`);
    expect(init.method).toBe("PATCH");
    expect(init.headers).toEqual({ "content-type": "application/json" });
    expect(init.headers.authorization).toBeUndefined();
    expect(JSON.parse(init.body)).toEqual({ userIntent: { kind: "learn" } });
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it("includes the optional note with the chosen intent", async () => {
    fetchMock.mockResolvedValue(json(200, {}));
    open();
    fireEvent.change(screen.getByLabelText(/In your words/), { target: { value: "  for the interview  " } });
    fireEvent.click(screen.getByRole("button", { name: "Learn it" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ userIntent: { kind: "learn", note: "for the interview" } });
  });

  it("does not refresh, and shows the server's error, when the request fails", async () => {
    fetchMock.mockResolvedValue(json(404, { error: "Memory not found" }));
    open();
    fireEvent.click(screen.getByRole("button", { name: "Learn it" }));
    expect(await screen.findByText("Memory not found")).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Learn it" })).toHaveProperty("disabled", false));
  });

  it("shows a readable error when the server can't be reached", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    open();
    fireEvent.click(screen.getByRole("button", { name: "Learn it" }));
    expect(await screen.findByText(/Couldn't reach Acorn/)).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("shows Saving…, disables every control and ignores a second click while the request is pending", async () => {
    let release!: (r: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((r) => (release = r)));
    open();
    const learn = screen.getByRole("button", { name: "Learn it" });
    fireEvent.click(learn);
    fireEvent.click(learn); // synchronous double click, before React re-renders
    fireEvent.click(screen.getByRole("button", { name: "Buy it" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Saving…")).toBeTruthy();
    expect(learn).toHaveProperty("disabled", true);
    await act(async () => release(json(200, {})));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("allows another attempt after a failure", async () => {
    fetchMock.mockResolvedValueOnce(json(500, { error: "boom" })).mockResolvedValueOnce(json(200, {}));
    open();
    fireEvent.click(screen.getByRole("button", { name: "Learn it" }));
    await screen.findByText("boom");
    await waitFor(() => expect(screen.getByRole("button", { name: "Learn it" })).toHaveProperty("disabled", false));
    fireEvent.click(screen.getByRole("button", { name: "Learn it" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("renders its buttons ENABLED before hydration so React can replay an early click, and flags hydration when done", async () => {
    const html = renderToString(<IntentPanel memoryId={ID} view={undecided} />);
    expect(html).not.toContain("Getting ready");
    // a disabled button drops a click that arrives before hydration (nothing to replay): the markup must not disable it
    expect(/<button[^>]*\sdisabled(=""|\s|>)[^>]*>Set what I want/.test(html)).toBe(false);
    expect(html).toContain('data-hydrated="false"');
    const host = document.createElement("div");
    host.innerHTML = html;
    document.body.append(host);
    let root!: ReturnType<typeof hydrateRoot>;
    await act(async () => {
      root = hydrateRoot(host, <IntentPanel memoryId={ID} view={undecided} />);
    });
    expect(host.querySelector("section")?.getAttribute("data-hydrated")).toBe("true");
    expect(screen.getByRole("button", { name: "Set what I want" })).toHaveProperty("disabled", false);
    expect(host.textContent).not.toContain("Getting ready");
    act(() => root.unmount());
    host.remove();
  });
});

describe("useMutation", () => {
  it("ignores a second run() issued in the same tick, before any re-render", async () => {
    const work = vi.fn().mockResolvedValue(undefined);
    function Probe() {
      const m = useMutation();
      return (
        <button
          onClick={() => {
            m.run(work);
            m.run(work);
          }}
        >
          go
        </button>
      );
    }
    render(<Probe />);
    fireEvent.click(screen.getByRole("button", { name: "go" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(work).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "go" })); // free again once finished
    await waitFor(() => expect(work).toHaveBeenCalledTimes(2));
  });
});

describe("api()", () => {
  it("passes an abort signal so a hung request ends in an error", async () => {
    fetchMock.mockResolvedValue(json(200, {}));
    await api("/x", { method: "PATCH", body: {} });
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("turns a timeout into a readable error", async () => {
    fetchMock.mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    await expect(api("/x", { method: "PATCH", body: {} })).rejects.toThrow(/didn't answer in time/);
  });
});
