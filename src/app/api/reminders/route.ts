import { connection } from "next/server";
import { z } from "zod";
import { createReminder, NewReminder } from "@/lib/reminders";
import { ReminderStatus } from "@/lib/agent/schema";
import { listReminders } from "@/lib/store";
import { errorResponse, json, readJson } from "../_http";

export async function GET(req: Request) {
  await connection();
  try {
    const q = new URL(req.url).searchParams;
    const status = q.get("status") ? z.array(ReminderStatus).parse(q.get("status")!.split(",")) : undefined;
    return json({ reminders: await listReminders({ memoryId: q.get("memoryId") ?? undefined, status }) });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    return json({ reminder: await createReminder(NewReminder.parse(await readJson(req))) }, 201);
  } catch (e) {
    return errorResponse(e);
  }
}
