// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }) }));

import { StudyPackView } from "@/components/StudyPack";
import { buildStudyPack } from "@/lib/agent/study";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pack = buildStudyPack({
  title: "Redis persistence",
  summary: "How Redis saves its data to disk.",
  facts: [
    { statement: "RDB snapshots are compact and fast to restore.", quote: "RDB snapshots are compact" },
    { statement: "The append-only file logs every write to disk.", quote: null },
  ],
  entities: [{ name: "Redis", kind: "technology" }],
  readableText: "",
});

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ plan: {} }), { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("StudyPackView", () => {
  it("shows the plan, notes, cards, questions and exercises, and says where they come from", () => {
    render(<StudyPackView pack={pack} planId="p1" stepId="s2" canMark />);
    expect(screen.getByText(/no model wrote it/i)).toBeTruthy();
    expect(screen.getByRole("region", { name: "Session plan" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Revision notes" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Show answer" })).toHaveLength(pack.cards.length);
    expect(screen.getByRole("region", { name: "Practice questions" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Exercises" })).toBeTruthy();
    expect(screen.getByTestId("study-progress").textContent).toContain(`0 of ${pack.cards.length} cards known`);
  });

  it("hides the answer until you ask, and flipping a card sends nothing", () => {
    render(<StudyPackView pack={pack} planId="p1" stepId="s2" canMark />);
    expect(screen.queryByTestId("card-back")).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "Show answer" })[0]!);
    expect(screen.getAllByTestId("card-back")).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("saves a card mark, a question tick and an exercise tick as progress edits on the plan", async () => {
    render(<StudyPackView pack={pack} planId="p1" stepId="s2" canMark />);
    fireEvent.click(screen.getAllByRole("button", { name: "I knew it" })[0]!);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const call = (n: number) => ({ url: fetchMock.mock.calls[n]![0] as string, body: JSON.parse(fetchMock.mock.calls[n]![1].body as string) });
    expect(call(0)).toEqual({ url: "/api/plans/p1", body: { op: "edit", stepId: "s2", edit: { study: { cards: { c1: "known" } } } } });
    await waitFor(() => expect((screen.getAllByRole("button", { name: "I knew it" })[0] as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByLabelText(pack.questions[0]!.text));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(call(1).body.edit).toEqual({ study: { questions: { q1: true } } });
    await waitFor(() => expect((screen.getByLabelText(pack.exercises[0]!.text) as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(screen.getByLabelText(pack.exercises[0]!.text));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(call(2).body.edit).toEqual({ study: { exercises: { e1: true } } });
  });

  it("reflects saved progress and offers no marking when the plan isn't live", () => {
    const done = { ...pack, cards: pack.cards.map((c, i) => (i === 0 ? { ...c, status: "known" as const } : c)) };
    render(<StudyPackView pack={done} planId="p1" stepId="s2" canMark={false} />);
    expect(screen.getByTestId("study-progress").textContent).toContain(`1 of ${pack.cards.length} cards known`);
    expect(screen.queryByRole("button", { name: "I knew it" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Show answer" }).length).toBeGreaterThan(0);
  });

  it("shows an error from the server instead of pretending the mark was saved", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "This pack isn't available to update." }), { status: 400, headers: { "content-type": "application/json" } }));
    render(<StudyPackView pack={pack} planId="p1" stepId="s2" canMark />);
    fireEvent.click(screen.getAllByRole("button", { name: "I knew it" })[0]!);
    await waitFor(() => expect(screen.getByText(/isn't available to update/)).toBeTruthy());
  });
});
