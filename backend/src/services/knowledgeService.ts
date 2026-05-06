/**
 * Knowledge service — CRUD + semantic search for Agent knowledge base.
 * Uses embeddingService for vector operations and Prisma for storage.
 */

import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";
import { embed, cosineSimilarity } from "./embeddingService.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// ─── Chunking ───────────────────────────────────────────────────────────

const CHUNK_SIZE = 800; // chars (~500 tokens for CJK)
const CHUNK_OVERLAP = 100;

function chunkText(text: string): string[] {
  if (text.length <= CHUNK_SIZE) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + CHUNK_SIZE, text.length);
    chunks.push(text.slice(start, end));
    start += CHUNK_SIZE - CHUNK_OVERLAP;
  }
  return chunks;
}

// ─── CRUD ───────────────────────────────────────────────────────────────

export interface KnowledgeCreateInput {
  agentId: string;
  title: string;
  content: string;
  sourceUrl?: string | null;
  sourceType?: string;
  tags?: string[];
}

export async function addKnowledge(input: KnowledgeCreateInput) {
  const chunks = chunkText(input.content);
  const embeddings = await embed(chunks);
  const parentId = `ke_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

  const entries = await Promise.all(
    chunks.map((chunk, i) =>
      prisma.knowledgeEntry.create({
        data: {
          agentId: input.agentId,
          title: input.title,
          content: chunk,
          sourceUrl: input.sourceUrl ?? null,
          sourceType: input.sourceType ?? "web",
          tags: input.tags ?? [],
          embedding: embeddings ? embeddings[i] : undefined,
          chunkIndex: i,
          parentId: chunks.length > 1 ? parentId : null,
        },
      }),
    ),
  );
  return { count: entries.length, parentId, firstId: entries[0]?.id };
}

export async function listKnowledge(
  agentId: string,
  opts?: { limit?: number; offset?: number; tag?: string },
) {
  const limit = Math.min(opts?.limit ?? 20, 100);
  const offset = opts?.offset ?? 0;
  const where: any = { agentId, chunkIndex: 0 }; // Only return first chunk (parent)
  if (opts?.tag) where.tags = { has: opts.tag };

  const [entries, total] = await Promise.all([
    prisma.knowledgeEntry.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: offset,
      take: limit,
      select: {
        id: true,
        title: true,
        content: true,
        sourceUrl: true,
        sourceType: true,
        tags: true,
        createdAt: true,
        parentId: true,
      },
    }),
    prisma.knowledgeEntry.count({ where }),
  ]);

  return {
    entries: entries.map((e) => ({
      ...e,
      content: e.content.slice(0, 200), // truncate for listing
      createdAt: e.createdAt.toISOString(),
    })),
    total,
    hasMore: offset + limit < total,
  };
}

export async function deleteKnowledge(agentId: string, id: string) {
  // Find entry to get parentId
  const entry = await prisma.knowledgeEntry.findUnique({ where: { id } });
  if (!entry || entry.agentId !== agentId) return false;

  if (entry.parentId) {
    // Delete all chunks with same parentId
    await prisma.knowledgeEntry.deleteMany({ where: { parentId: entry.parentId } });
  } else {
    await prisma.knowledgeEntry.delete({ where: { id } });
  }
  return true;
}

// ─── Semantic search ────────────────────────────────────────────────────

export async function searchKnowledge(
  agentId: string,
  query: string,
  limit = 5,
) {
  const queryEmbedding = await embed([query]);

  if (!queryEmbedding) {
    // Fallback: text search if embedding not available
    const results = await prisma.knowledgeEntry.findMany({
      where: {
        agentId,
        OR: [
          { title: { contains: query, mode: "insensitive" } },
          { content: { contains: query, mode: "insensitive" } },
        ],
      },
      take: limit,
      orderBy: { createdAt: "desc" },
      select: { id: true, title: true, content: true, sourceUrl: true, tags: true, createdAt: true },
    });
    return results.map((r) => ({ ...r, score: 1.0, createdAt: r.createdAt.toISOString() }));
  }

  // Application-level cosine similarity (dev mode; prod uses pgvector)
  const allEntries = await prisma.knowledgeEntry.findMany({
    where: { agentId, embedding: { not: null } } as any,
    select: { id: true, title: true, content: true, sourceUrl: true, tags: true, embedding: true, createdAt: true },
  });

  const scored = allEntries
    .map((e) => ({
      id: e.id,
      title: e.title,
      content: e.content,
      sourceUrl: e.sourceUrl,
      tags: e.tags,
      createdAt: e.createdAt.toISOString(),
      score: cosineSimilarity(queryEmbedding[0], e.embedding as number[]),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored;
}
