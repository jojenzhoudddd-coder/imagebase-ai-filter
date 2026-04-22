/**
 * Idea MCP tools — mirror of backend/src/routes/ideaRoutes.ts.
 * See CLAUDE.md "MCP Server 与 REST API 的同步规则" for the sync contract.
 *
 * Tier split:
 *   - Tier 1 (always-on nav): `list_ideas`, `get_idea`
 *     Cheap reads so the agent can always see what idea docs exist without
 *     activating a skill. `get_idea` is the canonical way to discover section
 *     slugs for anchor writes.
 *   - Tier 2 (idea-skill only): create / rename / delete (⚠️) / anchor writes /
 *     full-content replace (⚠️). Loaded when the agent activates `idea-skill`
 *     (auto-triggered by keywords like 灵感/idea/章节/append/insert into doc).
 */

import { apiRequest, toolResult, confirmationRequired } from "../dataStoreClient.js";
import type { ToolDefinition } from "./tableTools.js";

/** Shared schema fragment for the anchor parameter of write tools. */
const ANCHOR_SCHEMA = {
  type: "object",
  description:
    "写入位置。position=start 追加到文档开头；position=end 追加到文档末尾；" +
    "section=<slug> 指向某个标题（slug 从 get_idea 的 sections 里取），配合 mode：" +
    "append=在该段末尾追加（默认）；after=紧跟在标题行之后、段内首个子内容之前；" +
    "replace=用 payload 替换该段正文（保留标题行本身）。",
  oneOf: [
    {
      type: "object",
      properties: { position: { type: "string", enum: ["start", "end"] } },
      required: ["position"],
    },
    {
      type: "object",
      properties: {
        section: { type: "string", description: "标题 slug（由 get_idea 返回）" },
        mode: { type: "string", enum: ["append", "after", "replace"] },
      },
      required: ["section"],
    },
  ],
} as const;

// ── Tier 1 ─────────────────────────────────────────────────────────────────

export const ideaNavTools: ToolDefinition[] = [
  {
    name: "list_ideas",
    description:
      "列出指定工作空间下所有灵感（Idea）文档。返回每篇的 id / name / parentId / updatedAt。" +
      "正文内容不返回（可能很长）；需要内容时再调 get_idea。",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "工作空间 id，默认 doc_default" },
      },
    },
    handler: async (args) => {
      const wsId = args.workspaceId || "doc_default";
      const result = await apiRequest<{ ideas: any[] }>(
        `/api/ideas?workspaceId=${encodeURIComponent(wsId)}`
      );
      return toolResult({
        ideas: result.ideas.map((i) => ({
          id: i.id,
          name: i.name,
          parentId: i.parentId,
          order: i.order,
          version: i.version,
          updatedAt: i.updatedAt,
        })),
      });
    },
  },
  {
    name: "get_idea",
    description:
      "读取一篇灵感文档的完整内容 + 章节结构（含每个标题的 slug，供 insert_into_idea 等写入工具作为定位锚点）。" +
      "content 是原始 Markdown（可能嵌入 HTML）。",
    inputSchema: {
      type: "object",
      properties: {
        ideaId: { type: "string", description: "灵感 id，如 cuid" },
      },
      required: ["ideaId"],
    },
    handler: async (args) => {
      const id = String(args.ideaId);
      // The public GET /:ideaId doesn't return sections in its default shape,
      // but the list endpoint can. We fetch the full idea + explicitly ask
      // the list endpoint for sections by id-filtering. Simpler: hit GET /:id
      // for content, then grab sections via the list endpoint. But the list
      // endpoint currently doesn't take an id filter, so we read it from
      // the idea detail response, which in this codebase does NOT include
      // sections. Simplest path: derive sections client-side by hitting the
      // same extractor logic — but that would duplicate the slug algorithm.
      // Pragmatic choice: extend list endpoint to accept includeSections and
      // call it here. The endpoint already supports includeSections=1.
      const [detail, listed] = await Promise.all([
        apiRequest<any>(`/api/ideas/${id}`),
        apiRequest<{ ideas: any[] }>(
          `/api/ideas?workspaceId=${encodeURIComponent("doc_default")}&includeSections=1`
        ).catch(() => ({ ideas: [] as any[] })),
      ]);
      // Fall back to the workspace declared by the detail so cross-workspace
      // lookups still find sections.
      let sections: any[] = [];
      const hitFromDefault = listed.ideas.find((i) => i.id === id);
      if (hitFromDefault && Array.isArray(hitFromDefault.sections)) {
        sections = hitFromDefault.sections;
      } else if (detail.workspaceId && detail.workspaceId !== "doc_default") {
        try {
          const scoped = await apiRequest<{ ideas: any[] }>(
            `/api/ideas?workspaceId=${encodeURIComponent(detail.workspaceId)}&includeSections=1`
          );
          const hit = scoped.ideas.find((i) => i.id === id);
          if (hit && Array.isArray(hit.sections)) sections = hit.sections;
        } catch {
          /* ignored — sections empty is acceptable */
        }
      }
      return toolResult({
        id: detail.id,
        name: detail.name,
        workspaceId: detail.workspaceId,
        parentId: detail.parentId,
        version: detail.version,
        content: detail.content,
        sections,
        updatedAt: detail.updatedAt,
      });
    },
  },
];

