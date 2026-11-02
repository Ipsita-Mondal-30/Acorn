import { z } from "zod";
import { completeReminder, dismissReminder, editReminder, getReminder, ReminderEdit, reopenReminder, snoozeReminder } from "@/lib/reminders";
import { errorResponse, HttpError, json, readJson } from "../../_http";

const Op = z.discriminatedUnion("op", [
  z.object({ op: z.literal("edit"), changes: ReminderEdit }).strict(),
  z.object({ op: z.literal("done") }).strict(),
  z.object({ op: z.literal("snooze"), until: z.string().max(40).optional(), dueLocal: z.string().max(20).optional(), timezone: z.string().max(64).optional() }).strict().refine((b) => (b.until !== undefined) !== (b.dueLocal !== undefined), "give either until, or dueLocal with timezone"),
  z.object({ op: z.literal("dismiss") }).strict(),
  z.object({ op: z.literal("reopen") }).strict(),
]);

export async function GET(_req: Request, ctx: RouteContext<"/api/reminders/[id]">) {
  try {
    const r = await getReminder((await ctx.params).id);
    if (!r) throw new HttpError(404, "Reminder not found");
    return json({ reminder: r });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PATCH(req: Request, ctx: RouteContext<"/api/reminders/[id]">) {
  try {
    const { id } = await ctx.params;
    const b = Op.parse(await readJson(req));
    const r =
      b.op === "edit" ? await editReminder(id, b.changes)
      : b.op === "done" ? await completeReminder(id)
      : b.op === "snooze" ? await snoozeReminder(id, b.until ?? { dueLocal: b.dueLocal!, timezone: b.timezone ?? "" })
      : b.op === "dismiss" ? await dismissReminder(id)
      : await reopenReminder(id);
    if (!r) throw new HttpError(404, "Reminder not found");
    return json({ reminder: r });
  } catch (e) {
    return errorResponse(e);
  }
}
