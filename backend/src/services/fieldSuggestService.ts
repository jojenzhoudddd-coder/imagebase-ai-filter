import * as store from "./dbStore.js";

const ARK_BASE_URL = process.env.ARK_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3";
const ARK_MODEL = process.env.ARK_MODEL || "ep-20260412192731-vwdh7";

// ─── Types ───

export interface FieldSuggestion {
  name: string;      // recommended field name
  type: string;      // FieldType like "User", "SingleSelect", "ai_summary" etc
  icon?: string;     // optional icon hint
}

export interface SuggestFieldsRequest {
  tableId: string;
  title?: string;           // user's typed title (optional)
  excludeNames?: string[];  // already shown suggestions to exclude
  forceRefresh?: boolean;   // invalidate cache and call LLM again
}

export interface SuggestFieldsResponse {
  suggestions: FieldSuggestion[];
  hasMore: boolean;
}

// ─── Cache ───
// Per-table in-memory cache. Populated by warmup (fire-and-forget), served instantly by suggest.

interface CacheEntry {
  suggestions: FieldSuggestion[];
  timestamp: number;
  generating: boolean;  // true = LLM call in-flight
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function isCacheValid(entry: CacheEntry | undefined): entry is CacheEntry {
  if (!entry) return false;
  if (entry.generating) return false;
  if (entry.suggestions.length === 0) return false;
  return Date.now() - entry.timestamp < CACHE_TTL;
}

// ─── System Prompt ───

const FIELD_SUGGEST_SYSTEM_PROMPT = `# 角色
你是飞书多维表格（Lark Base）的字段推荐助手。你的任务是根据数据表的名称和已有字段，推荐合适的新字段。

# 支持的字段类型
- Text（多行文本）
- SingleSelect（单选）
- MultiSelect（多选）
- User（人员）
- Group（群组）
- DateTime（日期）
- Attachment（附件）
- Number（数字）
- Checkbox（复选框）
- Url（超链接）
- AutoNumber（自动编号）
- Phone（电话号码）
- Email（邮箱）
- Location（地理位置）
- Barcode（条码）
- Progress（进度）
- Currency（货币）
- Rating（评分）
- Formula（公式）
- SingleLink（单向关联）
- DuplexLink（双向关联）
- Lookup（查找引用）
- ai_summary（AI 摘要）
- ai_transition（AI 翻译）
- ai_extract（AI 信息提取）
- ai_classify（AI 分类）
- ai_tag（AI 标签）
- ai_custom（AI 自定义）

# 规则
1. 不要推荐与已有字段同名的字段。
2. 包含"姓名"或以"人"结尾的字段（如"负责人""创建人""审批人"）必须使用 User 类型。
3. 返回用户指定数量的推荐字段（10-20 个）。
4. 如果用户提供了正在创建的字段标题，第一个推荐应该是对该标题最合适的类型推断。
5. 推荐应该与数据表的用途场景相关，合理搭配不同类型。

# 输出格式
输出必须且只能是一个 JSON 数组，不包含任何其他内容（无解释、无 Markdown、无自然语言）。
每个元素格式：{ "name": "字段名", "type": "字段类型" }

示例输出：
[{"name":"负责人","type":"User"},{"name":"状态","type":"SingleSelect"},{"name":"截止日期","type":"DateTime"}]`;

// ─── Core LLM call (no cache) ───

async function callLLM(tableId: string): Promise<FieldSuggestion[]> {
  const apiKey = process.env.ARK_API_KEY;
  if (!apiKey) return [];

  const table = await store.getTable(tableId);
  if (!table) return [];

  const tableName = table.name;
  const existingFieldNames = table.fields.map((f) => f.name);
  // Dynamic count: min 10, max 20, scales with existing field count
  const suggestCount = Math.min(20, Math.max(10, existingFieldNames.length + 5));
  const userMessage = `数据表名：${tableName}\n已有字段：${existingFieldNames.join(", ")}\n请推荐 ${suggestCount} 个合适的新字段。`;

  try {
    const response = await fetch(`${ARK_BASE_URL}/responses`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: ARK_MODEL,
        input: [
          { role: "system", content: FIELD_SUGGEST_SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
        max_output_tokens: 2048,
        temperature: 0.7,
        stream: false,
        thinking: { type: "disabled" },
      }),
    });

    if (!response.ok) {
      console.error(`[fieldSuggest] API ${response.status}: ${await response.text()}`);
      return [];
    }

    const data = await response.json() as Record<string, any>;

    // Extract text
    let text: string | null = null;
    if (Array.isArray(data?.output)) {
      for (const item of data.output) {
        if (item.type === "message" && Array.isArray(item.content)) {
          for (const c of item.content) {
            if (c.type === "output_text" && c.text) { text = c.text; break; }
          }
        }
        if (item.type === "output_text" && item.text) { text = item.text; break; }
        if (text) break;
      }
    }
    if (!text && data?.choices?.[0]?.message?.content) {
      text = data.choices[0].message.content;
    }
    if (!text) return [];

    // Parse JSON
    let parsed: FieldSuggestion[];
    try {
      parsed = JSON.parse(text.trim());
    } catch {
      const match = text.match(/\[[\s\S]*\]/);
      if (match) {
        try { parsed = JSON.parse(match[0]); } catch { return []; }
      } else {
        return [];
      }
    }

    if (!Array.isArray(parsed)) return [];

    // Filter out existing fields
    const existingSet = new Set(existingFieldNames);
    return parsed
      .filter((s) => s && s.name && s.type && !existingSet.has(s.name))
      .map((s) => ({ name: s.name, type: s.type }));
  } catch (err) {
    console.error("[fieldSuggest] Error:", err);
    return [];
  }
}

// ─── Warmup: called on table load, fire-and-forget ───

export function warmupSuggestions(tableId: string): void {
  const entry = cache.get(tableId);
  if (isCacheValid(entry)) return;        // already cached & fresh
  if (entry?.generating) return;           // already in-flight

  // Mark as generating to prevent duplicate calls
  cache.set(tableId, { suggestions: [], timestamp: 0, generating: true });

  callLLM(tableId).then((suggestions) => {
    cache.set(tableId, { suggestions, timestamp: Date.now(), generating: false });
    console.log(`[fieldSuggest] Warmed up ${tableId}: ${suggestions.length} suggestions`);
  }).catch(() => {
    cache.delete(tableId);
  });
}

// ─── Invalidate cache (call after field create/update/delete) ───

export function invalidateSuggestionCache(tableId: string): void {
  cache.delete(tableId);
}

// ─── Main function: returns cached if available, else generates ───

export async function suggestFields(req: SuggestFieldsRequest): Promise<SuggestFieldsResponse> {
  // Force refresh: invalidate cache and call LLM again
  if (req.forceRefresh) {
    cache.delete(req.tableId);
  }

  const entry = cache.get(req.tableId);
  let suggestions: FieldSuggestion[];

  if (isCacheValid(entry)) {
    suggestions = entry.suggestions;
  } else {
    suggestions = await callLLM(req.tableId);
    cache.set(req.tableId, { suggestions, timestamp: Date.now(), generating: false });
  }

  // Filter out excludeNames
  if (req.excludeNames && req.excludeNames.length > 0) {
    const excludeSet = new Set(req.excludeNames);
    suggestions = suggestions.filter((s) => !excludeSet.has(s.name));
  }

  return { suggestions, hasMore: true };
}