// ── Tier 2 (idea-skill) ────────────────────────────────────────────────────

export const ideaWriteTools: ToolDefinition[] = [
  {
    name: "create_idea",
    description:
      "新建一篇空白灵感文档。返回 {id, name, version}。" +
      "新建的文档 version 恒为 0 —— 如果紧接着要调用 begin_idea_stream_write，" +
      "直接把返回的 version 当成 baseVersion 传进去，不要猜数字、也不必再调 get_idea。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "文档名称，如 '2026 Q2 产品线路图'" },
        workspaceId: { type: "string", description: "工作空间 id，默认 doc_default" },
        parentId: { type: "string", description: "父文件夹 id（可选）" },
      },
      required: ["name"],
    },
    handler: async (args) => {
      const body = {
        name: String(args.name),
        workspaceId: args.workspaceId || "doc_default",
        parentId: args.parentId || null,
      };
      const idea = await apiRequest<any>("/api/ideas", { method: "POST", body });
      // version is 0 for a fresh idea; fall back to 0 if server-side is older
      return toolResult({
        id: idea.id,
        name: idea.name,
        version: typeof idea.version === "number" ? idea.version : 0,
      });
    },
  },
  {
    name: "rename_idea",
    description: "修改灵感文档名称。",
    inputSchema: {
      type: "object",
      properties: {
        ideaId: { type: "string" },
        name: { type: "string", description: "新名称" },
      },
      required: ["ideaId", "name"],
    },
    handler: async (args) => {
      const id = String(args.ideaId);
      const idea = await apiRequest<any>(`/api/ideas/${id}`, {
        method: "PATCH",
        body: { name: String(args.name) },
      });
      return toolResult({ id: idea.id, name: idea.name });
    },
  },
  {
    name: "delete_idea",
    description:
      "⚠️ 删除整篇灵感文档及其全部内容。不可撤销。必须先征得用户同意，且最好先用 list_incoming_mentions 列出有哪些文档引用了它。",
    danger: true,
    inputSchema: {
      type: "object",
      properties: {
        ideaId: { type: "string" },
        confirmed: { type: "boolean", description: "仅当用户已确认时传 true" },
      },
      required: ["ideaId"],
    },
    handler: async (args) => {
      const id = String(args.ideaId);
      if (!args.confirmed) {
        return confirmationRequired(
          "delete_idea",
          { ideaId: id },
          `即将删除灵感文档 ${id}，此操作不可撤销。`
        );
      }
      await apiRequest(`/api/ideas/${id}`, { method: "DELETE" });
      return toolResult({ ok: true, deletedIdeaId: id });
    },
  },
  {
    name: "append_to_idea",
    description:
      "在灵感文档的末尾追加 Markdown 内容。适合没有明确章节锚点、直接续写新段落的场景。" +
      "payload 允许嵌入 HTML（<div> / <figure> / <pre> 等都可以），以及 @ mention 链接——" +
      "mention 链接格式：[@标签](mention://<type>/<id>[?query])，type ∈ {view,taste,idea,idea-section}。" +
      "写 mention 前先用 find_mentionable 拿到 markdown 字段，把它原样嵌入即可。",
    inputSchema: {
      type: "object",
      properties: {
        ideaId: { type: "string" },
        payload: { type: "string", description: "要追加的 Markdown/HTML 内容" },
      },
      required: ["ideaId", "payload"],
    },
    handler: async (args) => {
      const id = String(args.ideaId);
      const body = { anchor: { position: "end" }, payload: String(args.payload) };
      const result = await apiRequest<any>(`/api/ideas/${id}/write`, { method: "POST", body });
      return toolResult(result);
    },
  },
  {
    name: "insert_into_idea",
    description:
      "按锚点向灵感文档插入内容。anchor 可以是 {position:'start'|'end'} 或 {section:<slug>, mode:'append'|'after'|'replace'}。" +
      "slug 来自 get_idea 返回的 sections 数组。若 slug 不存在则返回错误，调用方需回退到 append_to_idea。",
    inputSchema: {
      type: "object",
      properties: {
        ideaId: { type: "string" },
        anchor: ANCHOR_SCHEMA,
        payload: { type: "string" },
      },
      required: ["ideaId", "anchor", "payload"],
    },
    handler: async (args) => {
      const id = String(args.ideaId);
      const body = { anchor: args.anchor, payload: String(args.payload) };
      const result = await apiRequest<any>(`/api/ideas/${id}/write`, { method: "POST", body });
      return toolResult(result);
    },
  },
  {
    name: "replace_idea_content",
    description:
      "⚠️ 用新的 Markdown 完整替换整篇灵感文档的正文。会触发 version 自增和 mention 重建，" +
      "旧内容不可恢复。只在用户明确要求重写整篇时使用，必须先征得同意。",
    danger: true,
    inputSchema: {
      type: "object",
      properties: {
        ideaId: { type: "string" },
        content: { type: "string", description: "新的完整正文（Markdown 原文）" },
        confirmed: { type: "boolean", description: "仅当用户已确认时传 true" },
      },
      required: ["ideaId", "content"],
    },
    handler: async (args) => {
      const id = String(args.ideaId);
      if (!args.confirmed) {
        return confirmationRequired(
          "replace_idea_content",
          { ideaId: id, contentLength: String(args.content).length },
          `即将用 ${String(args.content).length} 字符的新内容覆盖灵感文档 ${id} 的现有正文。`
        );
      }
      // Fetch current version so we can pass it as baseVersion.
      const current = await apiRequest<any>(`/api/ideas/${id}`);
      const body = { content: String(args.content), baseVersion: current.version };
      const result = await apiRequest<any>(`/api/ideas/${id}`, { method: "PUT", body });
      return toolResult(result);
    },
  },
];

