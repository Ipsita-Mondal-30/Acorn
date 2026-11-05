import { connection } from "next/server";
import { z } from "zod";
import { proposeAction, setKind, transition } from "@/lib/actions";
import { ActionState, ExecutionKind } from "@/lib/schema";
import { planOwningAction } from "@/lib/agent/executor";
import { getMemory, listActions, mutateAction, upsertAction } from "@/lib/store";
import { errorResponse, HttpError, json, readJson } from "../_http";

export async function GET(req: Request) {
  await connection();
  try {
    const memoryId = new URL(req.url).searchParams.get("memoryId") ?? undefined;
    return json({ actions: await listActions(memoryId) });
  } catch (e) {
    return errorResponse(e);
  }
}

const Propose = z
  .object({
    memoryId: z.string().min(1).max(100),
    title: z.string().trim().min(1).max(200),
    detail: z.string().max(2000).optional(),
    kind: ExecutionKind.optional(),
  })
  .strict();

export async function POST(req: Request) {
  try {
    const body = Propose.parse(await readJson(req));
    const memory = await getMemory(body.memoryId);
    if (!memory) throw new HttpError(404, "Memory not found");
    const action = proposeAction(memory, { title: body.title, detail: body.detail, kind: body.kind }, new Date());
    return json({ action: await upsertAction(action) }, 201);
  } catch (e) {
    return errorResponse(e);
  }
}

const Change = z
  .object({
    id: z.string().min(1).max(100),
    to: ActionState.optional(),
    kind: ExecutionKind.optional(),
    note: z.string().trim().max(500).optional(),
    evidence: z.string().trim().max(2000).optional(),
  })
  .strict()
  .refine((b) => b.to || b.kind, "Send `to` and/or `kind`");

/** Change execution kind and/or move through the state machine. Evidence sent with `kind` is attached first. */
export async function PATCH(req: Request) {
  try {
    const body = Change.parse(await readJson(req));
    const now = new Date();
    // an action that belongs to a plan changes only through that plan: its approval and completion can't be shortcut here
    if (await planOwningAction(body.id)) throw new HttpError(409, "This action is run by a plan. Approve, edit or finish it from the plan.");
    const evidence = body.evidence || undefined;
    // check-and-write happen inside one serialised store mutation: no lost updates, no double transitions
    const action = await mutateAction(body.id, (a) => {
      if (body.kind) a = setKind(evidence ? { ...a, evidence } : a, body.kind, now);
      if (body.to) a = transition(a, body.to, { note: body.note || undefined, evidence }, now);
      return a;
    });
    if (!action) throw new HttpError(404, "Action not found");
    return json({ action });
  } catch (e) {
    return errorResponse(e);
  }
}
