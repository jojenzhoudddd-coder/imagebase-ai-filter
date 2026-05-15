// ─── IdeaBlock schemas (shared by REST routes + MCP tools) ───
//
// Single source of truth for block-level API request/response shapes.
// Both `backend/src/routes/ideaRoutes.ts` and
// `backend/mcp-server/src/tools/ideaTools.ts` import from here.
// See CLAUDE.md "MCP Server 与 REST API 的同步规则".

import { z } from "zod";

// ─── Block types ─────────────────────────────────────────────────────────

export const IdeaBlockType = z.enum([
  "heading",
  "paragraph",
  "list",
  "code",
  "quote",
  "divider",
  "html",
  "table",
]);
export type IdeaBlockType = z.infer<typeof IdeaBlockType>;

// ─── Block props (type-specific metadata) ────────────────────────────────

export const HeadingProps = z.object({
  level: z.number().int().min(1).max(6),
  slug: z.string(),
  text: z.string().optional(),
});

export const ListProps = z.object({
  ordered: z.boolean(),
  startsAt: z.number().int().optional(),
});

export const CodeProps = z.object({
  language: z.string().nullable().optional(),
});

export const TableProps = z.object({
  columns: z.number().int().min(1).optional(),
  hasHeader: z.boolean().optional(),
});

/** Loose props schema — accepts any JSON object. Type-specific validation
 *  is done at the application layer, not at the API boundary, since the
 *  set of block types is extensible. */
export const BlockProps = z.record(z.string(), z.unknown()).default({});

// ─── Create block request ────────────────────────────────────────────────

export const CreateBlockSchema = z.object({
  /** Block type. Defaults to "paragraph" if omitted. */
  type: IdeaBlockType.default("paragraph"),
  /** Raw Markdown content for the block. */
  content: z.string(),
  /** Type-specific metadata. */
  props: BlockProps.optional(),
  /** Parent block ID for nesting (null = top-level). */
  parentId: z.string().nullable().optional(),
  /** Insert after this block ID. If omitted, appends to end of siblings. */
  afterBlockId: z.string().nullable().optional(),
});
export type CreateBlockInput = z.infer<typeof CreateBlockSchema>;

// ─── Patch block request ─────────────────────────────────────────────────

export const PatchBlockSchema = z.object({
  /** New raw Markdown content. */
  content: z.string().optional(),
  /** Transform the block to another type (auto-adjusts markers). */
  transformTo: z.enum([
    "paragraph", "heading-1", "heading-2", "heading-3",
    "heading-4", "heading-5", "heading-6", "quote",
    "list-bullet", "divider",
  ]).optional(),
  /** Optimistic concurrency: client sends its known block version.
   *  Server returns 409 if it doesn't match. */
  baseVersion: z.number().int().min(0).optional(),
  /** Arbitrary props to merge into the block's existing props (e.g. column layout). */
  props: z.record(z.unknown()).optional(),
});
export type PatchBlockInput = z.infer<typeof PatchBlockSchema>;

// ─── Batch operations ────────────────────────────────────────────────────

export const BatchCreateOp = z.object({
  op: z.literal("create"),
  /** Temporary client-side ID. The response maps tempId -> real ID. */
  tempId: z.string().optional(),
  type: IdeaBlockType.default("paragraph"),
  content: z.string(),
  props: BlockProps.optional(),
  parentId: z.string().nullable().optional(),
  afterBlockId: z.string().nullable().optional(),
});

export const BatchUpdateOp = z.object({
  op: z.literal("update"),
  blockId: z.string(),
  content: z.string().optional(),
  transformTo: z.enum([
    "paragraph", "heading-1", "heading-2", "heading-3",
    "heading-4", "heading-5", "heading-6", "quote",
    "list-bullet", "divider",
  ]).optional(),
  baseVersion: z.number().int().min(0).optional(),
});

export const BatchDeleteOp = z.object({
  op: z.literal("delete"),
  blockId: z.string(),
});

export const BatchMoveOp = z.object({
  op: z.literal("move"),
  blockId: z.string(),
  toIndex: z.number().int().min(0),
});

export const BatchOperation = z.discriminatedUnion("op", [
  BatchCreateOp,
  BatchUpdateOp,
  BatchDeleteOp,
  BatchMoveOp,
]);
export type BatchOperation = z.infer<typeof BatchOperation>;

export const BatchBlockUpdateSchema = z.object({
  operations: z.array(BatchOperation).min(1).max(100),
});
export type BatchBlockUpdateInput = z.infer<typeof BatchBlockUpdateSchema>;

// ─── Response shapes ─────────────────────────────────────────────────────

export const BlockResponseSchema = z.object({
  id: z.string(),
  ideaId: z.string(),
  parentId: z.string().nullable(),
  order: z.number(),
  type: z.string(),
  content: z.string(),
  props: z.record(z.string(), z.unknown()),
  version: z.number().int(),
});
export type BlockResponse = z.infer<typeof BlockResponseSchema>;
