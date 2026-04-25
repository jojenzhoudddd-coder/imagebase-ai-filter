import { recordTokenUsage } from "./tokenUsageService.js";

const ARK_BASE_URL = process.env.ARK_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3";
const ARK_MODEL = process.env.ARK_MODEL || "ep-20260412192731-vwdh7";

// ─── Types ───

export interface GeneratedField {
  name: string;
  type: string;
  isPrimary?: boolean;
  config?: Record<string, any>;
}

// ─── System Prompt ───

const TABLE_GENERATE_SYSTEM_PROMPT = `# 角色
你是飞书多维表格（Lark Base）的表结构设计师。你的任务是根据用户提供的数据表名称，设计一套合理的字段结构。

# 命名约束
- 字段名称长度 1–100 字符
- 字段名称禁止包含 "[" 和 "]" 字符，若出现必须移除

# 索引列（主键）
每个数据表必须且仅有一个索引列（isPrimary=true），用于唯一标识记录。
可设为索引列的字段类型仅限：Text、DateTime、Number、Url、AutoNumber、Phone、Email、Location、Barcode、Progress、Currency。
建议索引列使用 Text 类型。

# 支持的基础字段类型及 config 规则

1. **Text**（多行文本）：config 为 {}
2. **SingleSelect**（单选）：config 必须包含 options 数组
   - 每个选项：{ "id": "opt_<随机4位>", "name": "选项名", "color": "颜色值" }
   - 提供 3-6 个合理选项
   - 可用颜色：#4DC4A0, #57AEFA, #F5A623, #E88D89, #B17FDB, #73C9E1, #98D067, #FF8F8F, #C4A0DC, #5BD3A3
3. **MultiSelect**（多选）：config 同 SingleSelect
4. **User**（人员）：config 为 {}。**强制约束**：包含"姓名"或以"人"结尾的字段（如负责人、审批人、经办人）必须使用 User 类型
5. **Group**（群组）：config 为 {}
6. **DateTime**（日期）：config: { "format": "yyyy/MM/dd", "includeTime": false }
   - format 仅支持 "yyyy/MM/dd" 或 "yyyy/MM/dd HH:mm"
   - includeTime: true 时使用 "yyyy/MM/dd HH:mm"
7. **Attachment**（附件）：config 为 {}
8. **Number**（数字）：config: { "numberFormat": "integer" }
   - numberFormat 可选：integer, thousands, thousandsDecimal, decimal1-decimal9, percent, percentDecimal
9. **Checkbox**（复选框）：config 为 {}
10. **Url**（超链接）：config 为 {}
11. **AutoNumber**（自动编号）：config: { "autoNumberMode": "increment" }
12. **Phone**（电话号码）：config 为 {}
13. **Email**（邮箱）：config 为 {}
14. **Location**（地理位置）：config 为 {}
15. **Barcode**（条码）：config 为 {}
16. **Progress**（进度）：config: { "progressFormat": "percent", "progressPrecision": 0 }
    - progressFormat: "number" 或 "percent"
    - progressPrecision: 0, 1, 或 2
17. **Currency**（货币）：config: { "currencyCode": "CNY", "currencyPrecision": 2 }
    - currencyCode: CNY, USD, EUR, GBP, JPY, KRW, HKD, TWD, SGD, AUD, CAD, INR
    - currencyPrecision: 0, 1, 2, 3, 4
18. **Rating**（评分）：config: { "ratingSymbol": "star", "ratingMin": 1, "ratingMax": 5 }
    - ratingSymbol: star, heart, thumbsUp, fire, smile, lightning, flower, number
    - ratingMin: 0 或 1; ratingMax: 1-10 整数

# 系统字段类型（按需使用，值由系统自动填充）
- **CreatedTime**（创建时间）：config: { "format": "yyyy/MM/dd HH:mm", "includeTime": true }
- **ModifiedTime**（最后更新时间）：config: { "format": "yyyy/MM/dd HH:mm", "includeTime": true }

# 不可用于自动生成的字段类型（需要引用其他表或字段，跳过）
Formula, SingleLink, DuplexLink, Lookup, CreatedUser, ModifiedUser, ai_summary, ai_transition, ai_extract, ai_classify, ai_tag, ai_custom

# 设计规则
1. 第一个字段必须是 Text 类型，isPrimary=true，名称为该表最核心的标识字段
2. 生成 8-20 个字段，数量由你根据表名的业务复杂度自行判断，类型合理搭配，覆盖业务场景常见需求
3. 除第一个字段外，其余字段 isPrimary=false
4. 每个字段的 config 必须严格按照上述类型规则设置，不可遗漏必填 config
5. 字段类型必须属于上述支持列表，不可使用不存在的类型

# 输出格式
输出必须且只能是一个 JSON 数组，不包含任何其他内容（无解释、无 Markdown、无自然语言）。
每个元素格式：{ "name": "字段名", "type": "字段类型", "isPrimary": true/false, "config": {} }

示例输出（表名"项目管理"）：
[{"name":"项目名称","type":"Text","isPrimary":true,"config":{}},{"name":"负责人","type":"User","isPrimary":false,"config":{}},{"name":"状态","type":"SingleSelect","isPrimary":false,"config":{"options":[{"id":"opt_a1b2","name":"未开始","color":"#98D067"},{"id":"opt_c3d4","name":"进行中","color":"#57AEFA"},{"id":"opt_e5f6","name":"已完成","color":"#4DC4A0"},{"id":"opt_g7h8","name":"已取消","color":"#E88D89"}]}},{"name":"优先级","type":"SingleSelect","isPrimary":false,"config":{"options":[{"id":"opt_i9j0","name":"高","color":"#FF8F8F"},{"id":"opt_k1l2","name":"中","color":"#F5A623"},{"id":"opt_m3n4","name":"低","color":"#4DC4A0"}]}},{"name":"截止日期","type":"DateTime","isPrimary":false,"config":{"format":"yyyy/MM/dd","includeTime":false}},{"name":"进度","type":"Progress","isPrimary":false,"config":{"progressFormat":"percent","progressPrecision":0}},{"name":"预算","type":"Currency","isPrimary":false,"config":{"currencyCode":"CNY","currencyPrecision":2}},{"name":"备注","type":"Text","isPrimary":false,"config":{}}]`;

