import { connection } from "next/server";
import { z } from "zod";
import { reclassifyIntent } from "@/lib/intent";
import { suggestPlan } from "@/lib/plan";
import { processMemory, removeMemory } from "@/lib/process";
import { applyCorrection, CorrectionPatch } from "@/lib/schema";
import { getMemory, listActions, updateMemory } from "@/lib/store";
import { errorResponse, HttpError, json, readJson } from "../../_http";

const notFound = () => new HttpError(404, "Memory not found");

export async function GET(_req: Request, ctx: RouteContext<"/api/memories/[id]">) {
  await connection();
  try {
    const { id } = await ctx.params;
    const memory = await getMemory(id);
    if (!memory) throw notFound();
    return json({ memory, actions: await listActions(id) });
  } catch (e) {
    return errorResponse(e);
  }
}

/**
 * User corrections. Fields you send replace the extracted value; `deadline: null` means "no deadline".
 * `userIntent: {kind}` confirms/corrects/dismisses Acorn's intent guess (kind "none" = dismiss);
 * `restore: [...]` drops corrections and goes back to Acorn's reading.
 */
export async function PATCH(req: Request, ctx: RouteContext<"/api/memories/[id]">) {
  try {
    const { id } = await ctx.params;
    const patch = CorrectionPatch.parse(await readJson(req));
    if (Object.keys(patch).length === 0) throw new HttpError(400, "Nothing to change");
    const now = new Date();
    const memory = await updateMemory(id, (m) => applyCorrection(m, patch, now));
    if (!memory) throw notFound();
    return json({ memory });
  } catch (e) {
    return errorResponse(e);
  }
}

const Op = z.object({ op: z.enum(["process", "reprocess", "intent", "plan"]) }).strict();

/**
 * `{op:"process"}` understands a pending/failed memory; `{op:"reprocess"}` forces a fresh extraction (failures come back as
 * status "failed"). `{op:"intent"}` asks for fresh candidate reasons for saving it (suggestions, or a question for the
 * user). `{op:"plan"}` returns suggested next steps without creating anything.
 */
export async function POST(req: Request, ctx: RouteContext<"/api/memories/[id]">) {
  try {
    const { id } = await ctx.params;
    const { op } = Op.parse(await readJson(req));
    if (op === "intent") {
      const r = await reclassifyIntent(id);
      if (!r) throw notFound();
      return json(r);
    }
    if (op === "plan") {
      const r = await suggestPlan(id);
      if (!r) throw notFound();
      return json(r);
    }
    const memory = await processMemory(id, { force: op === "reprocess" });
    if (!memory) throw notFound();
    return json({ memory });
  } catch (e) {
    return errorResponse(e);
  }
}

/** Permanently deletes the memory, its actions and its stored image. */
export async function DELETE(_req: Request, ctx: RouteContext<"/api/memories/[id]">) {
  try {
    const { id } = await ctx.params;
    if (!(await removeMemory(id))) throw notFound();
    return json({ deleted: true });
  } catch (e) {
    return errorResponse(e);
  }
}
