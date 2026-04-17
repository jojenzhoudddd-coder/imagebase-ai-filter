# AI Prompt Patterns Skill

Use this skill when creating, modifying, or debugging any AI-powered feature that calls the Volcano ARK API. It codifies the project's Prompt Engineering patterns, model parameter strategies, and structured output conventions.

## When to Use
- Creating a new AI feature (new service + endpoint)
- Modifying an existing AI Prompt (system prompt, tool definitions)
- Tuning model parameters (temperature, max_tokens)
- Debugging AI output quality issues (hallucination, format errors, missing fields)
- Adding new tool definitions for AI to call
- Reviewing AI-related code changes

## Model Configuration

### Volcano ARK API
```
Base URL:  https://ark.cn-beijing.volces.com/api/v3
Endpoint:  /responses (Responses API, not Chat Completions)
Model ID:  ep-20260412192731-vwdh7 (from ARK_MODEL env var)
Auth:      Authorization: Bearer ${ARK_API_KEY}
```

### Standard Request Structure
```typescript
const response = await fetch(`${ARK_BASE_URL}/responses`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${process.env.ARK_API_KEY}`,
  },
  body: JSON.stringify({
    model: ARK_MODEL,
    input: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    temperature,
    max_output_tokens,
    stream: false,
    thinking: { type: "disabled" },
    // tools: [...] (optional, for Tool Use)
  }),
});
```

## Temperature Selection Strategy

Temperature controls the randomness/creativity of model output. This project uses two distinct temperature zones:

| Temperature | When to Use | Project Examples |
|-------------|-------------|-----------------|
| **0.1** (Precision) | Output must be structurally correct, any deviation breaks functionality | AI Filter — wrong field name = broken filter |
| **0.7** (Creative) | Output should be diverse/interesting while staying within constraints | Field Suggest — same recommendations every time = bad UX; Table Generate — varied field designs |

### Decision Framework
```
Is the output directly consumed by code (parsed as JSON, used as API input)?
  → Does a single wrong token break the feature?
    YES → temperature: 0.1 (precision mode)
    NO  → temperature: 0.7 (creative mode)

Is the output presented to users for selection/review?
  → temperature: 0.7 (creative mode — diversity matters)
```

### Never Use
- **0.0**: Too deterministic, identical outputs on retry, no recovery from bad patterns
- **1.0+**: Too random, high hallucination risk, format compliance drops

## Thinking Mode

All AI features in this project disable extended thinking:

```typescript
thinking: { type: "disabled" }
```

**Why**: The Volcano ARK API charges tokens for thinking output. Our tasks (structured JSON generation) don't benefit from chain-of-thought reasoning — the model either knows the answer or doesn't. Disabling thinking reduces latency and cost.

**When to enable**: If a future feature requires complex multi-step reasoning (e.g., data analysis, formula generation), consider `thinking: { type: "enabled", budget_tokens: 2048 }`.

## Structured Output Patterns

### Pattern 1: JSON-Only Output (All Current Features)

The most critical pattern in this project. The model must output **only** valid JSON — no markdown, no explanation, no natural language.

**Prompt Template**:
```
# 输出约束（最高优先级）

1. 你的最终输出有且只有一个 JSON [对象/数组]，不包含任何其他内容
   （无解释、无确认、无 Markdown 代码块、无自然语言）
2. [Specific format definition]
3. 最终 JSON 之后不得追加任何文字
```

**Key rules**:
- Put output constraints at the TOP of the prompt, marked as "highest priority"
- Define the exact JSON schema with examples
- Explicitly list what NOT to include (explanations, markdown, etc.)
- Provide a complete example output as few-shot reference

### Pattern 2: Enum Constraint (Filter Operators, Field Types)

When the model must choose from a fixed set of values:

```
### operator（第 2 位）
- 类型：string
- 枚举值（严格使用以下字面量）：

> ==          等于        自然语言：等于 / 是 / 为 / 只看
> !=          不等于      自然语言：不等于 / 不是 / 排除
> >           大于/晚于   自然语言：大于 / 超过 / 高于 / 晚于 / 之后
```

**Key rules**:
- List every valid value explicitly
- Map natural language equivalents (helps model understand user intent)
- Mark as "strict" to prevent invention of new values

### Pattern 3: Type-Specific Rules

When behavior varies by data type (e.g., filtering a Date vs. filtering a Select):

```
### DateTime 字段
- 操作符：>, >=, <, <=, ==, !=
- value 格式：ISO 日期字符串 "YYYY-MM-DD" 或 "YYYY-MM-DD HH:mm"
- "今天" = 当前日期, "本周" = 周一到周日
- 使用工具返回的 currentDate 锚定相对时间

