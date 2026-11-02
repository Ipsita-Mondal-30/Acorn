import { connection } from "next/server";
import { z } from "zod";
import { createPlan } from "@/lib/agent/executor";
import { listPlans } from "@/lib/store";
import { errorResponse, HttpError, json, readJson } from "../_http";

export async function GET(req: Request) {
  await connection();
  try {
    const memoryId = new URL(req.url).searchParams.get("memoryId") ?? undefined;
    return json({ plans: await listPlans(memoryId) });
  } catch (e) {
    return errorResponse(e);
  }
}

/**
 * Make a plan for a memory whose intent YOU confirmed. Creating a plan runs nothing: it waits for your approval.
 * 201 when created, 200 when an unfinished plan for this memory already exists.
 */
export async function POST(req: Request) {
  try {
    const { memoryId } = z.object({ memoryId: z.string().min(1).max(100) }).strict().parse(await readJson(req));
    const r = await createPlan(memoryId);
    if (!r) throw new HttpError(404, "Memory not found");
    return json(r, r.created ? 201 : 200);
  } catch (e) {
    return errorResponse(e);
  }
}
