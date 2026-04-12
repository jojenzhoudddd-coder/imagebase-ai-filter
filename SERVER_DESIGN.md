# AI Filter 服务端完整功能方案

> 基于多维表格 AI 智能筛选功能的完整后端设计，包含表格数据架构、筛选表达式设计、模型调用链路三部分。

---

## 一、整体架构设计

### 1.1 系统总览

```
┌─────────────────────────────────────────────────────────────────┐
│                        客户端（Browser）                         │
│   筛选面板 UI  →  自然语言输入  →  提交 Query                    │
└────────────────────────────┬────────────────────────────────────┘
                             │ HTTP / SSE
┌────────────────────────────▼────────────────────────────────────┐
│                       API 网关 / BFF                            │
│   /api/table/*   /api/view/*   /api/ai/filter                   │
└────┬───────────────────────┬────────────────────────────────────┘
     │                       │
     ▼                       ▼
┌──────────┐         ┌───────────────────┐
│ 表格服务  │         │  AI 筛选服务       │
│ TableSvc │         │  FilterGenSvc     │
└──────────┘         └────────┬──────────┘
     │                        │
     ▼                        ▼
┌──────────┐         ┌───────────────────┐
│  数据库   │         │  大模型 API        │
│ Postgres │         │  (Claude / GPT)   │
└──────────┘         └───────────────────┘
```

### 1.2 核心服务职责

| 服务 | 职责 |
|------|------|
| **TableSvc** | 表格/字段/记录/视图 CRUD，筛选条件执行 |
| **FilterGenSvc** | 接收自然语言 Query，调用 LLM 生成筛选表达式，做合法性校验 |
| **AuthSvc** | 用户身份验证，人员字段可选项鉴权 |

---

## 二、多维表格数据结构设计

### 2.1 数据模型

#### Table（数据表）
```typescript
interface Table {
  id: string;             // 表 ID，全局唯一
  name: string;           // 表名，1–100字符，不含 [* 和 *]
  baseId: string;         // 所属多维表格 ID
  fields: Field[];        // 字段列表（有序）
  createdAt: number;      // 创建时间 ms
  updatedAt: number;
}
```

#### Field（字段）
```typescript
type FieldType =
  | "Text" | "Number" | "SingleSelect" | "MultiSelect"
  | "User" | "DateTime" | "Attachment" | "Checkbox"
  | "Stage" | "AutoNumber" | "Url" | "Phone" | "Email"
  | "Location" | "Barcode" | "Progress" | "Currency"
  | "Rating" | "Formula" | "SingleLink" | "DuplexLink"
  | "Lookup" | "CreatedUser" | "ModifiedUser"
  | "CreatedTime" | "ModifiedTime"
  | "ai_summary" | "ai_transition" | "ai_extract"
  | "ai_classify" | "ai_tag" | "ai_custom";

interface Field {
  id: string;
  tableId: string;
  name: string;
  type: FieldType;
  isPrimary: boolean;       // 是否为索引列
  isSystem: boolean;        // 系统字段不可编辑
  config: FieldConfig;      // 各类型专属配置
}

// 单选/多选字段配置
interface SelectFieldConfig {
  options: SelectOption[];  // 选项列表
}
interface SelectOption {
  id: string;
  name: string;
  color: string;
}

// 日期字段配置
interface DateFieldConfig {
  format: "yyyy-MM-dd" | "yyyy-MM-dd HH:mm";
  includeTime: boolean;
}

// 数字字段配置
interface NumberFieldConfig {
  format: "integer" | "thousands" | "thousands_decimal"
        | "decimal_1" | "decimal_2" | /* ... */ "decimal_9"
        | "percent" | "percent_decimal";
}
```

#### Record（记录）
```typescript
interface Record {
  id: string;               // 记录 ID
  tableId: string;
  cells: Record<string, CellValue>;  // fieldId → value
  createdAt: number;
  updatedAt: number;
  createdBy: string;        // userId
  modifiedBy: string;
}

type CellValue =
  | string                  // Text, SingleSelect, Formula(text)
  | number                  // Number, Progress, Rating, Currency
  | boolean                 // Checkbox
  | string[]                // MultiSelect, User（存 userId 列表）
  | AttachmentCell[]        // Attachment
  | null;
```

