import "server-only";
import { getProvider, planValidated } from "./ai/provider";
import type { ActionPlan } from "./ai/outputs";
import { digestOf } from "./digest";
import { getMemory } from "./store";

/** Suggested next steps for a memory. Nothing is created or done: the user adds a step as an action if they want it. */
export async function suggestPlan(id: string): Promise<{ steps: ActionPlan["steps"]; by: { provider: "mock" | "meta"; model: string } } | null> {
  const memory = await getMemory(id);
  if (!memory) return null;
  const provider = getProvider();
  const { data } = await planValidated(provider, { memory: digestOf(memory), now: new Date() });
  return { steps: data.steps, by: { provider: provider.name, model: provider.model } };
}
