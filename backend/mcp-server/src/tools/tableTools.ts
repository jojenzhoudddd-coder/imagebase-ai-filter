/**
 * Table-level MCP tools.
 * Mirror of backend/src/routes/tableRoutes.ts — see CLAUDE.md "MCP Server 与 REST API 的同步规则".
 */

import { apiRequest, toolResult, confirmationRequired } from "../dataStoreClient.js";

/**
 * Runtime context passed alongside each tool invocation. Populated by the
 * in-process agent loop so tools that need "who am I operating for" (e.g.
 * Tier 0 meta-tools writing to soul.md / profile.md) can read it without
 * the model having to pass it as an arg.
 *
 * MCP stdio callers don't set ctx — they either don't need it (data-plane
 * tools like create_table) or supply the identifier explicitly in args.
 */
export interface ToolContext {
  agentId?: string;
  /**
   * Phase 3: currently-active skill names for the live conversation.
   * Populated by the in-process agent loop; stdio MCP callers leave it
   * undefined (which all data-plane tools ignore).
   */
  activeSkills?: string[];
  /** Callback fired by skill-router tools to mutate activation state. */
  onActivateSkill?: (name: string) => void;
  onDeactivateSkill?: (name: string) => void;
  /**
   * Analyst P1: the conversation this tool call belongs to. Analyst tools
   * key their DuckDB session off this — same conversation, same .duckdb file.
   * `undefined` for stdio MCP callers; data-plane tools ignore it.
   */
  conversationId?: string;
  /**
   * Analyst P1: the workspace context for this tool call. Used by analyst
   * tools that need to resolve a tableId → workspaceId, and by the
   * snapshot writer for data-dictionary enrichment.
   */
  workspaceId?: string;
  /**
   * Analyst P1: the callId of the current tool invocation. Set by the agent
   * loop so long-running tools can report progress using `progress(...)`
   * below without having to thread the callId explicitly. Undefined for
   * stdio MCP callers.
   */
  callId?: string;
  /**
   * Analyst P1: report progress for the currently-executing tool. Emits a
   * `tool_progress` SSE event to the client. Safe to call repeatedly — the
   * agent loop rate-limits downstream if needed. `undefined` when running
   * under stdio MCP (no-op for tools guarded by `ctx?.progress?.(...)`).
   */
  progress?: (payload: {
    phase?: string;
    progress?: number;
    message: string;
    current?: number;
    total?: number;
  }) => void;
  /**
   * Analyst P1: abort signal plumbed through from the turn's AbortController.
   * Tools that do long DuckDB scans or HTTP requests should respect it.
   */
  abortSignal?: AbortSignal;
  /**
   * PR3 Agent Workflow: subagent spawn callback.
   * Set by the host chat agent loop. Lets MCP tools (specifically
   * `spawn_subagent`) request the loop to fork a subagent with a chosen
   * model + prompt. The loop performs the actual spawn (because it has the
   * privileged context: hostTools list, parentMessageId, abortSignal) and
   * yields the resulting `subagent_*` SSE events into the parent stream.
   * Returns a promise resolving to the subagent's finalText.
   *
   * `undefined` for stdio MCP callers — tools that depend on it should
   * gracefully degrade (return error message).
   */
  spawnSubagent?: (opts: {
    modelId: string;
    systemPrompt?: string;
    userPrompt: string;
    allowedTools?: string[];
    maxRounds?: number;
    workflowNodeId?: string | null;
  }) => Promise<{ runId: string; finalText: string; success: boolean }>;
  /**
   * PR4 Agent Workflow: execute a built-in workflow template. Like
   * spawnSubagent, this is set by the in-process host loop because it
   * needs the privileged context (parentMessageId, hostTools, abortSignal).
   * The loop emits workflow_* SSE events into the parent stream.
   *
   * Returns a brief summary so the host can chain off it. The detailed
   * subagent runs are visible in the FE WorkflowBlock.
   */
  executeWorkflow?: (opts: {
    /** "review" / "brainstorm" / "cowork" / "concurrent-data" / "custom"(后者需 params.customDoc) */
    templateId: string;
    userMessage: string;
    params?: Record<string, any>;
  }) => Promise<{ runId: string; success: boolean; summary: string }>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  danger?: boolean;
  handler: (args: Record<string, any>, ctx?: ToolContext) => Promise<string>;
}

