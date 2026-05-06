/**
 * Knowledge tools — Agent can learn, search, list, and delete knowledge.
 * learn_from_url / learn_from_text are Tier 0 (always available).
 * search_knowledge / list_knowledge are Tier 1 (always-on retrieval).
 */

import type { ToolDefinition } from "./tableTools.js";

const BASE_URL = `http://localhost:${process.env.PORT || 3001}`;

export const knowledgeTools: ToolDefinition[] = [
  {
    name: "learn_from_url",
    description:
      "Store web page content as ONE complete document in the knowledge base. This is the ONLY correct tool for 'learning from URL' — never use create_memory. IMPORTANT: Save ALL extracted content in a SINGLE call. The content field has NO length limit — include the full page content, do NOT truncate.",
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
      const res = await fetch(`${BASE_URL}/api/knowledge`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: `auth_token=${ctx?.authToken ?? ""}` },
        body: JSON.stringify({
          agentId: ctx?.agentId ?? "agent_default",
          title: args.title,
          content: args.content,
          sourceUrl: args.url,
          sourceType: "web",
          tags: args.tags ?? [],
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        return JSON.stringify({ ok: false, error: (err as any).error ?? `HTTP ${res.status}` });
      }
      const data = await res.json();
      return JSON.stringify({ ok: true, ...data });
    },
  },
  {
    name: "learn_from_text",
    description:
      "Store knowledge as ONE complete document in the knowledge base. This is the ONLY correct tool for 'learning knowledge' — never use create_memory for this purpose. IMPORTANT: Save ALL content in a SINGLE call. The content field has NO length limit — write the full document, do NOT truncate or split.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "A concise title for the document" },
        content: { type: "string", description: "The COMPLETE, UNTRUNCATED knowledge content as a single Markdown document. No length limit. Include everything — do NOT cut short or split into multiple calls." },
        tags: { type: "array", items: { type: "string" }, description: "Topic tags" },
      },
      required: ["title", "content"],
    },
    handler: async (args: Record<string, unknown>, ctx?: any) => {
      const contentStr = args.content as string;
      console.log(`[learn_from_text] title="${args.title}" content_len=${contentStr?.length ?? 0} tags=${JSON.stringify(args.tags ?? [])}`);
      const res = await fetch(`${BASE_URL}/api/knowledge`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: `auth_token=${ctx?.authToken ?? ""}` },
        body: JSON.stringify({
          agentId: ctx?.agentId ?? "agent_default",
          title: args.title,
          content: contentStr,
          sourceType: "chat",
          tags: args.tags ?? [],
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        console.log(`[learn_from_text] FAILED: ${(err as any).error ?? res.status}`);
        return JSON.stringify({ ok: false, error: (err as any).error ?? `HTTP ${res.status}` });
      }
      const data = await res.json();
      console.log(`[learn_from_text] SUCCESS: merged=${(data as any).merged ?? false} count=${(data as any).count}`);
      return JSON.stringify({ ok: true, ...data });
    },
  },
  {
    name: "search_knowledge",
    description:
      "Search the agent's knowledge base using semantic similarity. Returns the most relevant entries for the given query. Use this when you need to recall previously learned information.",
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
      const res = await fetch(
        `${BASE_URL}/api/knowledge/search?agentId=${encodeURIComponent(agentId)}&query=${encodeURIComponent(args.query as string)}&limit=${args.limit ?? 5}`,
        { headers: { Cookie: `auth_token=${ctx?.authToken ?? ""}` } },
      );
      if (!res.ok) return JSON.stringify({ ok: false, error: `HTTP ${res.status}` });
      const data = await res.json();
      return JSON.stringify({ ok: true, results: data.results });
    },
  },
  {
    name: "list_knowledge",
    description: "List knowledge entries in the agent's knowledge base (paginated, newest first).",
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
      const res = await fetch(`${BASE_URL}/api/knowledge?${params}`, {
        headers: { Cookie: `auth_token=${ctx?.authToken ?? ""}` },
      });
      if (!res.ok) return JSON.stringify({ ok: false, error: `HTTP ${res.status}` });
      const data = await res.json();
      return JSON.stringify({ ok: true, ...data });
    },
  },
  {
    name: "delete_knowledge",
    description: "Delete a knowledge entry from the agent's knowledge base by its ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The knowledge entry ID to delete" },
      },
      required: ["id"],
    },
    handler: async (args: Record<string, unknown>, ctx?: any) => {
      const agentId = ctx?.agentId ?? "agent_default";
      const res = await fetch(`${BASE_URL}/api/knowledge/${args.id}?agentId=${encodeURIComponent(agentId)}`, {
        method: "DELETE",
        headers: { Cookie: `auth_token=${ctx?.authToken ?? ""}` },
      });
      if (res.status === 204) return JSON.stringify({ ok: true });
      const err = await res.json().catch(() => ({}));
      return JSON.stringify({ ok: false, error: (err as any).error ?? `HTTP ${res.status}` });
    },
  },
];
