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
    handler: async (args, ctx) => {
      const wsId = args.workspaceId || ctx?.workspaceId || "doc_default";
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
      "读取一篇灵感文档的完整内容 + 章节结构 + block 列表(每段一个 blockId,供 update_idea_block / delete_idea_block / move_idea_block 定位)。" +
      "content 是原始 Markdown(可能嵌入 HTML)。" +
      "blocks 是 PR8 引入的精准编辑锚点 — 每段都有唯一 id,reorder/delete/transform 不会跑偏。",
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
      // PR8: also fetch blocks so the Agent can use blockId-based mutations
      // without an extra round trip. Best-effort — if /blocks fails we
      // just return without blocks.
      let blocks: { id: string; order: number; type: string; props: any }[] = [];
      try {
        const blocksRes = await apiRequest<{ blocks: { id: string; order: number; type: string; content: string; props: any }[] }>(
          `/api/ideas/${id}/blocks`,
        );
        // Strip raw `content` from the per-block payload — the Agent already
        // has detail.content; emitting it twice doubles tokens. props is
        // small + useful (e.g. heading.level / list.ordered).
        blocks = blocksRes.blocks.map((b) => ({
          id: b.id,
          order: b.order,
          type: b.type,
          props: b.props,
        }));
      } catch {
        /* ignored — blocks empty is acceptable */
      }
      return toolResult({
        id: detail.id,
        name: detail.name,
        workspaceId: detail.workspaceId,
        parentId: detail.parentId,
        version: detail.version,
        content: detail.content,
        sections,
        blocks,
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
    handler: async (args, ctx) => {
      const body = {
        name: String(args.name),
        workspaceId: args.workspaceId || ctx?.workspaceId || "doc_default",
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
      "写 mention 前先用 find_mentionable 拿到 markdown 字段，把它原样嵌入即可。\n" +
      "🛑 **互斥约束**：本轮如果已经调用过 begin_idea_stream_write + end_idea_stream_write(finalize:true) " +
      "把同样的内容流式写过一次,**不要再 append**——内容已经在 DB 里,再 append 会让同一段文字出现两遍。",
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

  // PR5: Agent 给 idea 上传图片 / SVG / PDF / 视频附件,返回 url。
  // 上传后 Agent 应该把 ![alt](url) 拼进 Markdown,通过 append_to_idea /
  // insert_into_idea / 流式写入。本工具不动 idea content,只产生附件 url。
  {
    name: "upload_to_idea",
    description:
      "把一张图(或 SVG / PDF / 视频)作为附件上传到指定 idea,返回可在 Markdown 里直接引用的 url。" +
      "调用时机:用户让你画一张图 / 把外部图片插入 idea / Agent 自己生成图片需要嵌入文档。" +
      "上传后**你需要**再调 append_to_idea 或 insert_into_idea 把 ![alt](url) 拼进 Markdown 主体 —— " +
      "本工具不会自动改 idea content。" +
      "支持 mime:image/png · jpeg · webp · gif · avif · svg+xml · application/pdf · video/mp4 · webm。" +
      "size 上限:image 10MB / SVG 1MB / PDF 20MB / video 100MB。" +
      "去重:同 workspace 同 hash 不重复存储,多个 idea 引用同一文件天然共享。",
    inputSchema: {
      type: "object",
      properties: {
        ideaId: { type: "string", description: "目标 idea id" },
        base64: {
          type: "string",
          description:
            "文件内容的 base64 编码(不带 data:mime;base64, 前缀)。可以是任意支持 mime 的二进制内容。",
        },
        mime: {
          type: "string",
          description:
            "MIME 类型,如 image/png / image/svg+xml / application/pdf / video/mp4。",
        },
        originalName: {
          type: "string",
          description: "可选;原始文件名,显示用,会被 sanitize。",
        },
        alt: {
          type: "string",
          description:
            "可选;返回值会包含一个建议的 markdown 引用(如 ![alt](url)),你可直接拷贝拼进 idea。",
        },
      },
      required: ["ideaId", "base64", "mime"],
    },
    handler: async (args): Promise<string> => {
      const ideaId = String(args.ideaId ?? "").trim();
      if (!ideaId) return JSON.stringify({ error: "ideaId required" });
      const b64 = String(args.base64 ?? "");
      const mime = String(args.mime ?? "").trim();
      if (!b64) return JSON.stringify({ error: "base64 required" });
      if (!mime) return JSON.stringify({ error: "mime required" });
      let buf: Buffer;
      try {
        buf = Buffer.from(b64, "base64");
      } catch {
        return JSON.stringify({ error: "invalid base64" });
      }
      if (buf.byteLength === 0) return JSON.stringify({ error: "empty content" });
      // Use multipart upload via the same HTTP endpoint the FE uses, so the
      // server-side route handles all validation + access checks uniformly.
      const formData = new FormData();
      formData.append("file", new Blob([buf as any], { type: mime }), args.originalName ? String(args.originalName) : "upload.bin");
      try {
        const res = await apiRequest<any>(`/api/ideas/${ideaId}/attachments`, {
          method: "POST",
          body: formData,
          // apiRequest sets Content-Type for JSON by default; we override.
          rawForm: true,
        } as any);
        const alt = typeof args.alt === "string" && args.alt.trim() ? args.alt.trim() : (res.originalName || "image");
        const isImage = (res.mime || "").startsWith("image/");
        const isVideo = (res.mime || "").startsWith("video/");
        const markdown = isImage
          ? `![${alt}](${res.url})`
          : isVideo
            ? `<video controls src="${res.url}"></video>`
            : `[${alt}](${res.url})`;
        return JSON.stringify({
          id: res.id,
          url: res.url,
          mime: res.mime,
          size: res.size,
          markdown,
          note:
            "已上传。请用 append_to_idea / insert_into_idea / replace_section 把上面的 markdown 字段拼进 idea 主体。" +
            "本工具不会自动改 idea content。",
        });
      } catch (err) {
        return JSON.stringify({
          error: `upload_to_idea failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },
  },

  // PR8: 块级精准编辑工具 — Agent 可以"只改这一段"而不必重写整个 idea。
  // 比 append_to_idea / insert_into_idea 更细粒度,适合"把第三段那个 typo
  // 改了"/"删掉那个过时的 callout"/"把 H2 改成 H3" 这类操作。
  // blockId 来自 list_ideas / get_idea 的 sections (PR8.5 在 get_idea 返回
  // 也加 blocks 列表,V1 由用户给 / Agent 通过 get_idea 看到 markdown 后
  // 调 web 端 GET /blocks 端点拿)。
  {
    name: "update_idea_block",
    description:
      "替换某 idea 中某 block 的内容,或把 block type 转换成另一种。" +
      "调用时机:精确改一段而不动其它段(比 replace_idea_content 安全得多)。" +
      "传 content 直接替换该 block 的 markdown 字节;传 transformTo 自动转类型。" +
      "transformTo 可选:paragraph / heading-1 ~ heading-6 / quote / list-bullet / divider。" +
      "至少要传 content / transformTo 之一。" +
      "返回 idea 的新 version,后续写入用此版本号。",
    inputSchema: {
      type: "object",
      properties: {
        ideaId: { type: "string", description: "目标 idea id" },
        blockId: { type: "string", description: "要修改的 block id" },
        content: {
          type: "string",
          description:
            "新的 block markdown(整段替换)。需要包含必要的标记(heading 的 # / quote 的 > 等)。",
        },
        transformTo: {
          type: "string",
          enum: ["paragraph", "heading-1", "heading-2", "heading-3", "heading-4", "heading-5", "heading-6", "quote", "list-bullet", "divider"],
          description: "把该 block 转成此类型(自动处理标记)",
        },
      },
      required: ["ideaId", "blockId"],
    },
    handler: async (args): Promise<string> => {
      const ideaId = String(args.ideaId ?? "").trim();
      const blockId = String(args.blockId ?? "").trim();
      if (!ideaId || !blockId) return JSON.stringify({ error: "ideaId + blockId required" });
      const body: Record<string, unknown> = {};
      if (typeof args.content === "string") body.content = args.content;
      if (typeof args.transformTo === "string") body.transformTo = args.transformTo;
      if (Object.keys(body).length === 0) {
        return JSON.stringify({ error: "either content or transformTo required" });
      }
      try {
        const r = await apiRequest<{ id: string; version: number; content: string }>(
          `/api/ideas/${ideaId}/blocks/${blockId}`,
          { method: "PATCH", body },
        );
        return toolResult({ ideaId: r.id, version: r.version, contentLength: r.content.length });
      } catch (err) {
        return JSON.stringify({ error: `update_idea_block failed: ${err instanceof Error ? err.message : String(err)}` });
      }
    },
  },

  {
    name: "delete_idea_block",
    danger: true,
    description:
      "⚠️ 删除某 idea 中某个 block(走危险确认流)。" +
      "其它 block 全部保留,只精准移除这一段。比 delete_idea 安全粒度更细。" +
      "返回 idea 的新 version。",
    inputSchema: {
      type: "object",
      properties: {
        ideaId: { type: "string" },
        blockId: { type: "string" },
      },
      required: ["ideaId", "blockId"],
    },
    handler: async (args): Promise<string> => {
      const ideaId = String(args.ideaId ?? "").trim();
      const blockId = String(args.blockId ?? "").trim();
      if (!ideaId || !blockId) return JSON.stringify({ error: "ideaId + blockId required" });
      try {
        const r = await apiRequest<{ id: string; version: number }>(
          `/api/ideas/${ideaId}/blocks/${blockId}`,
          { method: "DELETE" },
        );
        return toolResult({ ideaId: r.id, version: r.version });
      } catch (err) {
        return JSON.stringify({ error: `delete_idea_block failed: ${err instanceof Error ? err.message : String(err)}` });
      }
    },
  },

  {
    name: "move_idea_block",
    description:
      "把某 idea 中的某 block 移动到新位置(0-based index)。" +
      '其它 block 顺序保持。常用于"把这段挪到前面"/"把结论调到最后"。' +
      "toIndex 超出范围会自动 clamp 到 [0, len-1]。",
    inputSchema: {
      type: "object",
      properties: {
        ideaId: { type: "string" },
        blockId: { type: "string" },
        toIndex: {
          type: "number",
          description: "目标位置的 0-based index。如要移到 H2-Section 之前,先 list 拿到该 H2 的 index,toIndex 就用那个数字。",
        },
      },
      required: ["ideaId", "blockId", "toIndex"],
    },
    handler: async (args): Promise<string> => {
      const ideaId = String(args.ideaId ?? "").trim();
      const blockId = String(args.blockId ?? "").trim();
      const toIndex = Number(args.toIndex);
      if (!ideaId || !blockId || !Number.isFinite(toIndex)) {
        return JSON.stringify({ error: "ideaId + blockId + toIndex required" });
      }
      try {
        const r = await apiRequest<{ id: string; version: number }>(
          `/api/ideas/${ideaId}/blocks/${blockId}/move`,
          { method: "POST", body: { toIndex } },
        );
        return toolResult({ ideaId: r.id, version: r.version });
      } catch (err) {
        return JSON.stringify({ error: `move_idea_block failed: ${err instanceof Error ? err.message : String(err)}` });
      }
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
      "省略会被 2 分钟空闲超时自动丢弃。\n" +
      "🛑 **关键约束**：finalize:true 已经把流式期间输出的正文持久化进 DB,内容现在是 idea 文档的一部分。" +
      "本轮内**绝对不要**再为同一份内容调用 append_to_idea / insert_into_idea / replace_idea_content / write_analysis_to_idea —— " +
      "那会让相同内容在文档里出现两次。如果你刚刚 stream 写了一段分析结论,任务已经完成,直接回复用户即可。",
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
