// ─── Demo schemas (shared by REST routes + MCP tools) ───
//
// Single source of truth for Vibe Demo input/output shape. Both
// `backend/src/routes/demoRoutes.ts` (+ demoRuntimeRoutes) and
// `backend/mcp-server/src/tools/demoWriteTools.ts` import from here.
// See CLAUDE.md "MCP Server 与 REST API 的同步规则".

import { z } from "zod";

// ─── Capabilities ─────────────────────────────────────────────────────────

export const TableCapability = z.enum([
  "query",
  "getRecord",
  "describeTable",
  "createRecord",
  "updateRecord",
  "deleteRecord",
]);
export type TableCapability = z.infer<typeof TableCapability>;

export const IdeaCapability = z.enum(["listIdeas", "readIdea"]);
export type IdeaCapability = z.infer<typeof IdeaCapability>;

export const Capability = z.union([TableCapability, IdeaCapability]);
export type Capability = z.infer<typeof Capability>;

/** Capability map: resourceId → allowed operations. Table and Idea ids
 * mix in the same record (runtime guards pick the right subset). */
export const CapabilitiesSchema = z.record(
  z.string(),
  z.array(Capability).min(1),
);
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

// ─── Template / status enums ──────────────────────────────────────────────

export const DemoTemplate = z.enum(["static", "react-spa"]);
export type DemoTemplate = z.infer<typeof DemoTemplate>;

export const BuildStatus = z.enum(["idle", "building", "success", "error"]);
export type BuildStatus = z.infer<typeof BuildStatus>;

// ─── Create / update ──────────────────────────────────────────────────────

export const createDemoSchema = z.object({
  workspaceId: z.string().min(1),
  name: z.string().min(1).max(200),
  template: DemoTemplate.default("static"),
  parentId: z.string().optional(),
});
export type CreateDemoInput = z.infer<typeof createDemoSchema>;

export const renameDemoSchema = z.object({
  name: z.string().min(1).max(200),
});
export type RenameDemoInput = z.infer<typeof renameDemoSchema>;

export const updateCapabilitiesSchema = z.object({
  dataTables: z.array(z.string()).default([]),
  dataIdeas: z.array(z.string()).default([]),
  capabilities: CapabilitiesSchema.default({}),
});
export type UpdateCapabilitiesInput = z.infer<typeof updateCapabilitiesSchema>;

// ─── Files ────────────────────────────────────────────────────────────────

export const writeDemoFileSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(200)
    .refine(
      (p) =>
        !p.includes("..") &&
        !p.startsWith("/") &&
        !p.startsWith("\\") &&
        /^[a-zA-Z0-9_\-./]+$/.test(p),
      "path must be a safe relative path (no .., no leading slash, alnum/._- only)",
    ),
  content: z.string().max(500_000), // 500KB hard cap per file — soft limit in prompt
});
export type WriteDemoFileInput = z.infer<typeof writeDemoFileSchema>;

export const deleteDemoFileSchema = z.object({
  path: z.string().min(1),
});
export type DeleteDemoFileInput = z.infer<typeof deleteDemoFileSchema>;

export const demoFileEntrySchema = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
  updatedAt: z.string(),
});
export type DemoFileEntry = z.infer<typeof demoFileEntrySchema>;

// ─── Build ────────────────────────────────────────────────────────────────

export const buildDemoSchema = z.object({
  // no inputs today — future: build options (minify / sourcemaps)
});

export const buildResultSchema = z.object({
  ok: z.boolean(),
  durationMs: z.number().int().nonnegative().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  fileCount: z.number().int().nonnegative().optional(),
  logTail: z.string().optional(),
  error: z.string().optional(),
});
export type BuildResult = z.infer<typeof buildResultSchema>;

// ─── Publish ──────────────────────────────────────────────────────────────

export const publishDemoSchema = z.object({
  confirmed: z.boolean().default(false),
});
export type PublishDemoInput = z.infer<typeof publishDemoSchema>;

export const publishResultSchema = z.object({
  ok: z.literal(true),
  demoId: z.string(),
  slug: z.string(),
  publishedVersion: z.number().int().positive(),
  url: z.string(),
});
export type PublishResult = z.infer<typeof publishResultSchema>;

// ─── Summary / detail (returned from REST + MCP) ──────────────────────────

export const demoSummarySchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  parentId: z.string().nullable(),
  order: z.number().int(),
  name: z.string(),
  template: DemoTemplate,
  version: z.number().int().nonnegative(),
  lastBuildStatus: BuildStatus.nullable(),
  lastBuildAt: z.string().nullable(),
  publishSlug: z.string().nullable(),
  publishedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DemoSummary = z.infer<typeof demoSummarySchema>;

export const demoDetailSchema = demoSummarySchema.extend({
  dataTables: z.array(z.string()),
  dataIdeas: z.array(z.string()),
  capabilities: CapabilitiesSchema,
  lastBuildError: z.string().nullable(),
  publishedVersion: z.number().int().positive().nullable(),
  files: z.array(demoFileEntrySchema).optional(),
});
export type DemoDetail = z.infer<typeof demoDetailSchema>;

// ─── Runtime request shapes (for /api/demo-runtime/*) ─────────────────────

export const runtimeQuerySchema = z.object({
  tableId: z.string().min(1),
  filter: z.unknown().optional(),
  sort: z.unknown().optional(),
  limit: z.number().int().positive().max(10_000).optional(),
});
export type RuntimeQueryInput = z.infer<typeof runtimeQuerySchema>;

export const runtimeRecordWriteSchema = z.object({
  tableId: z.string().min(1),
  cells: z.record(z.string(), z.unknown()),
});

export const runtimeBatchCreateSchema = z.object({
  tableId: z.string().min(1),
  records: z.array(z.object({ cells: z.record(z.string(), z.unknown()) })).max(500),
});

export const runtimeBatchUpdateSchema = z.object({
  tableId: z.string().min(1),
  updates: z
    .array(
      z.object({
        recordId: z.string().min(1),
        cells: z.record(z.string(), z.unknown()),
      }),
    )
    .max(500),
});

export const runtimeBatchDeleteSchema = z.object({
  tableId: z.string().min(1),
  recordIds: z.array(z.string().min(1)).max(500),
});

// ─── Slug generation ──────────────────────────────────────────────────────

/** Publish slug is 12-char base62 — distinct from internal ids which are
 * 12-digit numeric. The slug's attacker model is "enumeration by random
 * guessing", which the wider alphabet addresses (62^12 ≈ 3×10^21). */
const SLUG_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const SLUG_LEN = 12;

export function generateSlugCandidate(): string {
  const bytes = crypto.getRandomValues(new Uint32Array(SLUG_LEN));
  let out = "";
  for (let i = 0; i < SLUG_LEN; i++) {
    out += SLUG_ALPHABET[bytes[i]! % SLUG_ALPHABET.length];
  }
  return out;
}

declare const crypto: {
  getRandomValues(arr: Uint32Array): Uint32Array;
};
