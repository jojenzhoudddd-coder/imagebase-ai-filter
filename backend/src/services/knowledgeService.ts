/**
 * Knowledge service — CRUD + semantic search for Agent knowledge base.
 * Uses embeddingService for vector operations and Prisma for storage.
 */

import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";
import { generateId } from "./idGenerator.js";
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
  workspaceId?: string | null;
  title: string;
  content: string;
  sourceUrl?: string | null;
  sourceType?: string;
  tags?: string[];
}

// ─── Per-agent serial queue ────────────────────────────────────────────
// Agent calls learn_from_text many times in parallel (same model turn).
// Without serialisation the merge-window check races and every call creates
// a separate entry. A simple promise-chain per agentId fixes this.
const agentQueues = new Map<string, Promise<any>>();

function queueKey(agentId: string, workspaceId?: string | null): string {
  return `${agentId}:${workspaceId ?? "_global"}`;
}

function workspaceWhere(workspaceId?: string | null): Record<string, unknown> {
  return workspaceId ? { workspaceId } : {};
}

function enqueue<T>(agentId: string, workspaceId: string | null | undefined, fn: () => Promise<T>): Promise<T> {
  const key = queueKey(agentId, workspaceId);
  const prev = agentQueues.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  agentQueues.set(key, next);
  return next;
}

const MERGE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

export function addKnowledge(input: KnowledgeCreateInput) {
  return enqueue(input.agentId, input.workspaceId, () => _addKnowledgeImpl(input));
}

