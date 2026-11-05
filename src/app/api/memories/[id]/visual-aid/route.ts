import { connection } from "next/server";
import { ArtifactNotFound, createVisualAid } from "@/lib/meta-services";
import { listArtifacts } from "@/lib/store";
import { errorResponse, json } from "../../../_http";

export async function GET(_req: Request, ctx: RouteContext<"/api/memories/[id]/visual-aid">) {
  await connection();
  try {
    const { id } = await ctx.params;
    return json({ artifacts: await listArtifacts({ memoryId: id, kind: "visual_aid" }) });
  } catch (e) {
    return errorResponse(e);
  }
}

/**
 * "Create visual aid": make ONE illustration from this memory's own saved statements. Only ever called by a user
 * action; capture never generates images. Always makes a new artifact, so earlier ones are kept (regeneration).
 */
export async function POST(_req: Request, ctx: RouteContext<"/api/memories/[id]/visual-aid">) {
  try {
    const { id } = await ctx.params;
    return json({ artifact: await createVisualAid(id) }, 201);
  } catch (e) {
    if (e instanceof ArtifactNotFound) return json({ error: e.message }, 404);
    return errorResponse(e);
  }
}
