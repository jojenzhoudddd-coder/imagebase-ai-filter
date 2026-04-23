// ─── Analyst schemas (shared by REST routes + MCP tools) ───
//
// Single source of truth for Analyst input/output shape. Both
// `backend/src/routes/analystRoutes.ts` and
// `backend/mcp-server/src/tools/analystTools.ts` import from here. See
// CLAUDE.md "MCP Server 与 REST API 的同步规则".

import { z } from "zod";

// ─── Result handle (opaque reference to a DuckDB intermediate table) ───
//
// Handles live only within a conversation's session .duckdb file. They are
// never user-facing — the chat transcript carries them in tool_result payloads
// so the Agent can reference "last analysis result" on subsequent turns.

export const ResultHandleSchema = z
  .string()
  .regex(/^ducktbl_[a-z0-9]{12}$/, "handle must look like ducktbl_<12 hex chars>");

export type ResultHandle = z.infer<typeof ResultHandleSchema>;

// ─── Field stats for `describe_result` ───

export const FieldStatSchema = z.object({
  name: z.string(),
  type: z.string(), // DuckDB type string (e.g. "VARCHAR", "DOUBLE", "TIMESTAMP")
  nullCount: z.number().int().nonnegative(),
  distinctCount: z.number().int().nonnegative().nullable(),
  // numeric only
  min: z.union([z.number(), z.string(), z.null()]).optional(),
  max: z.union([z.number(), z.string(), z.null()]).optional(),
  mean: z.number().nullable().optional(),
  p50: z.number().nullable().optional(),
  p95: z.number().nullable().optional(),
  // categorical — top values + their counts
  topValues: z
    .array(z.object({ value: z.unknown(), count: z.number().int() }))
    .optional(),
});

export type FieldStat = z.infer<typeof FieldStatSchema>;

// ─── Result meta ───

export const ResultMetaSchema = z.object({
  handle: ResultHandleSchema,
  /** Physical DuckDB table name (derived from handle, safe identifier). */
  duckdbTable: z.string(),
  /** Source workspace table ids that contributed to this result. Used for
   * snapshot invalidation and for the write-to-idea "本次分析基于 XX 时刻" stamp. */
  sourceTableIds: z.array(z.string()),
  /** ISO timestamp of the oldest snapshot used. */
  snapshotAt: z.string(),
  rowCount: z.number().int().nonnegative(),
  /** Column schema (names + DuckDB types). Nullability, distinct-count, etc.
   * live in FieldStat and require an explicit describe_result call. */
  fields: z.array(
    z.object({
      name: z.string(),
      type: z.string(),
      /** Original workspace field name when this column traces back directly. */
      sourceField: z.string().optional(),
      /** Description from data dictionary, inherited through filters/joins. */
      description: z.string().optional(),
    }),
  ),
  /** Which MCP tool created this handle. */
  producedBy: z.string(),
  producedAt: z.string(),
  /** Agent-supplied short narrative, optional — useful for debugging. */
  description: z.string().optional(),
});

export type ResultMeta = z.infer<typeof ResultMetaSchema>;

// ─── Preview payload (returned alongside meta from every analyst tool) ───

export const ResultPreviewSchema = z.object({
  columns: z.array(z.object({ name: z.string(), type: z.string() })),
  rows: z.array(z.record(z.string(), z.unknown())),
  rowCount: z.number().int().nonnegative(),
  /** True when rows.length < rowCount (caller should render truncation footer). */
  truncated: z.boolean(),
  /** Default preview size (20). Reflected here so the UI can show "20 / N". */
  previewLimit: z.number().int().positive(),
});

export type ResultPreview = z.infer<typeof ResultPreviewSchema>;

// ─── Load workspace table ───

export const loadWorkspaceTableSchema = z.object({
  tableId: z.string().min(1),
  /** When true, force a fresh snapshot even if one was taken this session. */
  refresh: z.boolean().optional(),
  /** Optional explicit timestamp — load a prior snapshot instead of newest. */
  snapshotAt: z.string().optional(),
});

export type LoadWorkspaceTableInput = z.infer<typeof loadWorkspaceTableSchema>;

// ─── Filter / group / pivot / join / time_bucket / top_n ───

export const filterResultSchema = z.object({
  handle: ResultHandleSchema,
  /** DuckDB-compatible SQL expression for WHERE clause. Reject DROP/DELETE/etc.
   * in the handler via AST parsing. */
  where: z.string().min(1),
  description: z.string().optional(),
});
export type FilterResultInput = z.infer<typeof filterResultSchema>;

export const groupAggregateSchema = z.object({
  handle: ResultHandleSchema,
  groupBy: z.array(z.string().min(1)).min(1),
  metrics: z
    .array(
      z.object({
        field: z.string().min(1),
        op: z.enum(["count", "sum", "avg", "min", "max", "count_distinct", "median", "stddev"]),
        as: z.string().optional(),
      }),
    )
    .min(1),
  description: z.string().optional(),
});
export type GroupAggregateInput = z.infer<typeof groupAggregateSchema>;

export const pivotResultSchema = z.object({
  handle: ResultHandleSchema,
  rows: z.array(z.string().min(1)).min(1),
  columns: z.array(z.string().min(1)).min(1),
  values: z
    .array(
      z.object({
        field: z.string().min(1),
        op: z.enum(["sum", "count", "avg", "min", "max"]).default("sum"),
      }),
    )
    .min(1),
  description: z.string().optional(),
});
export type PivotResultInput = z.infer<typeof pivotResultSchema>;

