import { z } from "zod";
import { answerQuestion } from "@/lib/answer";
import { hybridOptions, semanticScores } from "@/lib/indexing";
import { fullTextIds, listMemories } from "@/lib/store";
import { errorResponse, json, readJson } from "../../_http";

const Body = z.object({ q: z.string().trim().min(2, "Ask a question.").max(300) }).strict();

/**
 * Answer a question from the signed-in user's own memories. Retrieval comes first; with no match no model is called.
 * Every citation in the response was checked against the saved memory it points to.
 */
export async function POST(req: Request) {
  try {
    const { q } = Body.parse(await readJson(req));
    const memories = await listMemories();
    const fts = await fullTextIds(q).catch(() => new Map<string, number>()); // search still works without the database index
    const sem = await semanticScores(q, memories);
    return json(await answerQuestion(q, memories, { fts, ...hybridOptions(sem) }));
  } catch (e) {
    return errorResponse(e);
  }
}
