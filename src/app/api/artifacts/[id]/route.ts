import { after } from "next/server";
import { z } from "zod";
import { ArtifactNotFound, confirmRegionReading, deleteMyArtifact, interpretRegion, retrySegmentation, retryVisualAid } from "@/lib/meta-services";
import { processMemory } from "@/lib/process";
import { getArtifact } from "@/lib/store";
import { errorResponse, HttpError, json, readJson } from "../../_http";

const Body = z.discriminatedUnion("op", [
  z.object({ op: z.literal("retry") }),
  /** segmentation: have Muse Spark read the chosen region */
  z.object({ op: z.literal("interpret"), regionId: z.number().int() }),
  /** region_reading: the user confirms; it becomes a linked memory */
  z.object({ op: z.literal("confirm") }),
]);

export async function GET(_req: Request, ctx: RouteContext<"/api/artifacts/[id]">) {
  try {
    const { id } = await ctx.params;
    const a = await getArtifact(id);
    if (!a) throw new HttpError(404, "Not found");
    return json({ artifact: a });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: Request, ctx: RouteContext<"/api/artifacts/[id]">) {
  try {
    const { id } = await ctx.params;
    const body = Body.parse(await readJson(req));
    const a = await getArtifact(id);
    if (!a) throw new HttpError(404, "Not found");
    if (body.op === "retry") {
      if (a.status !== "failed") throw new HttpError(409, "Only a failed item can be retried.");
      if (a.kind === "visual_aid") return json({ artifact: await retryVisualAid(id) });
      if (a.kind === "segmentation") return json({ artifact: await retrySegmentation(id) });
      throw new HttpError(409, "This item can't be retried here.");
    }
    if (body.op === "interpret") return json({ artifact: await interpretRegion(id, body.regionId) }, 201);
    const { memory, artifact, created } = await confirmRegionReading(id);
    if (created && memory.status === "pending") {
      after(() => processMemory(memory.id).catch((e) => console.error(`[explore] background processing failed: ${e instanceof Error ? e.name : "error"}`)));
    }
    return json({ memory, artifact, created }, created ? 201 : 200);
  } catch (e) {
    if (e instanceof ArtifactNotFound) return json({ error: e.message }, 404);
    return errorResponse(e);
  }
}

export async function DELETE(_req: Request, ctx: RouteContext<"/api/artifacts/[id]">) {
  try {
    const { id } = await ctx.params;
    if (!(await deleteMyArtifact(id))) throw new HttpError(404, "Not found");
    return json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
