import "server-only";
import { getPrefs, listActions, listMemories, listPlans, listReminders } from "../store";
import type { Snapshot } from "./followthrough";

/** The signed-in user's own data for the briefing and follow-through checks (through their session, so row-level security applies). */
export async function snapshotForUser(now: Date): Promise<Snapshot> {
  const [memories, reminders, actions, plans, prefs] = await Promise.all([listMemories(), listReminders(), listActions(), listPlans().catch(() => []), getPrefs()]);
  return { memories, reminders, actions, plans, prefs, now };
}
