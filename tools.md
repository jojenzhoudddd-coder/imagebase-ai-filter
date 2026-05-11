# Funature - MCP Tools 文档

本项目的 AI 筛选功能通过 Volcano ARK Responses API 实现多轮工具调用。模型可调用以下 3 个工具获取数据表信息，辅助生成筛选条件。

---

## 1. get_table_brief_info

### 用途
获取当前数据表的字段列表、字段类型、选项配置、记录总数。当需要确认字段名、字段类型或可用选项值时调用。

### 调用场景
- 用户指令中的字段名模糊或使用拼音，需获取完整字段列表进行匹配
- 需要确认某个字段的类型（如 SingleSelect / MultiSelect / User）
- 需要获取选项字段的可选值列表

### 输入参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `table_id` | string | 是 | 数据表 ID |

### Tool Definition

```json
{
  "type": "function",
  "name": "get_table_brief_info",
  "description": "获取当前数据表的字段列表、字段类型、选项配置、记录总数。当需要确认字段名、字段类型或可用选项值时调用。",
  "parameters": {
    "type": "object",
    "properties": {
      "table_id": {
        "type": "string",
        "description": "数据表 ID"
      }
    },
    "required": ["table_id"]
  }
}
```

### 输出格式

```jsonc
{
  "tableId": "tbl_requirements",
  "tableName": "需求管理表",
  "recordCount": 100,
  "fields": [
    {
      "id": "fld_name",          // 字段 ID
      "name": "名称",            // 字段显示名称
      "type": "Text",            // 字段类型
      "isPrimary": true,         // 是否为主字段
      "options": undefined       // 仅选项字段有值
    },
    {
      "id": "fld_priority",
      "name": "优先级",
      "type": "SingleSelect",
      "isPrimary": false,
      "options": ["P0", "P1", "P2"]  // 选项字段的可选值
    },
    {
      "id": "fld_assignee",
      "name": "负责人",
      "type": "User",
      "isPrimary": false
    }
    // ...其他字段
  ]
}
```

### 输出字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `tableId` | string | 数据表 ID |
| `tableName` | string | 数据表名称 |
| `recordCount` | number | 记录总数 |
| `fields[].id` | string | 字段 ID，用于构建筛选条件 |
| `fields[].name` | string | 字段显示名称 |
| `fields[].type` | string | 字段类型，可选值见下方「支持的字段类型」 |
| `fields[].isPrimary` | boolean | 是否为主字段 |
| `fields[].options` | string[] \| undefined | 选项字段（SingleSelect / MultiSelect）的可选值列表 |

---

## 2. search_record

### 用途
在数据表中按关键词搜索记录，返回匹配的字段和记录值。

### 调用场景
- **反推字段名**：用户只给了关键词没给字段名，搜索关键词定位到具体字段
- **查找人员 ID**：人员字段需要按人名筛选时，搜索人名获取 `user_id`
- **查找关联记录 ID**：关联字段需要按值筛选时，搜索获取 `record_id`

### 输入参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `table_id` | string | 是 | 数据表 ID |
| `keyword` | string | 是 | 搜索关键词（大小写不敏感） |
| `field_id` | string | 否 | 限定搜索的字段 ID，不传则搜索所有字段 |

### Tool Definition

```json
{
  "type": "function",
  "name": "search_record",
  "description": "在数据表中按关键词搜索记录，返回匹配的字段和记录值。用于：反推字段名、查找人员 user_id、查找关联记录 record_id。",
  "parameters": {
    "type": "object",
    "properties": {
      "table_id": {
        "type": "string",
        "description": "数据表 ID"
      },
      "keyword": {
        "type": "string",
        "description": "搜索关键词"
      },
      "field_id": {
        "type": "string",
        "description": "可选，限定搜索的字段 ID"
      }
    },
    "required": ["table_id", "keyword"]
  }
}
```

### 输出格式

```jsonc
[
  {
    "fieldId": "fld_assignee",
    "fieldName": "负责人",
    "fieldType": "User",
    "matches": [
      {
        "recordId": "rec_001",                  // 记录 ID
        "value": "u_01",                        // 原始存储值（如 user_id）
        "displayValue": "陈晓明(u_01)"          // 显示值（人名+ID）
      }
    ]
  },
  {
    "fieldId": "fld_name",
    "fieldName": "名称",
    "fieldType": "Text",
    "matches": [
      {
        "recordId": "rec_042",
        "value": "支持评分字段类型",
        "displayValue": "支持评分字段类型"
      }
    ]
  }
]
```

### 输出字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `[].fieldId` | string | 匹配到的字段 ID |
| `[].fieldName` | string | 字段显示名称 |
| `[].fieldType` | string | 字段类型 |
| `[].matches[].recordId` | string | 匹配记录的 ID |
| `[].matches[].value` | CellValue | 单元格原始值（string / number / boolean / string[] / object） |
| `[].matches[].displayValue` | string | 格式化后的显示值（User 类型显示为 `姓名(user_id)`，日期显示为 `yyyy-MM-dd`） |

### 搜索行为
- 关键词大小写不敏感
- 按 `displayValue` 去重，同一字段中相同显示值只返回一条
- 每个字段最多返回 20 条匹配结果
- User 类型字段的 `displayValue` 格式为 `姓名(user_id)`，可从中提取 ID
- 如果指定了 `field_id`，仅搜索该字段；否则搜索所有字段

---

## 3. get_view_filter

### 用途
获取当前视图已有的筛选表达式 JSON。当判断为追加筛选时，用于获取现有条件。

### 调用场景
- 用户说"再加一个条件"、"还要筛选 XX"等追加筛选指令时
- 需要在现有筛选基础上叠加新条件

