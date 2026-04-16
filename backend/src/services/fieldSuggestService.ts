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
}

export interface SuggestFieldsResponse {
  suggestions: FieldSuggestion[];
  hasMore: boolean;
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
3. 返回 8-12 个推荐字段。
4. 如果用户提供了正在创建的字段标题，第一个推荐应该是对该标题最合适的类型推断。
5. 推荐应该与数据表的用途场景相关，合理搭配不同类型。

# 输出格式
输出必须且只能是一个 JSON 数组，不包含任何其他内容（无解释、无 Markdown、无自然语言）。
每个元素格式：{ "name": "字段名", "type": "字段类型" }

示例输出：
[{"name":"负责人","type":"User"},{"name":"状态","type":"SingleSelect"},{"name":"截止日期","type":"DateTime"}]`;

// ─── Main function ───

export async function suggestFields(req: SuggestFieldsRequest): Promise<SuggestFieldsResponse> {
  const apiKey = process.env.ARK_API_KEY;
  if (!apiKey) {
    return { suggestions: [], hasMore: false };
  }

  // 1. Load table info
  const table = await store.getTable(req.tableId);
  if (!table) {
    return { suggestions: [], hasMore: false };
  }

  const tableName = table.name;
  const existingFieldNames = table.fields.map((f) => f.name);

  // 2. Build user message
  let userMessage: string;
  if (req.title?.trim()) {
    userMessage = `数据表名：${tableName}\n已有字段：${existingFieldNames.join(", ")}\n用户正在创建的字段标题：${req.title}\n请根据标题推断字段类型，并推荐 8-12 个其他合适的新字段。`;
  } else {
    userMessage = `数据表名：${tableName}\n已有字段：${existingFieldNames.join(", ")}\n请推荐 8-12 个合适的新字段。`;
  }

  // 3. Call ARK API
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
      const errorBody = await response.text();
      console.error(`[fieldSuggestService] API ${response.status}: ${errorBody}`);
      return { suggestions: [], hasMore: false };
    }

    const data = await response.json() as Record<string, any>;

    // 4. Extract text from response (Responses API format)
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
    // Chat completions fallback
    if (!text && data?.choices?.[0]?.message?.content) {
      text = data.choices[0].message.content;
    }
    if (!text) {
      console.error("[fieldSuggestService] No text in API response:", JSON.stringify(data).slice(0, 500));
      return { suggestions: [], hasMore: false };
    }

    // 5. Parse JSON array
    let parsed: FieldSuggestion[];
    try {
      parsed = JSON.parse(text.trim());
    } catch {
      // Try to extract JSON array from the response
      const match = text.match(/\[[\s\S]*\]/);
      if (match) {
        try {
          parsed = JSON.parse(match[0]);
        } catch {
          console.error("[fieldSuggestService] Failed to parse JSON from response:", text);
          return { suggestions: [], hasMore: false };
        }
      } else {
        console.error("[fieldSuggestService] No JSON array found in response:", text);
        return { suggestions: [], hasMore: false };
      }
    }

    if (!Array.isArray(parsed)) {
      return { suggestions: [], hasMore: false };
    }

    // 6. Filter out existing fields and excluded names
    const excludeSet = new Set([
      ...existingFieldNames,
      ...(req.excludeNames || []),
    ]);

    const suggestions = parsed
      .filter((s) => s && s.name && s.type && !excludeSet.has(s.name))
      .map((s) => ({ name: s.name, type: s.type, ...(s.icon ? { icon: s.icon } : {}) }));

    return { suggestions, hasMore: true };
  } catch (err) {
    console.error("[fieldSuggestService] Error:", err);
    return { suggestions: [], hasMore: false };
  }
}
