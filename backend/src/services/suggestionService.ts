/**
 * Suggestion Service — scheduled task that, for each known workspace,
 * generates 3-5 context-aware prompt suggestions the Chat Sidebar shows on
 * its welcome page. Without this the welcome page shows three hard-coded
 * chips ("答一个问题" / "帮我新建表" / "总结我的数据") that ignore what's
 * actually in the workspace.
 *
 * Flow:
 *   1. `refreshSuggestions(workspaceId)` — builds a thin workspace snapshot
 *      (table names + field names) and asks ARK to produce 3-5 JSON items
 *      like `{ label, prompt }`. Results are cached in memory.
 *   2. `getSuggestions(workspaceId)` — synchronously returns cached data.
 *      Returns `null` on cache miss; the route handler then kicks off a
 *      `refreshSuggestions` in the background and returns the default pack
 *      so the UI always has something to show.
 *   3. `startSuggestionScheduler()` — wired from backend/src/index.ts on
 *      startup. Runs an initial pass on `doc_default` then refreshes every
 *      10 minutes.
 *
 * Notes:
 *   • We reuse the ARK Responses API via the `ARK_API_KEY` env var already
 *     configured for the agent. Temperature 0.3 (a bit of variety so the
 *     suggestions don't feel canned) and a low max_output_tokens cap.
 *   • Cache is in-process only (Map). A server restart drops it; the
 *     scheduler repopulates on next tick.
 */

import * as store from "./dbStore.js";

const ARK_BASE_URL = process.env.ARK_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3";
const SEED_MODEL = process.env.SEED_MODEL || process.env.ARK_MODEL || "ep-20260412192731-vwdh7";

const REFRESH_INTERVAL_MS = 10 * 60 * 1000; // 10 min

export interface Suggestion {
  label: string;   // short button copy (≤14 汉字)
  prompt: string;  // full prompt inserted into the input box when clicked
}

