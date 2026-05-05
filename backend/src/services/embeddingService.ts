/**
 * Embedding service — calls ARK multimodal embedding endpoint.
 *
 * Endpoint: POST /api/v3/embeddings/multimodal
 * Input format: { model, input: [{ type: "text", text: "..." }, ...] }
 * Each call embeds one text at a time (multimodal API accepts array of
 * modality objects, not batch of texts). We batch by calling N times.
 */

const ARK_BASE_URL = process.env.ARK_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3";
const ARK_API_KEY = process.env.ARK_API_KEY || "";
const ARK_EMBEDDING_MODEL = process.env.ARK_EMBEDDING_MODEL || "";

export async function embed(texts: string[]): Promise<number[][] | null> {
  if (!ARK_EMBEDDING_MODEL || !ARK_API_KEY) return null;
  try {
    const results: number[][] = [];
    for (const text of texts) {
      const res = await fetch(`${ARK_BASE_URL}/embeddings/multimodal`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ARK_API_KEY}`,
        },
        body: JSON.stringify({
          model: ARK_EMBEDDING_MODEL,
          input: [{ type: "text", text }],
        }),
      });
      if (!res.ok) {
        console.warn("[embedding] ARK responded", res.status, await res.text().catch(() => ""));
        return null;
      }
      const data = await res.json() as any;
      // ARK multimodal returns { data: { embedding: number[] } } (single object, not array)
      const emb = Array.isArray(data.data) ? data.data[0].embedding : data.data.embedding;
      results.push(emb);
    }
    return results;
  } catch (err) {
    console.warn("[embedding] failed:", err);
    return null;
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}