async function _addKnowledgeImpl(input: KnowledgeCreateInput) {
  const cutoff = new Date(Date.now() - MERGE_WINDOW_MS);
  const existing = await prisma.knowledgeEntry.findFirst({
    where: {
      agentId: input.agentId,
      ...workspaceWhere(input.workspaceId),
      chunkIndex: 0,
      createdAt: { gte: cutoff },
    },
    orderBy: { createdAt: "desc" },
  });

  if (existing) {
    let existingContent = existing.content;
    if (existing.parentId) {
      const allChunks = await prisma.knowledgeEntry.findMany({
        where: { parentId: existing.parentId },
        orderBy: { chunkIndex: "asc" },
        select: { content: true },
      });
      existingContent = allChunks.map((c) => c.content).join("");
      await prisma.knowledgeEntry.deleteMany({ where: { parentId: existing.parentId } });
    } else {
      await prisma.knowledgeEntry.delete({ where: { id: existing.id } });
    }

    const docTitle = existing.title;
    const mergedContent = existingContent + "\n\n"
      + (input.title !== docTitle ? `## ${input.title}\n\n` : "")
      + input.content;
    const mergedTags = Array.from(new Set([...(existing.tags as string[]), ...(input.tags ?? [])])).slice(0, 5);
    const sourceUrl = input.sourceUrl ?? existing.sourceUrl;

    const chunks = chunkText(mergedContent);
    const embeddings = await embed(chunks);
    const parentId = existing.parentId ?? `ke_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

    const entries = await Promise.all(
      chunks.map(async (chunk, i) =>
        prisma.knowledgeEntry.create({
          data: {
            id: await generateId("knowledgeEntry"),
            agentId: input.agentId, workspaceId: input.workspaceId ?? null, title: docTitle, content: chunk,
            sourceUrl: sourceUrl ?? null, sourceType: input.sourceType ?? existing.sourceType,
            tags: mergedTags, embedding: embeddings ? embeddings[i] : undefined,
            chunkIndex: i, parentId: chunks.length > 1 ? parentId : null,
          },
        }),
      ),
    );
    return { count: entries.length, parentId, firstId: entries[0]?.id, merged: true };
  }

  const chunks = chunkText(input.content);
  const embeddings = await embed(chunks);
  const parentId = `ke_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

  const entries = await Promise.all(
    chunks.map(async (chunk, i) =>
      prisma.knowledgeEntry.create({
        data: {
          id: await generateId("knowledgeEntry"),
          agentId: input.agentId, workspaceId: input.workspaceId ?? null, title: input.title, content: chunk,
          sourceUrl: input.sourceUrl ?? null, sourceType: input.sourceType ?? "web",
          tags: (input.tags ?? []).slice(0, 5), embedding: embeddings ? embeddings[i] : undefined,
          chunkIndex: i, parentId: chunks.length > 1 ? parentId : null,
        },
      }),
    ),
  );
  return { count: entries.length, parentId, firstId: entries[0]?.id };
}

export async function listKnowledge(
  agentId: string,
  opts?: { limit?: number; offset?: number; tag?: string; workspaceId?: string | null },
) {
  const limit = Math.min(opts?.limit ?? 20, 100);
  const offset = opts?.offset ?? 0;
  const where: any = { agentId, ...workspaceWhere(opts?.workspaceId), chunkIndex: 0 }; // Only return first chunk (parent)
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

export async function getKnowledge(agentId: string, id: string) {
  return getKnowledgeScoped(agentId, id);
}

export async function getKnowledgeScoped(agentId: string, id: string, workspaceId?: string | null) {
  const entry = await prisma.knowledgeEntry.findUnique({ where: { id } });
  if (!entry || entry.agentId !== agentId) return null;
  if (workspaceId && entry.workspaceId !== workspaceId) return null;
  if (entry.parentId) {
    const chunks = await prisma.knowledgeEntry.findMany({
      where: { parentId: entry.parentId },
      orderBy: { chunkIndex: "asc" },
      select: { content: true },
    });
    return { id: entry.id, title: entry.title, content: chunks.map((c) => c.content).join(""),
      sourceUrl: entry.sourceUrl, sourceType: entry.sourceType, tags: entry.tags, createdAt: entry.createdAt.toISOString(), workspaceId: entry.workspaceId };
  }
  return { id: entry.id, title: entry.title, content: entry.content,
    sourceUrl: entry.sourceUrl, sourceType: entry.sourceType, tags: entry.tags, createdAt: entry.createdAt.toISOString(), workspaceId: entry.workspaceId };
}

// ─── Update ─────────────────────────────────────────────────────────────
// Update an existing knowledge entry by id (any chunk's id resolves to its
// parent group). All four input fields are optional — only non-undefined
// fields override existing. Two modes:
//   - "replace" (default): input.content fully replaces existing content
//   - "append":  input.content appended after existing (then re-chunked)
//
// Why this matters: agent's only previous option was delete + re-create,
// which churns the parentId / firstId. External references (memories,
// activity logs, future Mention-style backrefs) that point at a knowledge
// entry would break. updateKnowledge preserves the original parentId so
// the document remains "the same" from outside; only the chunk rows get
// rebuilt in-place. firstId DOES change (chunks are deleted+reinserted)
// but parentId is the stable identity.
//
// Runs inside the per-agent serial queue so concurrent learn_from_text
// calls don't race with an in-flight update on the same agent.

export interface KnowledgeUpdateInput {
  agentId: string;
  workspaceId?: string | null;
  id: string;
  title?: string;
  content?: string;
  sourceUrl?: string | null;
  tags?: string[];
  mode?: "replace" | "append";
}

export function updateKnowledge(input: KnowledgeUpdateInput) {
  return enqueue(input.agentId, input.workspaceId, () => _updateKnowledgeImpl(input));
}

async function _updateKnowledgeImpl(input: KnowledgeUpdateInput) {
  // 1. Resolve target — id may be any chunk; we want the whole group.
  const probe = await prisma.knowledgeEntry.findUnique({ where: { id: input.id } });
  if (!probe || probe.agentId !== input.agentId || (input.workspaceId && probe.workspaceId !== input.workspaceId)) {
    return { ok: false as const, error: "not found" };
  }

  // 2. Reassemble existing content (needed for append mode AND to keep
  //    title/sourceUrl/tags fall-through behavior consistent).
  let existingContent: string;
  let existingChunks: { id: string }[];
  if (probe.parentId) {
    const allChunks = await prisma.knowledgeEntry.findMany({
      where: { parentId: probe.parentId },
      orderBy: { chunkIndex: "asc" },
      select: { id: true, content: true },
    });
    existingContent = allChunks.map((c) => c.content).join("");
    existingChunks = allChunks.map((c) => ({ id: c.id }));
  } else {
    existingContent = probe.content;
    existingChunks = [{ id: probe.id }];
  }

  // 3. Compute new fields. Only fall through to existing when caller didn't
  //    pass the field at all (undefined). Explicit null on sourceUrl clears
  //    it; empty array on tags clears it.
  const mode = input.mode ?? "replace";
  const newTitle = input.title ?? probe.title;
  const newSourceUrl = input.sourceUrl === undefined ? probe.sourceUrl : input.sourceUrl;
  const newTags = input.tags === undefined ? (probe.tags as string[]) : input.tags.slice(0, 5);
  const newContent = (() => {
    if (input.content === undefined) return existingContent; // metadata-only edit
    if (mode === "append") return existingContent + "\n\n" + input.content;
    return input.content; // replace
  })();

  // 4. Re-chunk + re-embed, then atomically delete old chunks and insert new.
  const chunks = chunkText(newContent);
  const embeddings = await embed(chunks);
  // Reuse parentId for stability; if the original was single-chunk and now
  // we have multiple, mint one. If now single-chunk, we still keep the old
  // parentId on the row so external references resolve via getKnowledge —
  // but null it on the row when only 1 chunk to match addKnowledge's shape.
  const stableParentId = probe.parentId
    ?? (chunks.length > 1
      ? `ke_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
      : null);

  // Best-effort transactional swap: delete all existing chunks then insert
  // new ones. If insert throws midway we lose the old document — acceptable
  // tradeoff vs. the complexity of two-phase swap; agent can re-learn from
  // the model output that drove the update if it really matters.
  await prisma.$transaction(async (tx) => {
    if (probe.parentId) {
      await tx.knowledgeEntry.deleteMany({ where: { parentId: probe.parentId } });
    } else {
      await tx.knowledgeEntry.delete({ where: { id: probe.id } });
    }
    await Promise.all(
      chunks.map(async (chunk, i) =>
        tx.knowledgeEntry.create({
          data: {
            id: await generateId("knowledgeEntry"),
            agentId: input.agentId,
            workspaceId: probe.workspaceId ?? input.workspaceId ?? null,
            title: newTitle,
            content: chunk,
            sourceUrl: newSourceUrl ?? null,
            sourceType: probe.sourceType,
            tags: newTags,
            embedding: embeddings ? embeddings[i] : undefined,
            chunkIndex: i,
            parentId: chunks.length > 1 ? stableParentId : null,
          },
        }),
      ),
    );
  });

  // 5. Reload firstId for return — caller often wants to navigate to it.
  const first = await prisma.knowledgeEntry.findFirst({
    where: stableParentId
      ? { parentId: stableParentId, chunkIndex: 0 }
      : { agentId: input.agentId, ...workspaceWhere(input.workspaceId), title: newTitle, chunkIndex: 0 },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });

  return {
    ok: true as const,
    count: chunks.length,
    parentId: stableParentId,
    firstId: first?.id ?? null,
    mode,
    previousChunkCount: existingChunks.length,
  };
}

export async function deleteKnowledge(agentId: string, id: string) {
  return deleteKnowledgeScoped(agentId, id);
}

export async function deleteKnowledgeScoped(agentId: string, id: string, workspaceId?: string | null) {
  // Find entry to get parentId
  const entry = await prisma.knowledgeEntry.findUnique({ where: { id } });
  if (!entry || entry.agentId !== agentId || (workspaceId && entry.workspaceId !== workspaceId)) return false;

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
  opts?: { workspaceId?: string | null },
) {
  const queryEmbedding = await embed([query]);

  if (!queryEmbedding) {
    // Fallback: text search if embedding not available
    const results = await prisma.knowledgeEntry.findMany({
      where: {
        agentId,
        ...workspaceWhere(opts?.workspaceId),
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
    where: { agentId, ...workspaceWhere(opts?.workspaceId), embedding: { not: null } } as any,
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
