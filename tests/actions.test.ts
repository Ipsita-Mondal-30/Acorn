import { describe, expect, it } from "vitest";
import { ActionError, allowedNext, proposeAction, setKind, transition } from "@/lib/actions";
import { buildSeed } from "@/lib/seed";

const now = new Date(2026, 9, 27, 10, 0);
const memory = buildSeed(now).memories[0];
const go = (a: ReturnType<typeof proposeAction>, ...states: Parameters<typeof transition>[1][]) =>
  states.reduce((x, s) => transition(x, s, {}, now), a);

describe("action state machine", () => {
  it("walks a legal path to completed", () => {
    const a = proposeAction(memory, { title: "Apply", kind: "simulated" }, now);
    expect(a.state).toBe("proposed");
    expect(a.memoryId).toBe(memory.id);
    const done = go(a, "awaiting_approval", "approved", "in_progress", "completed");
    expect(done.state).toBe("completed");
    expect(done.history.map((h) => h.state)).toEqual(["proposed", "awaiting_approval", "approved", "in_progress", "completed"]);
    expect(allowedNext(done)).toEqual([]);
  });

  it("defaults to a suggested action", () => {
    expect(proposeAction(memory, { title: "x" }, now).kind).toBe("suggested");
  });

  it("throws on an illegal jump", () => {
    const a = proposeAction(memory, { title: "Apply", kind: "simulated" }, now);
    expect(() => transition(a, "in_progress", {}, now)).toThrow(ActionError);
    expect(() => transition(go(a, "cancelled"), "proposed", {}, now)).toThrow(ActionError);
  });

  it("requires evidence to complete an executed action", () => {
    const running = go(proposeAction(memory, { title: "Send", kind: "executed" }, now), "awaiting_approval", "approved", "in_progress");
    expect(() => transition(running, "completed", {}, now)).toThrow(/evidence/);
    expect(() => transition(running, "completed", { evidence: "   " }, now)).toThrow(ActionError);
    const done = transition(running, "completed", { evidence: "Message id 123" }, now);
    expect(done.evidence).toBe("Message id 123");
  });

  it("won't run a suggested action until its kind changes, and kind locks once started", () => {
    const approved = go(proposeAction(memory, { title: "Idea" }, now), "awaiting_approval", "approved");
    expect(() => transition(approved, "in_progress", {}, now)).toThrow(ActionError);
    expect(() => transition({ ...approved, state: "in_progress" }, "completed", {}, now)).toThrow(ActionError);
    const running = transition(setKind(approved, "simulated", now), "in_progress", {}, now);
    expect(() => setKind(running, "executed", now)).toThrow(ActionError);
  });

  it("can retry from failed", () => {
    const failed = go(proposeAction(memory, { title: "Try", kind: "simulated" }, now), "awaiting_approval", "approved", "in_progress", "failed");
    expect(allowedNext(failed)).toEqual(["in_progress", "cancelled"]);
    expect(go(failed, "in_progress", "completed").state).toBe("completed");
  });

  it("never mutates its input", () => {
    const a = proposeAction(memory, { title: "Apply", kind: "simulated" }, now);
    const snapshot = structuredClone(a);
    const b = transition(a, "awaiting_approval", { note: "ok" }, now);
    setKind(a, "executed", now);
    expect(a).toEqual(snapshot);
    expect(b.history.at(-1)!.note).toBe("ok");
  });
});