// ─── Main function ───

export async function generateTableFields(
  tableName: string,
  recordContext?: { userId: string | null; workspaceId?: string | null },
): Promise<GeneratedField[]> {
  const apiKey = process.env.ARK_API_KEY;
  if (!apiKey) {
    throw new Error("ARK_API_KEY not configured");
  }

  const userMessage = `数据表名：${tableName}\n请为这个数据表设计合理的字段结构。`;

  const startedAt = Date.now();
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
          { role: "system", content: TABLE_GENERATE_SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
        max_output_tokens: 4096,
        temperature: 0.7,
        stream: false,
        thinking: { type: "disabled" },
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`[tableGenerateService] API ${response.status}: ${errorBody}`);
      throw new Error(`AI API returned ${response.status}`);
    }

    const data = await response.json() as Record<string, any>;

    // Token 埋点
    const usage = data?.usage;
    if (recordContext && usage && typeof usage === "object") {
      const promptTokens = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0);
      const completionTokens = Number(usage.output_tokens ?? usage.completion_tokens ?? 0);
      const totalTokens = Number(usage.total_tokens ?? promptTokens + completionTokens);
      if (totalTokens > 0) {
        void recordTokenUsage(
          { ...recordContext, model: ARK_MODEL, provider: "ark", feature: "table-generate" },
          { promptTokens, completionTokens, totalTokens, durationMs: Date.now() - startedAt },
        );
      }
    }

    // Extract text from response (Responses API format)
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
      console.error("[tableGenerateService] No text in API response:", JSON.stringify(data).slice(0, 500));
      throw new Error("No text in AI response");
    }

    // Parse JSON array
    let parsed: GeneratedField[];
    try {
      parsed = JSON.parse(text.trim());
    } catch {
      const match = text.match(/\[[\s\S]*\]/);
      if (match) {
        try {
          parsed = JSON.parse(match[0]);
        } catch {
          console.error("[tableGenerateService] Failed to parse JSON from response:", text);
          throw new Error("Failed to parse AI response");
        }
      } else {
        console.error("[tableGenerateService] No JSON array found in response:", text);
        throw new Error("No JSON array in AI response");
      }
    }

    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error("AI returned empty or invalid field array");
    }

    // Validate and normalize
    const fields = parsed
      .filter(f => f && typeof f.name === "string" && typeof f.type === "string")
      .map((f, i) => ({
        name: f.name.replace(/[\[\]]/g, "").slice(0, 100),
        type: f.type,
        isPrimary: i === 0, // Force first field as primary
        config: f.config ?? {},
      }));

    if (fields.length === 0) {
      throw new Error("No valid fields in AI response");
    }

    // Ensure first field is Text type
    fields[0].type = "Text";
    fields[0].isPrimary = true;

    return fields;
  } catch (err) {
    console.error("[tableGenerateService] Error:", err);
    throw err;
  }
}