#### View（视图）
```typescript
type ViewType = "Grid" | "Kanban" | "Calendar" | "Gallery" | "Gantt";

interface View {
  id: string;
  tableId: string;
  name: string;             // 1–100字符
  type: ViewType;
  filter: ViewFilter;
  sort: ViewSort[];
  group: ViewGroup[];
  hiddenFields: string[];   // fieldId 列表，索引列不可隐藏
}
```

### 2.2 视图筛选数据结构

```typescript
type FilterLogic = "and" | "or";  // 所有满足 / 任一满足

interface ViewFilter {
  logic: FilterLogic;
  conditions: FilterCondition[];
}

interface FilterCondition {
  id: string;               // 条件唯一 ID（前端生成）
  fieldId: string;          // 必须是当前表字段
  operator: FilterOperator;
  value: FilterValue;       // 仅支持常量，不支持变量
}

type FilterOperator =
  // 通用
  | "isEmpty" | "isNotEmpty"
  // 文本类
  | "eq" | "neq" | "contains" | "notContains"
  // 数字类
  | "gt" | "gte" | "lt" | "lte"
  // 日期类
  | "after" | "before"
  // 复选框专用
  | "checked" | "unchecked";

// 筛选值：常量只，日期支持相对日期枚举
type FilterValue =
  | string
  | number
  | string[]        // 多选时多个选项
  | RelativeDateValue
  | null;

type RelativeDateValue =
  | "today" | "tomorrow" | "yesterday"
  | "thisWeek" | "lastWeek"
  | "thisMonth" | "lastMonth"
  | "last7Days" | "next7Days"
  | "last30Days" | "next30Days";
```

### 2.3 核心 API 接口

```
# 表格/字段
GET    /api/tables/:tableId/fields          获取字段列表（含类型、选项）
GET    /api/tables/:tableId/records         分页获取记录
POST   /api/tables/:tableId/records/query   按筛选条件查询记录

# 视图
GET    /api/tables/:tableId/views           获取视图列表
GET    /api/views/:viewId                   获取视图详情（含筛选条件）
PUT    /api/views/:viewId/filter            更新视图筛选条件
POST   /api/views                           保存为新视图

# AI 筛选
POST   /api/ai/filter/generate              生成筛选表达式
POST   /api/ai/filter/validate              校验筛选表达式合法性
```

---

## 三、智能筛选后台设计

### 3.1 筛选执行引擎

#### 服务端记录过滤逻辑

```typescript
function filterRecords(
  records: Record[],
  filter: ViewFilter,
  fields: Map<string, Field>
): Record[] {
  if (!filter.conditions.length) return records;

  return records.filter((record) => {
    const results = filter.conditions.map((cond) =>
      evaluateCondition(record, cond, fields)
    );
    return filter.logic === "and"
      ? results.every(Boolean)
      : results.some(Boolean);
  });
}

function evaluateCondition(
  record: Record,
  cond: FilterCondition,
  fields: Map<string, Field>
): boolean {
  const field = fields.get(cond.fieldId);
  if (!field) return false;

  const cellValue = record.cells[cond.fieldId];

  // isEmpty / isNotEmpty — 适用所有类型
  if (cond.operator === "isEmpty") return isEmpty(cellValue);
  if (cond.operator === "isNotEmpty") return !isEmpty(cellValue);

  switch (field.type) {
    case "DateTime":
    case "CreatedTime":
    case "ModifiedTime":
      return evaluateDateCondition(cellValue as string, cond);

    case "Number":
    case "Progress":
    case "Rating":
    case "Currency":
    case "AutoNumber":
      return evaluateNumberCondition(Number(cellValue), cond);

    case "Checkbox":
      return cond.operator === "checked"
        ? Boolean(cellValue)
        : !cellValue;

    case "MultiSelect":
      return evaluateMultiSelectCondition(cellValue as string[], cond);

    default:
      return evaluateTextCondition(String(cellValue ?? ""), cond);
  }
}
```

