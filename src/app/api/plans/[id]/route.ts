import { connection } from "next/server";
import { z } from "zod";
import { approvePlan, approveReview, completeUserStep, editStep, rejectPlan, retryStep, setStepInput, skipStep, StepEdit } from "@/lib/agent/executor";
import { getPlan } from "@/lib/store";
import { errorResponse, HttpError, json, readJson } from "../../_http";

const notFound = () => new HttpError(404, "Plan not found");

export async function GET(_req: Request, ctx: RouteContext<"/api/plans/[id]">) {
  await connection();
  try {
    const plan = await getPlan((await ctx.params).id);
    if (!plan) throw notFound();
    return json({ plan });
  } catch (e) {
    return errorResponse(e);
  }
}

const step = z.string().min(1).max(20);
const Op = z.discriminatedUnion("op", [
  z.object({ op: z.literal("approve") }).strict(),
  z.object({ op: z.literal("reject"), note: z.string().trim().max(500).optional() }).strict(),
  z.object({ op: z.literal("accept"), stepId: step }).strict(),
  z.object({ op: z.literal("edit"), stepId: step, edit: StepEdit }).strict(),
  z.object({ op: z.literal("record"), stepId: step, evidence: z.string().trim().max(2000) }).strict(),
  z.object({ op: z.literal("skip"), stepId: step }).strict(),
  z.object({ op: z.literal("set"), stepId: step, field: z.literal("dueAt"), value: z.string().max(40) }).strict(),
  z.object({ op: z.literal("retry"), stepId: step }).strict(),
]);

/** Every decision is yours: approve or reject the plan, accept or edit a draft, record what you did, skip, set a date, retry. */
export async function POST(req: Request, ctx: RouteContext<"/api/plans/[id]">) {
  try {
    const { id } = await ctx.params;
    const b = Op.parse(await readJson(req));
    const plan =
      b.op === "approve" ? await approvePlan(id)
      : b.op === "reject" ? await rejectPlan(id, b.note)
      : b.op === "accept" ? await approveReview(id, b.stepId)
      : b.op === "edit" ? await editStep(id, b.stepId, b.edit)
      : b.op === "record" ? await completeUserStep(id, b.stepId, b.evidence)
      : b.op === "skip" ? await skipStep(id, b.stepId)
      : b.op === "set" ? await setStepInput(id, b.stepId, b.field, b.value)
      : await retryStep(id, b.stepId);
    if (!plan) throw notFound();
    return json({ plan });
  } catch (e) {
    return errorResponse(e);
  }
}
