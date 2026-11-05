import { z } from "zod";
import { ArtifactNotFound, startSegmentation } from "@/lib/meta-services";
import { errorResponse, json, readJson } from "../../../_http";

const Body = z.object({ target: z.string().trim().min(1, "Say what to look for.").max(120) });

/** "Explore image": find where a described thing is in a saved image (SAM 3.1 boxes). The original is never modified. */
export async function POST(req: Request, ctx: RouteContext<"/api/memories/[id]/explore">) {
  try {
    const { id } = await ctx.params;
    const { target } = Body.parse(await readJson(req));
    return json({ artifact: await startSegmentation(id, target) }, 201);
  } catch (e) {
    if (e instanceof ArtifactNotFound) return json({ error: e.message }, 404);
    return errorResponse(e);
  }
}
