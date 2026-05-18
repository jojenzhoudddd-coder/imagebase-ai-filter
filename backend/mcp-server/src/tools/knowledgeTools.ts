/**
 * Knowledge tools — Agent can learn, search, list, and delete knowledge.
 * learn_from_url / learn_from_text are Tier 0 (always available).
 * search_knowledge / list_knowledge are Tier 1 (always-on retrieval).
 */

import type { ToolDefinition } from "./tableTools.js";
import { apiRequest } from "../dataStoreClient.js";

export const knowledgeTools: ToolDefinition[] = [
  {
    name: "learn_from_url",
    description:
      "Store web page content as ONE complete document in the current workspace knowledge base. This is the ONLY correct tool for 'learning from URL' — never use create_memory. The content field has NO length limit — include the full page content, do NOT truncate.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL that was fetched" },
        title: { type: "string", description: "A concise title for this knowledge document" },
        content: { type: "string", description: "The COMPLETE, UNTRUNCATED content extracted from the page as a single Markdown document. No length limit — include everything." },
        tags: { type: "array", items: { type: "string" }, description: "Topic tags for categorization" },
      },
      required: ["url", "title", "content"],
    },
    handler: async (args: Record<string, unknown>, ctx?: any) => {
      try {
        const data = await apiRequest("/api/knowledge", {
          method: "POST",
          body: {
            agentId: ctx?.agentId ?? "agent_default",
            title: args.title,
            content: args.content,
            sourceUrl: args.url,
            sourceType: "web",
            tags: args.tags ?? [],
            workspaceId: ctx?.workspaceId ?? null,
          },
        });
        return JSON.stringify({ ok: true, ...data as object });
      } catch (err: any) {
        return JSON.stringify({ ok: false, error: err.message ?? "Failed to learn from URL" });
      }
    },
  },
  {
    name: "learn_from_text",
    description:
      "Store knowledge as ONE complete document in the current workspace knowledge base. This is the ONLY correct tool for 'learning knowledge' — never use create_memory. The content field has NO length limit — write the full document, do NOT truncate or split.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "A concise title for the document" },
        content: { type: "string", description: "The COMPLETE, UNTRUNCATED knowledge content as a single Markdown document. No length limit. Include everything." },
        tags: { type: "array", items: { type: "string" }, description: "Topic tags" },
      },
      required: ["title", "content"],
    },
    handler: async (args: Record<string, unknown>, ctx?: any) => {
      try {
        const data = await apiRequest("/api/knowledge", {
          method: "POST",
          body: {
            agentId: ctx?.agentId ?? "agent_default",
            title: args.title,
            content: args.content,
            sourceType: "chat",
            tags: args.tags ?? [],
            workspaceId: ctx?.workspaceId ?? null,
          },
        });
        return JSON.stringify({ ok: true, ...data as object });
      } catch (err: any) {
        return JSON.stringify({ ok: false, error: err.message ?? "Failed to learn from text" });
      }
    },
  },
  {
    name: "search_knowledge",
    description:
      "Search the current workspace's knowledge base using semantic similarity. Returns the most relevant entries for the given query. Use this when you need to recall previously learned information.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query" },
        limit: { type: "number", description: "Max results (default 5)" },
      },
      required: ["query"],
    },
    handler: async (args: Record<string, unknown>, ctx?: any) => {
      const agentId = ctx?.agentId ?? "agent_default";
      try {
        const params = new URLSearchParams({
          agentId,
          query: String(args.query ?? ""),
          limit: String(args.limit ?? 5),
        });
        if (ctx?.workspaceId) params.set("workspaceId", ctx.workspaceId);
        const data = await apiRequest<{ results: unknown[] }>(
          `/api/knowledge/search?${params}`,
        );
        return JSON.stringify({ ok: true, results: data.results });
      } catch (err: any) {
        return JSON.stringify({ ok: false, error: err.message ?? "Search failed" });
      }
    },
  },
  {
    name: "list_knowledge",
    description: "List knowledge entries in the current workspace knowledge base (paginated, newest first).",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max entries (default 20)" },
        offset: { type: "number", description: "Pagination offset" },
        tag: { type: "string", description: "Filter by tag" },
      },
    },
    handler: async (args: Record<string, unknown>, ctx?: any) => {
      const agentId = ctx?.agentId ?? "agent_default";
      const params = new URLSearchParams({ agentId });
      if (args.limit) params.set("limit", String(args.limit));
      if (args.offset) params.set("offset", String(args.offset));
      if (args.tag) params.set("tag", args.tag as string);
      if (ctx?.workspaceId) params.set("workspaceId", ctx.workspaceId);
      try {
        const data = await apiRequest(`/api/knowledge?${params}`);
        return JSON.stringify({ ok: true, ...data as object });
      } catch (err: any) {
        return JSON.stringify({ ok: false, error: err.message ?? "List failed" });
      }
    },
  },
  {
    name: "update_knowledge",
    description:
      "Update an existing knowledge entry IN PLACE — preserves the document's stable identity (parentId), so external references to it stay valid. Prefer this over delete + learn_from_text when revising a known document. Two modes: 'replace' (default) overwrites content wholesale; 'append' adds new content after existing content (then re-chunks the combined whole). All fields except id are optional — pass only what you want to change. Returns {parentId, firstId, count, mode}.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The knowledge entry ID (any chunk's id; resolves to its parent group)" },
        title: { type: "string", description: "New title (optional — omit to keep existing)" },
        content: { type: "string", description: "New content. Behavior depends on `mode`. Optional if you only want to change metadata (title/tags/sourceUrl)." },
        sourceUrl: { type: "string", description: "New source URL (optional — pass null to clear)" },
        tags: { type: "array", items: { type: "string" }, description: "New tags array — REPLACES existing tags entirely (not merged). Omit to keep existing." },
        mode: { type: "string", enum: ["replace", "append"], description: "How to apply `content`. 'replace' (default) overwrites; 'append' concatenates after existing content." },
      },
      required: ["id"],
    },
    handler: async (args: Record<string, unknown>, ctx?: any) => {
      const agentId = ctx?.agentId ?? "agent_default";
      const body: Record<string, unknown> = { agentId, workspaceId: ctx?.workspaceId ?? null };
      if (args.title !== undefined) body.title = args.title;
      if (args.content !== undefined) body.content = args.content;
      if (args.sourceUrl !== undefined) body.sourceUrl = args.sourceUrl;
      if (args.tags !== undefined) body.tags = args.tags;
      if (args.mode !== undefined) body.mode = args.mode;
      try {
        const data = await apiRequest(`/api/knowledge/${args.id}`, {
          method: "PUT",
          body,
        });
        return JSON.stringify(data);
      } catch (err: any) {
        return JSON.stringify({ ok: false, error: err.message ?? "Update failed" });
      }
    },
  },
  {
    name: "delete_knowledge",
    description: "Delete a knowledge entry from the current workspace knowledge base by its ID. Use update_knowledge instead if you want to revise an existing document — delete loses the stable parentId.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The knowledge entry ID to delete" },
      },
      required: ["id"],
    },
    handler: async (args: Record<string, unknown>, ctx?: any) => {
      const agentId = ctx?.agentId ?? "agent_default";
      try {
        const params = new URLSearchParams({ agentId });
        if (ctx?.workspaceId) params.set("workspaceId", ctx.workspaceId);
        await apiRequest(`/api/knowledge/${args.id}?${params}`, {
          method: "DELETE",
        });
        return JSON.stringify({ ok: true });
      } catch (err: any) {
        return JSON.stringify({ ok: false, error: err.message ?? "Delete failed" });
      }
    },
  },
];
