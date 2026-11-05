import { connection } from "next/server";
import { embeddingStatus, getEmbeddingProvider } from "@/lib/ai/embeddings";
import { indexMissing } from "@/lib/indexing";
import { embeddingHashes, listMemories } from "@/lib/store";
import { errorResponse, json } from "../_http";

/** Where semantic search stands for the signed-in user: provider status and how many memories have a vector. No model call. */
export async function GET() {
  await connection();
  try {
    const status = embeddingStatus();
    const memories = await listMemories();
    const indexed = status.model ? (await embeddingHashes(status.model)).size : 0;
    return json({ ...status, memories: memories.length, indexed });
  } catch (e) {
    return errorResponse(e);
  }
}

/** Embed memories that have no current vector. Retryable: run it again after a failure. Paid when a provider is configured. */
export async function POST() {
  try {
    return json(await indexMissing({ provider: getEmbeddingProvider() }));
  } catch (e) {
    return errorResponse(e);
  }
}
