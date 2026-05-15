/**
 * Embedding service — calls ARK multimodal embedding endpoint.
 *
 * Endpoint: POST /api/v3/embeddings/multimodal
 * Input format: { model, input: [{ type: "text", text: "..." }, ...] }
 * Each call embeds one text at a time (multimodal API accepts array of
 * modality objects, not batch of texts). We batch by calling N times.
 */

import { createHash } from "crypto";

const ARK_BASE_URL = process.env.ARK_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3";
const ARK_API_KEY = process.env.ARK_API_KEY || "";
const ARK_EMBEDDING_MODEL = process.env.ARK_EMBEDDING_MODEL || "";

/* ------------------------------------------------------------------ */
/*  LRU cache for embedding vectors                                    */
/* ------------------------------------------------------------------ */

interface CacheEntry {
  vector: number[];
  createdAt: number;
}

const CACHE_MAX_ENTRIES = 500;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/** Map preserves insertion order — oldest entries are first. */
const embeddingCache = new Map<string, CacheEntry>();

function cacheKey(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function cacheGet(key: string): number[] | undefined {
  const entry = embeddingCache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.createdAt > CACHE_TTL_MS) {
    embeddingCache.delete(key);
    return undefined;
  }
  // Move to end (most-recently used)
  embeddingCache.delete(key);
  embeddingCache.set(key, entry);
  return entry.vector;
}

function cacheSet(key: string, vector: number[]): void {
  // If key already exists, delete first so re-insert moves it to end
  if (embeddingCache.has(key)) embeddingCache.delete(key);
  // Evict oldest entries if at capacity
  while (embeddingCache.size >= CACHE_MAX_ENTRIES) {
    const oldest = embeddingCache.keys().next().value;
    if (oldest !== undefined) embeddingCache.delete(oldest);
  }
  embeddingCache.set(key, { vector, createdAt: Date.now() });
}

/* ------------------------------------------------------------------ */

export async function embed(texts: string[]): Promise<number[][] | null> {
  if (!ARK_EMBEDDING_MODEL || !ARK_API_KEY) return null;
  try {
    const results: number[][] = [];
    const cacheHits: number[] = [];

    for (let i = 0; i < texts.length; i++) {
      const text = texts[i];
      const key = cacheKey(text);
      const cached = cacheGet(key);
      if (cached) {
        results.push(cached);
        cacheHits.push(i);
        continue;
      }

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
      cacheSet(key, emb);
      results.push(emb);
    }

    if (cacheHits.length > 0) {
      console.log(`[embedding] cache hit for ${cacheHits.length} texts`);
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