interface CacheEntry {
  suggestions: Suggestion[];
  updatedAt: number;
  /** Signature of the document snapshot used to produce this pack. If the
   * document changes before the next refresh tick we can detect the drift
   * and re-run. */
  signature: string;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<Suggestion[]>>();

/** Stable, low-entropy summary of what tables/fields exist in the document.
 * Used both as model input AND as the cache signature — identical signature
 * means re-running would waste tokens. */
async function buildWorkspaceOutline(workspaceId: string): Promise<{ outline: string; signature: string }> {
  try {
    const tables = await store.listTablesForWorkspace(workspaceId);
    if (!tables || tables.length === 0) {
      return {
        outline: `文档 ${workspaceId} 目前没有任何数据表。`,
        signature: `empty:${workspaceId}`,
      };
    }
    const lines: string[] = [];
    const sigParts: string[] = [];
    for (const t of tables) {
      const detail = await store.getTable(t.id);
      if (!detail) continue;
      const fieldNames = detail.fields.map((f) => f.name).join("、");
      lines.push(`- ${detail.name}（${detail.records.length} 条记录）：${fieldNames}`);
      sigParts.push(`${detail.name}:${detail.fields.length}:${detail.records.length}`);
    }
    return {
      outline: lines.join("\n"),
      signature: sigParts.join("|"),
    };
  } catch (err) {
    return {
      outline: `(文档读取失败: ${err instanceof Error ? err.message : String(err)})`,
      signature: `error:${workspaceId}:${Date.now()}`,
    };
  }
}

/** Default pack returned on cache-miss or when the model call fails.
 * Keep these mirror-able to the frontend's i18n fallback keys (answer/save/report). */
export const DEFAULT_SUGGESTIONS: Suggestion[] = [
  { label: "了解当前文档结构", prompt: "帮我列出这个文档里有哪些表，各自有什么字段" },
  { label: "新建一张表", prompt: "帮我新建一张表，包含合适的字段" },
  { label: "汇总数据", prompt: "基于当前数据生成一份简单的汇总报告" },
];

const SYSTEM_PROMPT = `你是飞书多维表格的 AI 助手。你的任务是根据用户当前文档的结构，生成 3-5 条用户最可能想让你帮忙做的事情，作为欢迎页上的快捷建议按钮。

输出要求：
- 必须输出一个 JSON 数组，格式：[{"label":"...", "prompt":"..."}, ...]
- label：展示在按钮上的短句，不超过 14 个汉字，动词开头，具体且可执行
- prompt：点击按钮后填入输入框的完整提示，要清晰完整，能让 Agent 直接执行
- 严禁包裹在 Markdown 代码块里，严禁输出任何其他文字
- 如果文档有具体的表/字段，label 和 prompt 应该结合这些表名，例如"汇总项目管理表的状态分布"
- 如果文档为空，建议应该聚焦于"帮我新建什么表"这个起点

注意：你只负责生成建议文案，不需要调用任何工具。`;

async function callArkForSuggestions(outline: string): Promise<Suggestion[]> {
  const apiKey = process.env.ARK_API_KEY;
  if (!apiKey) throw new Error("ARK_API_KEY not configured");

  const userText = `# 当前文档结构\n${outline}\n\n请基于以上结构生成 3-5 条提示建议。`;

  const body: Record<string, unknown> = {
    model: SEED_MODEL,
    input: [
      { role: "system", content: [{ type: "input_text", text: SYSTEM_PROMPT }] },
      { role: "user", content: [{ type: "input_text", text: userText }] },
    ],
    max_output_tokens: 1024,
    temperature: 0.3,
    stream: false,
    thinking: { type: "disabled" },
  };

  const res = await fetch(`${ARK_BASE_URL}/responses`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`ARK ${res.status}: ${txt.slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    output?: Array<{ type: string; text?: string; content?: Array<{ type: string; text?: string }> }>;
    choices?: Array<{ message?: { content?: string } }>;
  };

  // Extract raw text from ARK Responses API output shape.
  let text = "";
  if (json.output) {
    for (const it of json.output) {
      if (it.type === "message" && it.content) {
        for (const c of it.content) {
          if (c.type === "output_text" && c.text) text += c.text;
        }
      } else if (it.type === "output_text" && it.text) {
        text += it.text;
      }
    }
  }
  if (!text && json.choices?.[0]?.message?.content) {
    text = json.choices[0].message.content;
  }
  if (!text) throw new Error("ARK returned no text content");

  return parseSuggestions(text);
}

/** Parse the model's JSON output defensively. The model is instructed to
 * return a bare JSON array, but real-world output sometimes has a
 * ```json ``` fence or leading prose — strip those before JSON.parse. */
function parseSuggestions(raw: string): Suggestion[] {
  let s = raw.trim();
  // Strip common Markdown fencing
  s = s.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
  // Take the first JSON array substring if there's surrounding prose
  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");
  if (start >= 0 && end > start) s = s.slice(start, end + 1);

  const parsed = JSON.parse(s) as unknown;
  if (!Array.isArray(parsed)) throw new Error("Not a JSON array");
  const out: Suggestion[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    const label = typeof rec.label === "string" ? rec.label.trim() : "";
    const prompt = typeof rec.prompt === "string" ? rec.prompt.trim() : "";
    if (label && prompt) out.push({ label, prompt });
    if (out.length >= 5) break;
  }
  if (out.length < 3) throw new Error(`Only parsed ${out.length} suggestions (need >=3)`);
  return out;
}

/** Synchronously read from cache. Returns null if never refreshed. */
export function getSuggestions(workspaceId: string): CacheEntry | null {
  return cache.get(workspaceId) ?? null;
}

/** Force a refresh; deduplicates concurrent calls for the same document. */
export async function refreshSuggestions(workspaceId: string): Promise<Suggestion[]> {
  const existing = inflight.get(workspaceId);
  if (existing) return existing;

  const p = (async () => {
    const { outline, signature } = await buildWorkspaceOutline(workspaceId);
    // Skip if signature unchanged — saves tokens when the doc didn't shift
    const cached = cache.get(workspaceId);
    if (cached && cached.signature === signature) {
      return cached.suggestions;
    }
    try {
      const suggestions = await callArkForSuggestions(outline);
      cache.set(workspaceId, {
        suggestions,
        updatedAt: Date.now(),
        signature,
      });
      console.log(`[suggestionService] refreshed ${workspaceId}: ${suggestions.length} items`);
      return suggestions;
    } catch (err) {
      console.warn(`[suggestionService] refresh failed for ${workspaceId}:`, err instanceof Error ? err.message : err);
      // Keep previous cache on failure; expose defaults only if we have nothing
      if (!cached) {
        cache.set(workspaceId, {
          suggestions: DEFAULT_SUGGESTIONS,
          updatedAt: Date.now(),
          signature: `default:${signature}`,
        });
      }
      return cache.get(workspaceId)!.suggestions;
    }
  })();

  inflight.set(workspaceId, p);
  try {
    return await p;
  } finally {
    inflight.delete(workspaceId);
  }
}

/** Called on server startup. Runs once now, then every 10 minutes. */
export function startSuggestionScheduler(seedWorkspaceIds: string[] = ["doc_default"]) {
  const tick = async () => {
    for (const wsId of seedWorkspaceIds) {
      try {
        await refreshSuggestions(wsId);
      } catch {
        // refreshSuggestions already logs; swallow so setInterval stays alive
      }
    }
  };
  // Initial run — deferred by a small delay so the rest of startup isn't
  // blocked waiting on the model.
  setTimeout(() => {
    void tick();
  }, 5_000);
  return setInterval(() => {
    void tick();
  }, REFRESH_INTERVAL_MS);
}
