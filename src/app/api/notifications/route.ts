import { connection } from "next/server";
import { z } from "zod";
import { listDeliveries, markDeliveriesRead } from "@/lib/store";
import { errorResponse, json, readJson } from "../_http";

/** Your notification inbox (in-app deliveries) and delivery history, newest first. */
export async function GET(req: Request) {
  await connection();
  try {
    const q = new URL(req.url).searchParams;
    const unreadOnly = q.get("unread") === "1";
    const deliveries = await listDeliveries({ unreadOnly, limit: 100, reminderId: q.get("reminderId") ?? undefined });
    const unread = unreadOnly ? deliveries.length : (await listDeliveries({ unreadOnly: true, limit: 200 })).length;
    return json({ deliveries, unread });
  } catch (e) {
    return errorResponse(e);
  }
}

const Op = z.object({ op: z.literal("read"), ids: z.union([z.literal("all"), z.array(z.string().min(1).max(100)).min(1).max(100)]) }).strict();

export async function PATCH(req: Request) {
  try {
    const { ids } = Op.parse(await readJson(req));
    return json({ changed: await markDeliveriesRead(ids) });
  } catch (e) {
    return errorResponse(e);
  }
}