export const joinResultsSchema = z.object({
  leftHandle: ResultHandleSchema,
  rightHandle: ResultHandleSchema,
  /** Equi-join keys: array of {left, right} pairs. */
  on: z
    .array(
      z.object({ left: z.string().min(1), right: z.string().min(1) }),
    )
    .min(1),
  type: z.enum(["inner", "left", "right", "full"]).default("inner"),
  description: z.string().optional(),
});
export type JoinResultsInput = z.infer<typeof joinResultsSchema>;

export const timeBucketSchema = z.object({
  handle: ResultHandleSchema,
  dateField: z.string().min(1),
  granularity: z.enum(["day", "week", "month", "quarter", "year"]),
  metrics: z
    .array(
      z.object({
        field: z.string().min(1),
        op: z.enum(["count", "sum", "avg", "min", "max"]),
        as: z.string().optional(),
      }),
    )
    .min(1),
  groupBy: z.array(z.string().min(1)).optional(), // extra grouping dims
  description: z.string().optional(),
});
export type TimeBucketInput = z.infer<typeof timeBucketSchema>;

export const topNSchema = z.object({
  handle: ResultHandleSchema,
  orderBy: z
    .array(
      z.object({
        field: z.string().min(1),
        direction: z.enum(["asc", "desc"]).default("desc"),
      }),
    )
    .min(1),
  n: z.number().int().positive().max(10000),
  description: z.string().optional(),
});
export type TopNInput = z.infer<typeof topNSchema>;

export const runSqlSchema = z.object({
  /** SQL that produces a result table (SELECT or CREATE TABLE AS). */
  sql: z.string().min(1).max(20000),
  /** Optional description for the resulting meta. */
  description: z.string().optional(),
});
export type RunSqlInput = z.infer<typeof runSqlSchema>;

export const previewResultSchema = z.object({
  handle: ResultHandleSchema,
  limit: z.number().int().positive().max(1000).default(20),
});
export type PreviewResultInput = z.infer<typeof previewResultSchema>;

export const describeResultSchema = z.object({
  handle: ResultHandleSchema,
  /** For categorical fields, how many top values to return. */
  topK: z.number().int().min(0).max(100).default(5),
});
export type DescribeResultInput = z.infer<typeof describeResultSchema>;

// ─── Snapshot list / stat ───

export const snapshotListSchema = z.object({
  workspaceId: z.string().optional(),
  conversationId: z.string().optional(),
});
export type SnapshotListInput = z.infer<typeof snapshotListSchema>;

export const snapshotEntrySchema = z.object({
  tableId: z.string(),
  snapshotAt: z.string(),
  path: z.string(),
  byteSize: z.number().int().nonnegative(),
  rowCount: z.number().int().nonnegative().nullable(),
});
export type SnapshotEntry = z.infer<typeof snapshotEntrySchema>;

// ─── Data dictionary ───

export const dataDictionaryEntrySchema = z.object({
  tableId: z.string(),
  tableName: z.string(),
  fields: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      type: z.string(),
      description: z.string().optional(),
      /** Options for SingleSelect/MultiSelect — gives the Agent the allowed values. */
      options: z.array(z.object({ name: z.string() })).optional(),
    }),
  ),
});
export type DataDictionaryEntry = z.infer<typeof dataDictionaryEntrySchema>;

// ─── Chart spec (vega-lite, P3) ───

export const ChartSpecSchema = z
  .object({
    $schema: z.string().optional(),
    title: z.union([z.string(), z.object({}).passthrough()]).optional(),
    mark: z.union([z.string(), z.object({ type: z.string() }).passthrough()]),
    encoding: z.record(z.string(), z.any()),
    data: z
      .object({
        values: z.array(z.record(z.string(), z.any())).optional(),
        name: z.string().optional(),
        url: z.string().optional(),
      })
      .optional(),
    width: z.union([z.number(), z.literal("container")]).optional(),
    height: z.union([z.number(), z.literal("container")]).optional(),
    transform: z.array(z.any()).optional(),
  })
  .passthrough();

export type ChartSpec = z.infer<typeof ChartSpecSchema>;

export const generateChartSchema = z.object({
  handle: ResultHandleSchema,
  chartType: z.enum(["bar", "line", "pie", "area", "scatter"]),
  x: z.string().min(1).optional(),
  y: z.string().min(1).optional(),
  series: z.string().min(1).optional(),
  title: z.string().optional(),
  aggregate: z.enum(["sum", "count", "avg", "min", "max"]).optional(),
});
export type GenerateChartInput = z.infer<typeof generateChartSchema>;

// ─── Write-to-idea / write-to-table ───

export const writeAnalysisToIdeaSchema = z.object({
  handle: ResultHandleSchema,
  additionalHandles: z.array(ResultHandleSchema).optional(),
  chartSpecs: z.array(ChartSpecSchema).optional(),
  narrative: z.string().min(1),
  /** If provided → append; otherwise → create new idea. */
  ideaId: z.string().optional(),
  title: z.string().min(1).optional(),
  workspaceId: z.string().min(1),
});
export type WriteAnalysisToIdeaInput = z.infer<typeof writeAnalysisToIdeaSchema>;

export const writeAnalysisToTableSchema = z.object({
  handle: ResultHandleSchema,
  tableName: z.string().min(1).max(200),
  workspaceId: z.string().min(1),
  fieldMappings: z
    .array(
      z.object({
        duckdbField: z.string().min(1),
        tableFieldName: z.string().min(1),
        tableFieldType: z.enum([
          "Text",
          "Number",
          "DateTime",
          "Checkbox",
          "SingleSelect",
        ]),
      }),
    )
    .optional(),
});
export type WriteAnalysisToTableInput = z.infer<typeof writeAnalysisToTableSchema>;