export const tableTools: ToolDefinition[] = [
  {
    name: "list_tables",
    description: "列出指定工作空间下所有数据表。返回表 id、名称、字段数、记录数。",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "工作空间 id，默认 doc_default" },
      },
    },
    handler: async (args) => {
      const wsId = args.workspaceId || "doc_default";
      const tables = await apiRequest<unknown>(`/api/workspaces/${encodeURIComponent(wsId)}/tables`);
      return toolResult(tables);
    },
  },

  {
    name: "get_table",
    description: "获取指定表的详细信息：字段列表（含类型与 config）、视图列表、记录数。常在调用其他工具前先用此工具了解现状。",
    inputSchema: {
      type: "object",
      properties: {
        tableId: { type: "string", description: "数据表 id，如 tbl_xxx" },
      },
      required: ["tableId"],
    },
    handler: async (args) => {
      const tableId = String(args.tableId);
      const [fields, views, records] = await Promise.all([
        apiRequest<any[]>(`/api/tables/${tableId}/fields`),
        apiRequest<any[]>(`/api/tables/${tableId}/views`),
        apiRequest<any[]>(`/api/tables/${tableId}/records`),
      ]);
      return toolResult({
        tableId,
        fieldCount: fields.length,
        recordCount: records.length,
        fields: fields.map((f) => ({
          id: f.id,
          name: f.name,
          type: f.type,
          isPrimary: f.isPrimary,
          options: f.config?.options?.map((o: any) => ({ id: o.id, name: o.name })) ?? undefined,
        })),
        views: views.map((v) => ({ id: v.id, name: v.name, type: v.type })),
      });
    },
  },

  {
    name: "create_table",
    description:
      "在指定工作空间中创建一张空白数据表（含 1 个默认 Text 主字段 + 5 条空记录 + 1 个默认 Grid 视图）。" +
      "返回新表的 id / name 以及默认主字段 primaryField（含 id / name / type）。" +
      "⚠️ 用户需要自定义表结构时，必须用 update_field 把 primaryField 改成期望的第一列（名称/类型/config），" +
      "然后再继续 create_field 添加其余列。绝对不要再额外 create_field 一个同义的第一列，否则会出现重复。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "表名称，如 '客户管理'" },
        workspaceId: { type: "string", description: "所属工作空间 id，默认 doc_default" },
        language: { type: "string", enum: ["en", "zh"], description: "默认字段名语言" },
      },
      required: ["name"],
    },
    handler: async (args) => {
      const body = {
        name: String(args.name),
        workspaceId: args.workspaceId || "doc_default",
        language: args.language || "zh",
      };
      const tbl = await apiRequest<any>("/api/tables", { method: "POST", body });
      // Fetch fields so the agent gets the auto-created primary field's id and
      // can immediately rename/retype it via update_field instead of adding a
      // redundant first column.
      let primaryField: { id: string; name: string; type: string } | null = null;
      try {
        const fields = await apiRequest<any[]>(`/api/tables/${tbl.id}/fields`, { method: "GET" });
        const primary = Array.isArray(fields) ? fields.find((f) => f.isPrimary) ?? fields[0] : null;
        if (primary) {
          primaryField = { id: primary.id, name: primary.name, type: primary.type };
        }
      } catch {
        // Non-fatal: agent can still call list_fields explicitly
      }
      return toolResult({
        id: tbl.id,
        name: tbl.name,
        order: tbl.order,
        primaryField,
        note: primaryField
          ? `⚠️ 已自动生成默认主字段 "${primaryField.name}" (id=${primaryField.id}, type=${primaryField.type})。若不符合用户需求，请用 update_field 修改它，不要 create_field 新增重复的第一列。`
          : undefined,
      });
    },
  },

  {
    name: "rename_table",
    description: "修改数据表名称。",
    inputSchema: {
      type: "object",
      properties: {
        tableId: { type: "string" },
        name: { type: "string", description: "新名称" },
      },
      required: ["tableId", "name"],
    },
    handler: async (args) => {
      const tableId = String(args.tableId);
      const body = { name: String(args.name) };
      const tbl = await apiRequest<any>(`/api/tables/${tableId}`, { method: "PUT", body });
      return toolResult({ id: tbl.id, name: tbl.name });
    },
  },

  {
    name: "delete_table",
    description: "⚠️ 删除整张数据表及其所有字段、记录、视图。不可撤销。必须先征得用户同意。",
    danger: true,
    inputSchema: {
      type: "object",
      properties: {
        tableId: { type: "string" },
        confirmed: { type: "boolean", description: "仅当用户已确认时传 true" },
      },
      required: ["tableId"],
    },
    handler: async (args) => {
      const tableId = String(args.tableId);
      if (!args.confirmed) {
        return confirmationRequired(
          "delete_table",
          { tableId },
          `即将删除数据表 ${tableId}，此操作不可撤销。`
        );
      }
      await apiRequest(`/api/tables/${tableId}`, { method: "DELETE" });
      return toolResult({ ok: true, deletedTableId: tableId });
    },
  },

  {
    name: "reset_table",
    description: "⚠️ 替换表结构：清空现有字段与记录，用 AI 生成的新字段定义重建。用于用户明确要求重新设计表结构时。",
    danger: true,
    inputSchema: {
      type: "object",
      properties: {
        tableId: { type: "string" },
        fields: {
          type: "array",
          description: "新字段列表，每项含 name/type/isPrimary/config",
          items: { type: "object" },
        },
        language: { type: "string", enum: ["en", "zh"] },
        confirmed: { type: "boolean" },
      },
      required: ["tableId", "fields"],
    },
    handler: async (args) => {
      const tableId = String(args.tableId);
      if (!args.confirmed) {
        return confirmationRequired(
          "reset_table",
          { tableId, fields: args.fields },
          `即将重置数据表 ${tableId} 的结构（${(args.fields as any[]).length} 个新字段），现有字段与记录将被删除。`
        );
      }
      const body = {
        fields: args.fields,
        language: args.language || "zh",
      };
      const result = await apiRequest(`/api/tables/${tableId}/reset`, { method: "POST", body });
      return toolResult(result);
    },
  },
];
