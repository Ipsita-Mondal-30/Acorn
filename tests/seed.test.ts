import { describe, expect, it } from "vitest";
import { TRANSITIONS } from "@/lib/actions";
import { Db } from "@/lib/schema";
import { buildSeed } from "@/lib/seed";

const now = new Date(2026, 9, 27, 10, 0);

describe("buildSeed", () => {
  const db = buildSeed(now);

  it("matches the Db schema", () => {
    expect(() => Db.parse(db)).not.toThrow();
    expect(db.memories.length).toBeGreaterThanOrEqual(10);
  });

  it("marks everything as sample data with unique ids and no future timestamps", () => {
    expect(db.memories.every((m) => m.isSample)).toBe(true);
    expect(new Set(db.memories.map((m) => m.id)).size).toBe(db.memories.length);
    expect(db.memories.every((m) => Date.parse(m.createdAt) <= now.getTime())).toBe(true);
  });

  it("only quotes evidence that appears verbatim in the source", () => {
    for (const m of db.memories) {
      const x = m.extraction!;
      for (const quote of [...x.evidence.map((e) => e.quote), ...x.dates.map((d) => d.evidence)]) {
        expect(m.source.text, `${m.id}: ${quote}`).toContain(quote);
      }
    }
  });

  it("gives every action a legal history ending in its current state", () => {
    const ids = new Set(db.memories.map((m) => m.id));
    for (const a of db.actions) {
      expect(ids.has(a.memoryId)).toBe(true);
      expect(a.history[0].state).toBe("proposed");
      expect(a.history.at(-1)!.state).toBe(a.state);
      for (let i = 1; i < a.history.length; i++) {
        expect(TRANSITIONS[a.history[i - 1].state], `${a.id} step ${i}`).toContain(a.history[i].state);
      }
    }
  });

  it("is deterministic for a given now", () => {
    expect(buildSeed(now)).toEqual(db);
  });
});