#### 日期筛选（相对日期解析）

```typescript
function resolveDateRange(
  value: FilterValue,
  now: Date
): { start: Date; end: Date } | null {
  const map: Record<RelativeDateValue, () => { start: Date; end: Date }> = {
    today:      () => dayRange(now),
    yesterday:  () => dayRange(addDays(now, -1)),
    tomorrow:   () => dayRange(addDays(now, 1)),
    thisWeek:   () => weekRange(now, 0),
    lastWeek:   () => weekRange(now, -1),
    thisMonth:  () => monthRange(now, 0),
    lastMonth:  () => monthRange(now, -1),
    last7Days:  () => ({ start: addDays(now, -6), end: endOfDay(now) }),
    next7Days:  () => ({ start: startOfDay(now), end: addDays(now, 6) }),
    last30Days: () => ({ start: addDays(now, -29), end: endOfDay(now) }),
    next30Days: () => ({ start: startOfDay(now), end: addDays(now, 29) }),
  };
  // 绝对日期
  if (typeof value === "string" && /^\d{4}\/\d{2}\/\d{2}$/.test(value)) {
    return dayRange(parseDate(value));
  }
  return map[value as RelativeDateValue]?.() ?? null;
}
```

**日期操作符约束**（与 Ability.md 保持一致）：

| 操作符 | 支持的日期值 |
|--------|-------------|
| `eq`（等于）| 具体日期、今天/明天/昨天、上周/本周/本月/上月、过去/未来 7/30 天内 |
| `after`（晚于）| 具体日期、今天/明天/昨天 **仅此三种** |
| `before`（早于）| 具体日期、今天/明天/昨天 **仅此三种** |

### 3.2 筛选合法性校验

在将 LLM 生成的筛选表达式写入视图前，必须通过以下校验：

```typescript
interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

interface ValidationError {
  conditionId: string;
  code: string;
  message: string;
}

function validateFilterConditions(
  conditions: FilterCondition[],
  fields: Map<string, Field>,
  tableId: string
): ValidationResult {
  const errors: ValidationError[] = [];

  // 规则1：字段必须属于当前表
  // 规则2：禁止条件冲突（同字段同操作不同值）
  // 规则3：操作符与字段类型匹配
  // 规则4：筛选值只能是常量（无变量/当前用户等）
  // 规则5：复选框只允许 checked/unchecked
  // 规则6：日期操作符约束（after/before 不能用周期值）
  // 规则7：单选 eq/neq 只允许单个选项值
  // 规则8：人员/附件字段只允许 isEmpty/isNotEmpty

  for (const cond of conditions) {
    const field = fields.get(cond.fieldId);
    if (!field) {
      errors.push({ conditionId: cond.id, code: "FIELD_NOT_FOUND",
        message: `字段 ${cond.fieldId} 不存在于当前表` });
      continue;
    }
    if (field.tableId !== tableId) {
      errors.push({ conditionId: cond.id, code: "CROSS_TABLE_FIELD",
        message: "筛选字段必须属于当前表" });
    }
    validateOperatorForField(field, cond, errors);
    validateValueForOperator(field, cond, errors);
  }

  checkConflictingConditions(conditions, fields, errors);

  return { valid: errors.length === 0, errors };
}
```

---

## 四、模型调用设计

### 4.1 API 端点

```
POST /api/ai/filter/generate
```

**Request：**
```typescript
interface FilterGenerateRequest {
  tableId: string;
  viewId?: string;              // 若有已有筛选，传入视图 ID
  query: string;                // 用户自然语言输入
  existingFilter?: ViewFilter;  // 当前已有筛选条件（追加模式时必填）
  appendMode: boolean;          // 是否为追加模式
}
```

**Response（SSE 流式）：**
```typescript
// event: thinking（可选，流式输出思考过程）
// event: result（最终筛选表达式）
// event: error（错误信息）

interface FilterGenerateResult {
  filter: ViewFilter;           // 生成的筛选表达式
  confidence: number;           // 0–1，模型置信度
  explanation: string;          // 中文解释，展示给用户
}
```

