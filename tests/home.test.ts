import { describe, expect, it } from "vitest";
import { homeSections } from "@/lib/home";
import { buildSeed } from "@/lib/seed";

const now = new Date(2026, 9, 27, 10, 0);

describe("homeSections", () => {
  it("surfaces the near passport deadline in needsAttention and upcoming", () => {
    const { memories, actions } = buildSeed(now);
    const home = homeSections(memories, actions, now);
    expect(home.recent).toHaveLength(6);
    expect(home.recent[0].id).toBe("sample-talk-rsc");
    expect(home.needsAttention[0]).toMatchObject({ memory: { id: "sample-deadline-passport" }, reason: "Due in 2 days — no action yet" });
    // job has a proposed action, so it shows for that, not as an unhandled deadline
    const lumen = home.needsAttention.find((n) => n.memory.id === "sample-job-lumen");
    expect(lumen?.reason).toMatch(/^Suggested:/);
    expect(home.needsAttention.some((n) => n.memory.id === "sample-idea-explain-cli" && /Low confidence/.test(n.reason))).toBe(true);
    expect(home.upcoming[0]).toMatchObject({ memory: { id: "sample-deadline-passport" }, date: "2026-10-29", daysLeft: 2 });
    expect(home.upcoming.map((u) => u.date)).toEqual([...home.upcoming.map((u) => u.date)].sort());
  });

  it("uses the user's corrected deadline", () => {
    const { memories, actions } = buildSeed(now);
    const fernway = memories.find((m) => m.id === "sample-job-fernway")!;
    fernway.overrides = { deadline: "2026-10-28" };
    const home = homeSections(memories, actions, now);
    expect(home.upcoming[0]).toMatchObject({ memory: { id: "sample-job-fernway" }, date: "2026-10-28", daysLeft: 1, label: "Deadline (set by you)" });
    expect(home.upcoming.some((u) => u.date === "2026-11-16")).toBe(false); // extracted date is gone
    expect(home.needsAttention[0]).toMatchObject({ memory: { id: "sample-job-fernway" }, reason: "Due tomorrow — no action yet" });

    fernway.overrides = { deadline: null }; // user cleared it
    expect(homeSections(memories, actions, now).upcoming.some((u) => u.memory.id === "sample-job-fernway")).toBe(false);
  });
});