### SingleSelect 字段
- value 必须是该字段已有的选项值之一
- 不得编造不存在的选项
```

### Pattern 4: Semantic Binding (Field Name → Type Mapping)

Force specific type choices based on field name semantics:

```
包含"姓名"或以"人"结尾的字段（如负责人、审批人、经办人）必须使用 User 类型
```

This prevents the model from using Text for fields that should be User type.

### Pattern 5: Exclusion List (What NOT to Generate)

Explicitly list things the model should avoid:

```
# 不可用于自动生成的字段类型（需要引用其他表或字段，跳过）
Formula, SingleLink, DuplexLink, Lookup, CreatedUser, ModifiedUser,
ai_summary, ai_transition, ai_extract, ai_classify, ai_tag, ai_custom
```

### Pattern 6: Graceful Degradation (Empty/Fallback Output)

When the user's request doesn't match the feature's purpose:

```
当用户指令与筛选完全无关（闲聊、导出、写邮件等）时，输出空条件 JSON：
{"logic":"and","conditions":[]}
```

**Never** refuse or explain — always return valid JSON, even if it's empty.

## Tool Use Pattern (Multi-Turn)

Used by AI Filter to gather context before generating output.

### Tool Definition Structure
```typescript
tools: [
  {
    type: "function",
    name: "get_table_brief_info",
    description: "获取数据表的字段列表，包含字段名称、类型、选项值等",
    parameters: {
      type: "object",
      properties: {
        table_id: { type: "string", description: "数据表 ID" },
      },
      required: ["table_id"],
    },
  },
  // ... more tools
]
```

### Multi-Turn Loop
```typescript
let rounds = 0;
const MAX_TOOL_ROUNDS = 3;

while (rounds < MAX_TOOL_ROUNDS) {
  const response = await callARK(messages);

  if (response has tool_calls) {
    // Execute each tool call
    // Append tool results to messages
    rounds++;
    continue;
  }

  // No tool calls = final answer
  return response.output_text;
}
```

### Tool Design Rules
1. Tools should return **concise** data — don't dump entire tables
2. Include `currentDate` in tool responses for time-relative queries
3. Tool names use snake_case: `get_table_brief_info`, `search_record`
4. Tool descriptions in Chinese (matches system prompt language)
5. Maximum 3 tool rounds to prevent infinite loops

## Prompt Structure Template

Every AI service prompt in this project follows this structure:

```
# 角色
[One sentence defining who the model is]

# 输出约束（最高优先级）
[JSON-only output rules]

# [Domain-specific format definition]
[Schema, examples, enum values]

# [Type-specific rules]
[Per-field-type behavior]

# [Constraint rules]
[What to do, what not to do, edge cases]

# 示例输出
[Complete few-shot example]
```

**Order matters**: Role → Output constraints → Format → Rules → Examples. Output constraints come second (right after role) because they are the most critical instruction.

## Debugging AI Output Issues

### Model outputs extra text besides JSON
- Strengthen output constraint: add "不包含任何 Markdown 代码块标记（无 ```json）"
- Add "最终 JSON 之后不得追加任何文字"
- Lower temperature (move toward 0.1)

### Model invents values not in the schema
- Add explicit exclusion list
- Add "值必须是已有选项之一，不得编造"
- Use Tool Use to provide real data instead of relying on the model's knowledge

### Model generates wrong number of items
- Specify range: "生成 8-20 个字段，数量由你根据业务复杂度自行判断"
- Don't use fixed numbers — the model will always hit exactly that number regardless of context

### Model ignores type-specific config
- Add per-type config rules with explicit required fields
- Provide a complete few-shot example covering all types
- Mark config as "必须严格按照上述类型规则设置，不可遗漏必填 config"

### Time-relative queries are wrong ("this week", "last month")
- Provide current date via tool response, not in system prompt
- Explicitly define boundaries: "本周 = 本周一 00:00 到本周日 23:59"

## Three AI Services Comparison

| Dimension | AI Filter | Field Suggest | Table Generate |
|-----------|-----------|--------------|----------------|
| File | `aiService.ts` | `fieldSuggestService.ts` | `tableGenerateService.ts` |
| Purpose | NL → filter JSON | Recommend new fields | Design full table schema |
| Temperature | 0.1 | 0.7 | 0.7 |
| max_tokens | 4096 | 2048 | 4096 |
| Tool Use | Yes (3 rounds max) | No | No |
| Stream | SSE (via route) | Sync | SSE (via route) |
| Cache | None | 5min TTL, per-table | None |
| Output | `{ logic, conditions }` | `[{ name, type }]` | `[{ name, type, isPrimary, config }]` |
| Complexity | ★★★★ | ★★ | ★★★★★ |

## Checklist for New AI Features

- [ ] Define temperature based on precision vs. creativity needs
- [ ] Set `thinking: { type: "disabled" }` unless complex reasoning needed
- [ ] Write system prompt following the standard structure (Role → Constraints → Format → Rules → Examples)
- [ ] Output constraints at top, marked as highest priority
- [ ] JSON-only output with explicit "no explanation" rule
- [ ] Provide complete few-shot example in prompt
- [ ] Add graceful degradation (empty/fallback output for irrelevant requests)
- [ ] Implement JSON parsing with try-catch and fallback
- [ ] Add logging: input, output, tool calls, timing, errors → `backend/logs/`
- [ ] Set `max_output_tokens` high enough to avoid truncation (4096 default)
- [ ] If using Tool Use: cap rounds at 3, handle tool execution errors