### 4.2 System Prompt 设计

```
你是多维表格的智能筛选助手。你的任务是：根据用户的自然语言描述，
结合当前数据表的字段定义，生成结构化的视图筛选表达式（JSON 格式）。

## 筛选表达式格式

{
  "logic": "and" | "or",
  "conditions": [
    {
      "id": "<随机字符串>",
      "fieldId": "<字段ID>",
      "operator": "<操作符>",
      "value": "<筛选值或null>"
    }
  ]
}

## 操作符规则（严格遵守）

| 字段类型 | 允许的操作符 |
|---------|------------|
| Text/Url/Phone/Email/Location | isEmpty, isNotEmpty, eq, neq, contains, notContains |
| SingleSelect/MultiSelect | isEmpty, isNotEmpty, eq, neq, contains, notContains |
| User/CreatedUser/ModifiedUser | isEmpty, isNotEmpty（**不支持等于当前用户**） |
| Attachment | isEmpty, isNotEmpty |
| DateTime/CreatedTime/ModifiedTime | isEmpty, isNotEmpty, eq, after, before |
| Number/Progress/Rating/Currency/AutoNumber | isEmpty, isNotEmpty, eq, neq, gt, gte, lt, lte |
| Checkbox | checked, unchecked（**仅这两个**，无 isEmpty/isNotEmpty） |
| Formula | isEmpty, isNotEmpty, eq, neq, gt, gte, lt, lte, contains, notContains |

## 日期值约束
- eq 操作符：可以使用 today/tomorrow/yesterday/thisWeek/lastWeek/
  thisMonth/lastMonth/last7Days/next7Days/last30Days/next30Days
  或具体日期（格式：yyyy/MM/dd）
- after/before 操作符：**只能使用** today/tomorrow/yesterday
  或具体日期，**不能使用**周期类值（如 thisWeek/last30Days 等）

## 约束要求
1. fieldId 必须来自「当前表字段列表」，禁止使用不存在的字段
2. value 只能是常量，禁止使用变量（如「当前用户」「今天+7天」等动态表达式）
3. 多个条件不得重复、冲突或互相排斥
4. logic 默认使用 "and"，仅当用户明确表达「或」关系时使用 "or"
5. 若用户输入的字段名不能被任何字段匹配，返回 error
6. 追加模式：在已有 existingConditions 基础上新增条件，不要删除已有条件

## 输出要求
- 只输出 JSON，不输出任何解释文字
- JSON 必须符合上述格式，key 名不得改变
```

### 4.3 User Prompt 模板

```typescript
function buildUserPrompt(req: FilterGenerateRequest): string {
  const fieldSchema = req.fields
    .map((f) => {
      const opts = "options" in f.config
        ? `，选项: [${f.config.options.map((o) => o.name).join(", ")}]`
        : "";
      return `- ${f.id}（${f.name}）: ${f.type}${opts}`;
    })
    .join("\n");

  const existingPart = req.existingFilter?.conditions.length
    ? `\n\n## 当前已有筛选条件（追加模式请保留）\n${
        JSON.stringify(req.existingFilter, null, 2)
      }`
    : "";

  return `## 当前表字段列表
${fieldSchema}
${existingPart}

## 用户输入
${req.query}

## 追加模式
${req.appendMode ? "是（在已有条件基础上新增，不删除）" : "否（替换为全新条件）"}

请生成筛选表达式 JSON：`;
}
```

### 4.4 模型调用流程

