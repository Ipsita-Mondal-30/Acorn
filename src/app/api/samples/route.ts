import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { getEnv } from "@/lib/env";
import { sampleById } from "@/lib/ai/samples";
import { captureMemory } from "@/lib/process";
import { errorResponse, HttpError, json, readJson } from "../_http";

const Body = z.object({ id: z.string().min(1).max(60) }).strict();

/**
 * Save one of the built-in demo inputs (fictional) through the normal capture pipeline: the original file is stored,
 * the memory is processed and validated. Demo mode only: in Meta mode these would be sent to the paid model.
 */
export async function POST(req: Request) {
  try {
    if (getEnv().ACORN_MODE !== "demo") throw new HttpError(403, "Samples are only available in demo mode.");
    const sample = sampleById(Body.parse(await readJson(req)).id);
    if (!sample) throw new HttpError(404, "Unknown sample");

    let result;
    if (sample.kind === "note") result = await captureMemory({ kind: "note", text: sample.text! });
    else if (sample.kind === "url") result = await captureMemory({ kind: "url", url: sample.url!, text: sample.text });
    else {
      // fileName comes from our own sample list, never from the request
      const bytes = new Uint8Array(await readFile(path.join(/*turbopackIgnore: true*/ process.cwd(), "public", "samples", sample.fileName!)));
      result = await captureMemory({ kind: sample.kind, bytes, originalName: sample.fileName!, text: sample.caption });
    }
    return json(result, result.created ? 201 : 200);
  } catch (e) {
    return errorResponse(e);
  }
}