### 输入参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `table_id` | string | 是 | 数据表 ID |

### Tool Definition

```json
{
  "type": "function",
  "name": "get_view_filter",
  "description": "获取当前视图已有的筛选表达式 JSON。当判断为追加筛选时，用于获取现有条件。",
  "parameters": {
    "type": "object",
    "properties": {
      "table_id": {
        "type": "string",
        "description": "数据表 ID"
      }
    },
    "required": ["table_id"]
  }
}
```

### 输出格式

返回 PRD 格式的筛选表达式，条件为 `["字段名", "操作符", 值]` 的 tuple 数组：

```jsonc
{
  "logic": "and",              // 逻辑关系："and" 或 "or"
  "conditions": [
    ["优先级", "==", "P0"],     // [字段名, 操作符, 值]
    ["创建时间", ">", "Past30Days"]
  ]
}
```

**无筛选时返回：**

```json
{
  "logic": "and",
  "conditions": []
}
```

### 输出字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `logic` | `"and"` \| `"or"` | 条件间的逻辑关系 |
| `conditions` | `[string, string, unknown][]` | 筛选条件的 tuple 数组 |
| `conditions[][0]` | string | 字段名称（非 ID） |
| `conditions[][1]` | string | PRD 格式操作符（见下方操作符映射表） |
| `conditions[][2]` | unknown | 筛选值（字符串/数字/布尔值/null/日期关键词） |

### PRD 操作符映射表

| PRD 操作符 | 含义 | 适用字段类型 |
|-----------|------|-------------|
| `==` | 等于 | 所有类型 |
| `!=` | 不等于 | 所有类型 |
| `>` | 大于 / 晚于 | Number, DateTime |
| `>=` | 大于等于 / 不早于 | Number, DateTime |
| `<` | 小于 / 早于 | Number, DateTime |
| `<=` | 小于等于 / 不晚于 | Number, DateTime |
| `intersects` | 包含 | Text, SingleSelect, MultiSelect, User |
| `disjoint` | 不包含 | Text, SingleSelect, MultiSelect, User |
| `empty` | 为空 | 所有类型（值为 null） |
| `non_empty` | 不为空 | 所有类型（值为 null） |

### 日期值关键词

| 关键词 | 含义 |
|--------|------|
| `Today` | 今天 |
| `Tomorrow` | 明天 |
| `Yesterday` | 昨天 |
| `ThisWeek` | 本周 |
| `LastWeek` | 上周 |
| `ThisMonth` | 本月 |
| `LastMonth` | 上月 |
| `Past7Days` | 过去 7 天 |
| `Next7Days` | 未来 7 天 |
| `Past30Days` | 过去 30 天 |
| `Next30Days` | 未来 30 天 |
| `ExactDate(yyyy-MM-dd)` | 精确日期，如 `ExactDate(2026-01-15)` |

---

## 支持的字段类型

| 类型标识 | 说明 | 支持的操作符 |
|---------|------|-------------|
| `Text` | 文本 | ==, !=, intersects, disjoint, empty, non_empty |
| `Number` | 数字 | ==, !=, >, >=, <, <=, empty, non_empty |
| `SingleSelect` | 单选 | ==, !=, intersects, disjoint, empty, non_empty |
| `MultiSelect` | 多选 | intersects, disjoint, ==, !=, empty, non_empty |
| `DateTime` | 日期时间 | ==, !=, >, >=, <, <=, empty, non_empty |
| `User` | 人员 | ==, !=, intersects, disjoint, empty, non_empty |
| `Checkbox` | 复选框 | ==（值为 true/false） |
| `AutoNumber` | 自动编号 | 同 Number |
| `CreatedTime` | 创建时间 | 同 DateTime |
| `ModifiedTime` | 修改时间 | 同 DateTime |
| `CreatedUser` | 创建人 | 同 User |
| `ModifiedUser` | 修改人 | 同 User |

---

## 工具调用流程示例

### 示例 1：简单筛选（无需工具调用）
```
用户: "只看 P0 的需求"
模型: 直接输出 → {"logic":"and","conditions":[["优先级","==","P0"]]}
```

### 示例 2：人员筛选（需 search_record）
```
用户: "找张宇航负责的"
模型: 调用 search_record(table_id, "张宇航")
      → 返回 [{"fieldId":"fld_assignee","matches":[{"value":"u_03","displayValue":"张宇航(u_03)"}]}]
模型: 输出 → {"logic":"and","conditions":[["负责人","==","u_03"]]}
```

### 示例 3：追加筛选（需 get_view_filter）
```
用户: "再加一个条件，只看最近 30 天创建的"
模型: 调用 get_view_filter(table_id)
      → 返回 {"logic":"and","conditions":[["优先级","==","P0"]]}
模型: 输出 → {"logic":"and","conditions":[["优先级","==","P0"],["创建时间",">=","Past30Days"]]}
```

### 示例 4：字段名模糊（需 get_table_brief_info）
```
用户: "按 youxianji 筛选 P1"
模型: 调用 get_table_brief_info(table_id)
      → 返回字段列表，拼音匹配 "youxianji" → "优先级"
模型: 输出 → {"logic":"and","conditions":[["优先级","==","P1"]]}
```

---

## 实现文件索引

| 文件 | 内容 |
|------|------|
| `backend/src/services/aiService.ts:485-539` | Tool Definitions（工具定义） |
| `backend/src/services/aiService.ts:544-577` | executeTool（工具执行逻辑） |
| `backend/src/services/dataStore.ts:386-476` | getTableBriefInfo / searchRecord（数据查询实现） |
| `backend/src/services/aiService.ts:756-855` | convertInternalToPRD（内部格式→PRD 格式转换） |