```
用户提交 Query
      │
      ▼
┌─────────────────────────────┐
│ 1. 获取表字段 Schema         │  TableSvc.getFields(tableId)
│    （含类型、选项）           │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│ 2. 获取已有筛选条件           │  ViewSvc.getFilter(viewId) [可选]
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│ 3. 构建 System + User Prompt │  buildSystemPrompt() + buildUserPrompt()
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│ 4. 调用 LLM API（流式）      │  claude-opus-4 / gpt-4o
│    max_tokens: 1024          │
│    temperature: 0            │  确保确定性输出
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│ 5. 解析 JSON 响应             │  extractJSON(llmOutput)
│    格式错误 → 重试一次        │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│ 6. 合法性校验                 │  validateFilterConditions()
│    字段存在性 / 操作符合法性   │
│    日期约束 / 冲突检测         │
└──────────────┬──────────────┘
               │
      ┌────────┴────────┐
      │ valid           │ invalid
      ▼                 ▼
 返回 filter      修正或返回错误
 到前端渲染        提示用户重新描述
```

### 4.5 错误处理与降级策略

| 场景 | 处理策略 |
|------|---------|
| LLM 返回非 JSON | 提取 JSON 块后重试一次；两次失败返回空结果 |
| 字段名匹配失败 | 使用字段名向量相似度模糊匹配，相似度 < 0.6 则返回错误提示 |
| 操作符不合法 | 校验器自动修正（如 date after thisWeek → 返回错误，提示用户使用具体日期） |
| 条件冲突 | 返回 CONFLICTING_CONDITIONS 错误，附带冲突说明 |
| LLM API 超时 | 3s 超时，返回 503，前端展示"生成超时，请重试" |
| 追加模式误删条件 | 合并时强制保留 existingConditions，仅追加新条件 |

### 4.6 调用示例

**输入：**
```
用户 Query: "近 30 天未完成的项目"
表字段: 创建时间(DateTime), 设计状态(SingleSelect: 项目完成/方案设计阶段/待排期)
追加模式: false
```

**LLM 输出：**
```json
{
  "logic": "and",
  "conditions": [
    {
      "id": "cond-1",
      "fieldId": "createdAt",
      "operator": "eq",
      "value": "last30Days"
    },
    {
      "id": "cond-2",
      "fieldId": "status",
      "operator": "neq",
      "value": "项目完成"
    }
  ]
}
```

**追加模式输入：**
```
用户 Query: "追加筛选条件：只看字段需求"
已有条件: [createdAt eq last30Days, status neq 项目完成]
追加模式: true
```

**LLM 输出（保留原条件 + 追加）：**
```json
{
  "logic": "and",
  "conditions": [
    { "id": "cond-1", "fieldId": "createdAt", "operator": "eq", "value": "last30Days" },
    { "id": "cond-2", "fieldId": "status", "operator": "neq", "value": "项目完成" },
    { "id": "cond-3", "fieldId": "title", "operator": "contains", "value": "字段" }
  ]
}
```

---

## 五、接口安全与性能

### 5.1 安全

- **字段权限**：查询时过滤无权访问的字段，LLM Schema 中不暴露用户无权访问的字段
- **输入净化**：Query 最大 500 字符，防止 Prompt Injection（检测 `ignore previous instructions` 等特征）
- **Rate Limiting**：AI 生成接口 10 req/min/user

### 5.2 性能

- **字段 Schema 缓存**：Redis 缓存 5min，表结构变更时失效
- **LLM 响应缓存**：对相同 (tableId + query hash + existingFilter hash) 的请求缓存 30s
- **流式输出**：使用 SSE 流式返回，前端实时展示生成状态，P99 首 token 延迟 < 800ms

---

## 六、前端与服务端的接口契约

```typescript
// POST /api/ai/filter/generate
// SSE 事件流

// 开始生成（前端展示"生成中"动画）
event: start
data: { "requestId": "req-xxx" }

// 可选：思考过程（展示思考文字）
event: thinking
data: { "text": "正在分析字段..." }

// 生成完成
event: result
data: {
  "filter": { "logic": "and", "conditions": [...] },
  "confidence": 0.95,
  "explanation": "已生成 2 条筛选条件：创建时间在过去 30 天内，且设计状态不为项目完成"
}

// 错误
event: error
data: {
  "code": "FIELD_NOT_FOUND" | "INVALID_OPERATOR" | "CONFLICTING_CONDITIONS" | "TIMEOUT",
  "message": "无法识别字段「xxx」，请使用表中的实际字段名"
}
```
