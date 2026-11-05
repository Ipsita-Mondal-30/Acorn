import { after } from "next/server";
import { z } from "zod";
import { AiError } from "@/lib/ai/errors";
import { ArtifactNotFound, discardVoice, retryVoice, saveVoiceAsMemory } from "@/lib/meta-services";
import { processMemory } from "@/lib/process";
import { getArtifact } from "@/lib/store";
import { errorResponse, HttpError, json, readJson } from "../../_http";

const Body = z.discriminatedUnion("op", [
  /** the user read (and maybe corrected) the transcript and wants it saved as a memory */
  z.object({ op: z.literal("save"), text: z.string().trim().min(1, "There is nothing to save yet.").max(20_000) }),
  z.object({ op: z.literal("retry") }),
]);

const notFound = () => new HttpError(404, "Voice note not found");

export async function POST(req: Request, ctx: RouteContext<"/api/voice/[id]">) {
  try {
    const { id } = await ctx.params;
    const body = Body.parse(await readJson(req));
    const cur = await getArtifact(id);
    if (!cur || cur.kind !== "voice") throw notFound();
    if (body.op === "retry") return json({ artifact: await retryVoice(id) });
    const { memory, artifact, created } = await saveVoiceAsMemory(id, body.text);
    if (created && memory.status === "pending") {
      after(() => processMemory(memory.id).catch((e) => console.error(`[voice] background processing failed: ${e instanceof Error ? e.name : "error"}`)));
    }
    return json({ memory, artifact, created }, created ? 201 : 200);
  } catch (e) {
    if (e instanceof ArtifactNotFound) return json({ error: e.message }, 404);
    return errorResponse(e);
  }
}

/** Discard a recording that was never saved as a memory. */
export async function DELETE(_req: Request, ctx: RouteContext<"/api/voice/[id]">) {
  try {
    const { id } = await ctx.params;
    if (!(await discardVoice(id))) throw notFound();
    return json({ ok: true });
  } catch (e) {
    if (e instanceof AiError) return json({ error: e.message }, 409);
    return errorResponse(e);
  }
}