// ── Tier 2 (idea-skill): streaming writes (V2) ────────────────────────────
//
// The streaming pair lets the Agent write long-form content (paragraphs,
// bullet lists, whole section drafts) *as it generates them*, instead of
// producing the whole blob first and then calling `append_to_idea` or
// `insert_into_idea`. Much cheaper — the model's natural text output becomes
// the content.
//
// Protocol contract (must be followed by the Agent):
//   1. Call `begin_idea_stream_write({ideaId, baseVersion, anchor})` FIRST,
//      inside a turn. The tool returns {sessionId, startOffset}. The Agent
//      should NOT include any content in the begin call — it's purely a
//      bracket open.
//   2. Between begin and end, everything the Agent writes as normal text is
//      intercepted by chatAgentService and forwarded to the session's buffer.
//      The text is simultaneously broadcast to the editor on a per-idea SSE
//      channel so the user sees it live. It is NOT shown in the chat bubble.
//   3. Call `end_idea_stream_write({sessionId, finalize})` to close. With
//      `finalize:true`, the buffered text is committed via the same anchor
//      pipeline as `insert_into_idea` (mention diff + version bump).
//      `finalize:false` discards everything — safe escape hatch if the Agent
//      realizes mid-stream that it should abort.
//
// Safety nets outside the Agent's control:
//   - 2-minute idle timeout auto-discards if `end` is never called.
//   - chatAgentService sweeps all sessions tied to this conversation on
//     turn-abort / error / completion without an explicit `end`.
//   - A second `begin` on the same ideaId kicks the first (discard).

