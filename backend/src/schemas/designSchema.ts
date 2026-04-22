// ─── Design schemas (shared by REST routes + MCP tools) ───
//
// In the Chat Agent-facing vocabulary, Design corresponds to the artifact container
// (future rename target: "Taste"; see docs/taste-chatbot-plan.md 术语对齐 section).
// For Phase 1 we keep the code name "Design".

import { z } from "zod";

// ─── Create / rename ───

export const createDesignSchema = z.object({
  workspaceId: z.string().min(1),
  name: z.string().min(1).max(200),
  parentId: z.string().nullable().optional(),
  order: z.number().int().optional(),
});

export type CreateDesignInput = z.infer<typeof createDesignSchema>;

export const renameDesignSchema = z.object({
  name: z.string().min(1).max(200),
});

export type RenameDesignInput = z.infer<typeof renameDesignSchema>;

// ─── Auto-layout trigger ───

export const autoLayoutResponseSchema = z.object({
  designId: z.string(),
  updatedCount: z.number().int().nonnegative(),
  bounds: z.object({
    width: z.number(),
    height: z.number(),
  }),
});

export type AutoLayoutResponse = z.infer<typeof autoLayoutResponseSchema>;

// ─── Summary (for list_designs) ───

export const designSummarySchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  parentId: z.string().nullable(),
  order: z.number().int(),
  tasteCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type DesignSummary = z.infer<typeof designSummarySchema>;