export const ideaStreamTools: ToolDefinition[] = [
  {
    name: "begin_idea_stream_write",
    description:
      "开启一次对灵感文档的流式写入。调用成功后，在同一轮 Agent 响应中输出的正文会被拦截并" +
      "直接写入文档的指定锚点（用户可实时看到）；写完后必须调用 end_idea_stream_write 提交或丢弃。" +
      "适合一次性生成大段内容（≥ 3 行 Markdown），比 append_to_idea 的一次性写更省 token。\n" +
      "Must-follow：开启后本轮内用自然文本输出要写入的内容，不要再调用其它写入工具（会导致二者冲突）。" +
      "若是小改动（< 3 行），直接用 append_to_idea / insert_into_idea 即可，不必流式。",
    inputSchema: {
      type: "object",
      properties: {
        ideaId: { type: "string" },
        baseVersion: {
          type: "number",
          description:
            "当前 idea.version。若刚刚通过 create_idea 创建，直接用 create_idea 返回的 version（= 0）；" +
            "否则从 get_idea 取。与实际版本不一致会报错。",
        },
        anchor: ANCHOR_SCHEMA,
      },
      required: ["ideaId", "baseVersion", "anchor"],
    },
    handler: async (args) => {
      const id = String(args.ideaId);
      const body = {
        baseVersion: Number(args.baseVersion),
        anchor: args.anchor,
        // conversationId + clientId are injected by chatAgentService after the
        // tool returns (it wraps the call to add them server-side); the MCP
        // tool just carries the user-level payload.
        clientId: "agent-mcp",
      };
      const result = await apiRequest<any>(`/api/ideas/${id}/stream/begin`, {
        method: "POST",
        body,
      });
      return toolResult({
        sessionId: result.sessionId,
        startOffset: result.startOffset,
        baseVersion: result.baseVersion,
        // Include a machine-readable hint so chatAgentService can detect this
        // result and enter streaming mode without parsing the tool name.
        _stream: { mode: "begin", sessionId: result.sessionId, ideaId: id },
      });
    },
  },
  {
    name: "end_idea_stream_write",
    description:
      "关闭 begin_idea_stream_write 打开的流式写入会话。finalize:true 提交（buffer 写入 DB + version 自增 + mention 重建）；" +
      "finalize:false 丢弃（文档回滚到开启前的状态，不产生 version 变化）。即使你觉得写完了也必须显式调用一次——" +
      "省略会被 2 分钟空闲超时自动丢弃。",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "begin_idea_stream_write 返回的 sessionId" },
        finalize: {
          type: "boolean",
          description: "true=提交流式写入的全部内容；false=丢弃整段写入（文档保持原样）。",
        },
      },
      required: ["sessionId", "finalize"],
    },
    handler: async (args) => {
      const sessionId = String(args.sessionId);
      const commit = Boolean(args.finalize);
      const result = await apiRequest<any>(`/api/ideas/stream/${sessionId}/end`, {
        method: "POST",
        body: { commit },
      });
      return toolResult({
        ...result,
        _stream: { mode: "end", sessionId },
      });
    },
  },
];

/** Union used by index.ts for `allTools` enumeration. */
export const ideaTools: ToolDefinition[] = [
  ...ideaNavTools,
  ...ideaWriteTools,
  ...ideaStreamTools,
];
