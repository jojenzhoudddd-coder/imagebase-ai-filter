import { Field, FilterCondition, FilterGenerateRequest, FilterOperator, ViewFilter, CellValue } from "../types.js";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import path from "path";
import * as store from "./dbStore.js";

const ARK_BASE_URL = process.env.ARK_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3";
const ARK_MODEL = process.env.ARK_MODEL || "ep-20260412192731-vwdh7";

// ─── AI Log ───
const LOG_DIR = path.resolve("logs");
const LOG_FILE = path.join(LOG_DIR, "AI 日志.log");

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

function getGMT8Timestamp(): string {
  const now = new Date();
  const gmt8 = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return gmt8.toISOString().replace("Z", "+08:00");
}

function logAI(entry: Record<string, unknown>) {
  ensureLogDir();
  const timestamp = getGMT8Timestamp();
  const line = JSON.stringify({ timestamp, ...entry }, null, 2) + "\n---\n";
  fs.appendFileSync(LOG_FILE, line, "utf-8");
}

// ─── System Prompt (from Prompt/AI Filter PE.md, excluding user template) ───

const SYSTEM_PROMPT = `# 角色
你是多维表格的智能筛选助手。你的任务是：将用户的自然语言指令转化为一个合法的筛选表达式 JSON。后端会将此 JSON 直接用于生成底层数据结构，前端据此渲染筛选回显。JSON 正确 = 筛选生效，JSON 错误 = 链路失败。


# 输出约束（最高优先级）

1. 你的最终输出有且只有一个完整的筛选表达式 JSON，不包含任何其他内容（无解释、无确认、无 Markdown、无自然语言）。
2. 每次输出的 JSON 都是完整的筛选配置，直接覆盖当前视图的筛选状态。
3. 当用户指令与筛选完全无关（闲聊、导出、写邮件等）时，输出空条件 JSON。
4. 在输出最终 JSON 之前，你可以调用工具获取必要信息（见「多轮工具调用策略」），但最终输出必须且只能是 JSON。
5. 最终 JSON 之后不得追加任何文字。


# 筛选表达式 JSON 格式定义

## 顶层结构

> {
>   "logic": "and" 或 "or",
>   "conditions": [
>     [field, operator, value],
>     ...
>   ]
> }

- logic：多条件逻辑关系，"and" 或 "or"，默认 "and"
- conditions：筛选条件数组，每个条件是一个长度为 3 的元组
- 每次输出都是完整配置，直接替换当前视图的筛选状态

空条件 JSON：

> {"logic":"and","conditions":[]}


## 条件元组 [field, operator, value]

### field（第 1 位）
- 类型：string
- 说明：数据表中的字段 id 或字段名，必须与数据结构完全匹配

### operator（第 2 位）
- 类型：string
- 枚举值（严格使用以下字面量）：

> ==          等于        自然语言：等于 / 是 / 为 / 只看
> !=          不等于      自然语言：不等于 / 不是 / 排除
> >           大于/晚于   自然语言：大于 / 超过 / 高于 / 晚于 / 之后
> >=          大于等于    自然语言：不低于 / 至少 / 晚于或等于
> <           小于/早于   自然语言：小于 / 低于 / 不到 / 早于 / 之前
> <=          小于等于    自然语言：不超过 / 最多 / 早于或等于
> intersects  包含        自然语言：包含 / 含有 / 有
> disjoint    不包含      自然语言：不包含 / 没有（某选项）
> empty       为空        自然语言：为空 / 没填 / 缺少
> non_empty   不为空      自然语言：不为空 / 有值 / 填了

### value（第 3 位）
operator 为 empty / non_empty 时，value 传 null。其余情况 value 类型取决于字段类型：

> 字段类型                          value 类型              示例
> ─────────────────────────────────────────────────────────────────────
> 文本/公式/地理位置                 string                 "张三"
> 数字/自动编号/进度/货币/评分       number                 5000（"50万"->500000）
> 单选/多选/分类/智能标签            string[]（选项名）      ["进行中"] 或 ["P0","P1"]
> 日期/创建时间/最后更新时间         string                 见下方「日期值规则」
> 复选框                            boolean                true / false
> 人员/创建人/修改人                 object[]               [{"id":"user_xxx"}]
> 单向关联/双向关联                  object[]               [{"id":"rec_xxx"}]

value 刚性约束：
- 只能是常量，禁止变量（"当前用户""我的配额"等）
- 选项类 value 必须是已存在的选项名
- 人员/关联字段的 id 必须通过工具查询获得，禁止编造

### 日期值规则

日期字段支持全部 operator 与全部 time range value 的完整排列组合。

可用的 time range value（字面量）：

> 绝对日期：ExactDate(yyyy-MM-dd)    如 "ExactDate(2025-04-13)"
> 相对日期：Today / Tomorrow / Yesterday
> 时间段：  ThisWeek / LastWeek / ThisMonth / LastMonth / Past7Days / Next7Days / Past30Days / Next30Days

可用的 operator：

> ==    等于          语义：在该时间范围内部
> !=    不等于        语义：不在该时间范围内部
> >     晚于          语义：晚于该时间范围的结尾
> >=    晚于或等于    语义：晚于或等于该时间范围的开头
> <     早于          语义：早于该时间范围的开头
> <=    早于或等于    语义：早于或等于该时间范围的结尾
> empty               为空（value = null）
> non_empty            不为空（value = null）

以上 6 个比较运算符（== != > >= < <=）与全部 time range value 的任意组合均合法。

operator 对时间段的逻辑含义：

> 以"本周"为例（假设本周为 4/7 ~ 4/13）：
> - == ThisWeek     表示日期在 4/7 ~ 4/13 之间（含两端）
> - != ThisWeek     表示日期不在 4/7 ~ 4/13 之间
> - >  ThisWeek     表示日期晚于 4/13（即 4/14 及之后）
> - >= ThisWeek     表示日期晚于或等于 4/7（即 4/7 及之后）
> - <  ThisWeek     表示日期早于 4/7（即 4/6 及之前）
> - <= ThisWeek     表示日期早于或等于 4/13（即 4/13 及之前）

禁止的组合：

> - == + Today+X 或任何偏移表达式（如"今天加3天"）


# 中文拼音联想规则

用户可能使用拼音（全拼或拼音首字母缩写）来表达字段名、运算符、筛选值或时间词。你必须将拼音识别并还原为对应的中文，再按正常流程处理。

## 识别范围

拼音联想应用于以下三类内容：

1. 字段名拼音：用户用拼音指代字段名
2. 筛选值拼音：用户用拼音指代选项值、文本值
3. 时间词 / 运算符拼音：用户用拼音指代时间范围或运算符

## 匹配策略

> 优先级从高到低：
> 1. 全拼精确匹配：将用户输入的拼音与数据结构中所有字段名、选项值的拼音逐一比对，取完全匹配者
> 2. 拼音首字母缩写匹配：将用户输入视为每个汉字拼音的首字母缩写（如 "ddjg" -> "订单金额"），在字段名和选项值中查找首字母序列完全匹配者
> 3. 拼音前缀匹配：用户输入的拼音是某个字段名/选项值全拼的前缀（如 "dingdan" 匹配 "订单金额" 和 "订单状态"）
> 4. 内置时间词和运算符拼音：见下方映射表

当拼音匹配到多个候选时，结合上下文（用户指令中其他词语、字段类型、运算符等）选择最合理的一个。若仍无法消歧，优先选择字段名匹配。

## 内置拼音映射表

### 时间词拼音

> 拼音                    中文          对应 value
> ──────────────────────────────────────────────
> jintian / jt            今天          Today
> mingtian / mt           明天          Tomorrow
> zuotian / zt            昨天          Yesterday
> benzhou / bz            本周          ThisWeek
> shangzhou / sz          上周          LastWeek
> benyue / by             本月          ThisMonth
> shangyue / sy           上月          LastMonth
> guoqu7tian / gq7t       过去七天      Past7Days
> weilai7tian / wl7t      未来七天      Next7Days
> guoqu30tian / gq30t     过去30天      Past30Days
> weilai30tian / wl30t    未来30天      Next30Days

### 运算符拼音

> 拼音                    中文          对应 operator
> ──────────────────────────────────────────────
> dengyu / dy             等于          ==
> budengyu / bdy          不等于        !=
> dayu / dy               大于          >
> dayudengyu / dydy       大于等于      >=
> xiaoyu / xy             小于          <
> xiaoyudengyu / xydy     小于等于      <=
> baohan / bh             包含          intersects
> bubaohan / bbh          不包含        disjoint
> weikong / wk            为空          empty
> buweikong / bwk         不为空        non_empty
> wanyu / wy              晚于          >
> zaoyu / zy              早于          <

注意："dy" 可能匹配"等于"或"大于"，需根据上下文消歧：
- 后接数值 -> 大于（>）
- 后接选项值/文本 -> 等于（==）
- 无法判断时 -> 等于（==）

### 字段名和选项值拼音
字段名和选项值的拼音不在此处穷举，而是动态匹配：将用户输入的拼音与「数据结构」中当前表的字段名和选项值逐一比对。

## 混合输入
用户可能混合使用中文和拼音（如"shaixuan zhuangtai 等于 yiwancheng"），你应逐词判断是中文还是拼音，分别处理后组合。


# 视图筛选能力定义

## 文本类字段
适用于：文本、超链接、电话号码、Email、地理位置、条码、总结、翻译、信息提取
- empty / non_empty（value = null）
- == / != / intersects / disjoint（value = string）

## 选项类字段
适用于：单选、多选、分类、智能标签
- empty / non_empty（value = null）
- == / != / intersects / disjoint（value = string[]）
- 单选 == / != 时数组仅 1 元素，intersects / disjoint 可多元素
- 多选所有运算符均可多元素
- 选项不存在于字段配置中则禁止使用

## 数值类字段
适用于：数字、自动编号、进度、货币、评分
- empty / non_empty（value = null）
- == / != / > / >= / < / <=（value = number）

## 日期类字段
适用于：日期、创建时间、最后更新时间
- 完整规则见上方「日期值规则」章节

## 复选框字段
- 仅支持 ==，value 为 true 或 false
- 不支持其他运算符
- 转换规则：用户说"为空" -> == false；用户说"不为空" -> == true

## 人员类字段（人员、创建人、修改人）
- empty / non_empty（value = null）
- == / != / intersects / disjoint（value = [{"id":"user_id"}]）
- user_id 必须通过 search_record 获取，禁止凭人名编造 id
- 若无法获取 id -> 仅使用 empty / non_empty

## 附件字段
- 仅支持 empty / non_empty（value = null）

## 公式字段
- empty / non_empty（value = null）
- == / != / > / >= / < / <= / intersects / disjoint

## 关联字段（单向关联、双向关联）
- empty / non_empty（value = null）
- == / != / intersects / disjoint（value = [{"id":"record_id"}]）
- record_id 必须通过工具查询关联目标表获得，禁止编造
- 仅能比较关联目标表的索引列

## 引用类字段（查找引用、自定义 AI 自动填充）
- 筛选规则继承所引用字段的类型


# 可用工具

> 工具                     用途                                            调用时机
> ───────────────────────────────────────────────────────────────────────────────────────────
> get_table_brief_info     获取当前表的字段列表、类型、选项配置              需要确认字段名/类型/可用选项值时
> search_record            在当前表或关联表中按关键词搜索记录                反推字段、查找人员 id、查找关联记录 id 时
> get_view_filter          获取当前视图已有的筛选表达式 JSON                判断为追加筛选时，用于获取现有条件


# 多轮工具调用策略

核心原则：耗时最短。能单轮完成就不要多轮。按复杂度渐进式展开。

## 判断路径

> 用户指令
>   |
>   +-- 与筛选无关 ---------------------> 直接输出空 JSON（0 轮工具调用）
>   |
>   +-- 新筛选意图
>   |   +-- 字段名明确 + 无需 id 查询 --> 直接输出 JSON（0 轮）
>   |   +-- 需要 id 查询 --------------> search_record -> 输出 JSON（1 轮）
>   |   +-- 字段名模糊/拼音 -----------> get_table_brief_info -> 拼音匹配 -> 可能再 search_record -> 输出 JSON（1-2 轮）
>   |
>   +-- 追加筛选意图
>       +-- 调用 get_view_filter 获取现有筛选
>           +-- 在现有 conditions 基础上追加新条件
>           +-- 可能还需 get_table_brief_info / search_record
>           +-- 输出包含新旧条件的完整 JSON（1-3 轮）

## 多轮调用规则
1. 每轮工具调用必须有明确目的，禁止探索性调用
2. 单次调用能解决的问题禁止拆分为多次
3. 工具调用结果不输出给用户，仅用于内部推理
4. 追加筛选时，必须先调用 get_view_filter 获取现有筛选，再将新条件追加到已有 conditions 中
5. 拼音消歧困难时，调用 get_table_brief_info 获取完整字段列表辅助匹配
6. 所有工具调用完成后，最终输出有且只有一个完整 JSON


# 工作流程

## 第 1 步：意图分类

快速判断用户指令属于以下哪类：
- 无关指令 -> 直接输出 {"logic":"and","conditions":[]}，流程结束
- 筛选指令 -> 继续第 2 步

## 第 2 步：判断新筛选 vs 追加筛选

追加筛选触发词（出现任一即判定为追加）：
- 显式："追加筛选""增加筛选""增加条件""添加条件"
- 递进："在当前基础上""在现有筛选上""在这基础上""进一步筛选""进一步缩小范围""继续筛选"
- 口语："再筛选""再看看""还要加上""另外还要"
- 拼音："zhuijia shaixuan""zai shaixuan""jinyibu shaixuan"

不属于追加：
- 仅含"再"/"zai"但无筛选语义
- 无追加词的独立筛选指令

若判定为追加筛选 -> 立即调用 get_view_filter 获取当前视图的筛选表达式。
无法判断时 -> 按新筛选处理。

## 第 3 步：拼音识别与还原

对用户指令中的每个词/片段，判断是中文还是拼音：
- 纯拉丁字母且非英文常见词 -> 视为拼音，按「中文拼音联想规则」还原
- 中文 -> 直接使用
- 混合 -> 逐词分别处理

拼音还原后，用户指令变为等效的中文指令，后续按正常流程处理。

若拼音无法匹配任何字段名/选项值/时间词 -> 调用 get_table_brief_info 获取完整字段列表再次匹配。

## 第 4 步：判断是否需要更多工具调用

> 场景                                          调用什么
> ───────────────────────────────────────────────────────────────────────
> 字段名无法匹配 / 需确认字段类型和选项值         get_table_brief_info
> 用户只给了关键词没给字段名                      search_record（搜索关键词定位字段）
> 人员字段需要按人名筛选                          search_record（搜索人名获取 user_id）
> 关联字段需要按值筛选                            search_record（在关联目标表中搜索获取 record_id）

## 第 5 步：生成筛选表达式

### 5.1 字段匹配
1. 精确匹配（中文） -> 直接使用
2. 拼音匹配 -> 还原为中文后使用
3. 近义词/简称 -> 语义匹配最接近的字段
4. 值反推 -> 已通过 search_record 定位到字段
5. 仍无法匹配 -> 该条件丢弃

### 5.2 运算符确定
- 用户明说了（中文或拼音） -> 校验是否被字段类型支持，不支持则转换
- 用户没说 -> 语义推理
- 复选框特殊转换："为空"/"weikong" -> == false，"不为空"/"buweikong" -> == true
- 日期时间段语义转换同前

### 5.3 筛选值格式化
- 选项 -> 包装为 string[]（拼音先还原为中文选项名）
- 数值 -> 转为 number
- 日期 -> 转为合法字面量（拼音时间词先还原，如 "benyue" -> ThisMonth）
- 其余同前

### 5.4 合法性校验
- 同前，额外要求：拼音还原后的中文必须在数据表中存在

### 5.5 组装并输出
- 新筛选 -> 直接输出新条件组装的完整 JSON
- 追加筛选 -> 将新条件追加到 get_view_filter 返回的已有 conditions 末尾

> {"logic":"and","conditions":[[原有条件1],[新增条件1],...]}

所有条件被丢弃时输出：

> {"logic":"and","conditions":[]}


# Few-shot 示例

数据表：订单管理表
字段：
- 订单编号（自动编号）
- 客户名称（文本）
- 订单状态（单选，选项：待确认 / 已确认 / 生产中 / 已发货 / 已完成 / 已取消）
- 产品分类（多选，选项：电子产品 / 家居用品 / 食品饮料 / 服装鞋帽 / 办公用品）
- 订单金额（货币）
- 下单日期（日期）
- 交货日期（日期）
- 销售负责人（人员）
- 是否加急（复选框）
- 合同附件（附件）
- 关联客户（单向关联 -> 客户表）
- 备注（文本）


## 示例 1：新筛选 - 直接生成（0 轮）

用户指令：筛选订单金额大于10000的记录

> {"logic":"and","conditions":[["订单金额",">",10000]]}


## 示例 2：拼音全拼 - 字段名 + 选项值（0 轮）

用户指令：shaixuan dingdanzhuangtai dengyu yiwancheng

分析：
- "shaixuan" -> 筛选（指令词）
- "dingdanzhuangtai" -> 全拼匹配字段"订单状态"
- "dengyu" -> 等于 -> ==
- "yiwancheng" -> 全拼匹配选项"已完成"

> {"logic":"and","conditions":[["订单状态","==",["已完成"]]]}


## 示例 3：拼音首字母缩写（0-1 轮）

用户指令：ddje dayu 5000

分析：
- "ddje" -> 首字母缩写，匹配字段"订单金额"（d=订 d=单 j=金 e=额）
- "dayu" -> 大于 -> >
- 5000 -> 数值

> {"logic":"and","conditions":[["订单金额",">",5000]]}


## 示例 4：中文拼音混合 + 时间词拼音（0 轮）

用户指令：下单日期 zaoyu shangzhou

分析：
- "下单日期" -> 中文，直接匹配
- "zaoyu" -> 早于 -> <
- "shangzhou" -> 上周 -> LastWeek

> {"logic":"and","conditions":[["下单日期","<","LastWeek"]]}


## 示例 5：追加筛选 + 拼音（1 轮）

用户指令：zai zhe jichu shang zhi kan jiaji de

工具调用：get_view_filter -> 返回当前筛选：
{"logic":"and","conditions":[["订单金额",">",10000]]}

分析：
- "zai zhe jichu shang" -> "在这基础上" -> 追加筛选
- "zhi kan" -> "只看" -> ==
- "jiaji de" -> "加急的" -> "是否加急" == true

> {"logic":"and","conditions":[["订单金额",">",10000],["是否加急","==",true]]}


## 示例 6：人员字段（1 轮）

用户指令：筛选销售负责人是张伟的订单
工具调用：search_record("张伟") -> 获取 user_id = "user_a1b2c3"

> {"logic":"and","conditions":[["销售负责人","==",[{"id":"user_a1b2c3"}]]]}


## 示例 7：关联字段（2 轮）

用户指令：筛选关联客户是"星辰科技"的订单
工具调用 1：get_table_brief_info -> 确认关联到客户表
工具调用 2：search_record("星辰科技") -> 获取 record_id = "rec_x7y8z9"

> {"logic":"and","conditions":[["关联客户","==",[{"id":"rec_x7y8z9"}]]]}


## 示例 8：不相关指令

用户指令：帮我写一封邮件给客户

> {"logic":"and","conditions":[]}`;


// ─── Tool definitions for Responses API ───

const TOOL_DEFINITIONS = [
  {
    type: "function" as const,
    name: "get_table_brief_info",
    description: "获取当前数据表的字段列表、字段类型、选项配置、记录总数。当需要确认字段名、字段类型或可用选项值时调用。",
    parameters: {
      type: "object",
      properties: {
        table_id: {
          type: "string",
          description: "数据表 ID",
        },
      },
      required: ["table_id"],
    },
  },
  {
    type: "function" as const,
    name: "search_record",
    description: "在数据表中按关键词搜索记录，返回匹配的字段和记录值。用于：反推字段名、查找人员 user_id、查找关联记录 record_id。",
    parameters: {
      type: "object",
      properties: {
        table_id: {
          type: "string",
          description: "数据表 ID",
        },
        keyword: {
          type: "string",
          description: "搜索关键词",
        },
        field_id: {
          type: "string",
          description: "可选，限定搜索的字段 ID",
        },
      },
      required: ["table_id", "keyword"],
    },
  },
  {
    type: "function" as const,
    name: "get_view_filter",
    description: "获取当前视图已有的筛选表达式 JSON。当判断为追加筛选时，用于获取现有条件。",
    parameters: {
      type: "object",
      properties: {
        table_id: {
          type: "string",
          description: "数据表 ID",
        },
      },
      required: ["table_id"],
    },
  },
];


// ─── Execute a tool call ───

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  existingFilter?: ViewFilter,
  fields?: Field[]
): Promise<string> {
  try {
    if (name === "get_table_brief_info") {
      const tableId = String(args.table_id || "");
      const info = await store.getTableBriefInfo(tableId);
      if (!info) return JSON.stringify({ error: "表不存在" });
      return JSON.stringify(info);
    }
    if (name === "search_record") {
      const tableId = String(args.table_id || "");
      const keyword = String(args.keyword || "");
      const fieldId = args.field_id ? String(args.field_id) : undefined;
      const results = await store.searchRecord(tableId, keyword, fieldId);
      return JSON.stringify(results);
    }
    if (name === "get_view_filter") {
      if (!existingFilter || existingFilter.conditions.length === 0) {
        return JSON.stringify({ logic: "and", conditions: [] });
      }
      if (fields) {
        return JSON.stringify(convertInternalToPRD(existingFilter, fields));
      }
      return JSON.stringify({ logic: "and", conditions: [] });
    }
    return JSON.stringify({ error: `未知工具: ${name}` });
  } catch (err) {
    return JSON.stringify({ error: String(err) });
  }
}


// ─── Build user prompt with table schema ───

function buildUserPrompt(req: FilterGenerateRequest, fields: Field[]): string {
  const fieldSchema = fields
    .map((f) => {
      let desc = `- ${f.id}（${f.name}）: ${f.type}`;
      if (f.config.options) {
        desc += `，选项: [${f.config.options.map((o) => o.name).join(", ")}]`;
      }
      if (f.config.users) {
        desc += `，人员: [${f.config.users.map((u) => `${u.name}(${u.id})`).join(", ")}]`;
      }
      return desc;
    })
    .join("\n");

  // Convert existing filter to PRD format for the model
  let filterConfig: string;
  if (req.existingFilter && req.existingFilter.conditions.length > 0) {
    const prdFilter = convertInternalToPRD(req.existingFilter, fields);
    filterConfig = JSON.stringify(prdFilter, null, 2);
  } else {
    filterConfig = '{"logic":"and","conditions":[]}';
  }

  return `# 用户指令
${req.query}

# 当前筛选
${filterConfig}

# 数据结构
table_id: ${req.tableId}
${fieldSchema}`;
}


// ─── PRD format → Internal format converter ───

interface PRDFilterOutput {
  logic: "and" | "or";
  conditions: [string, string, unknown][];
}

const PRD_OP_MAP: Record<string, FilterOperator> = {
  "==": "eq",
  "!=": "neq",
  ">": "gt",
  ">=": "gte",
  "<": "lt",
  "<=": "lte",
  "intersects": "contains",
  "disjoint": "notContains",
  "empty": "isEmpty",
  "non_empty": "isNotEmpty",
};

const PRD_DATE_OP_MAP: Record<string, FilterOperator> = {
  "==": "eq",
  "!=": "neq",
  ">": "after",
  ">=": "gte",
  "<": "before",
  "<=": "lte",
  "empty": "isEmpty",
  "non_empty": "isNotEmpty",
};

const PRD_DATE_VALUE_MAP: Record<string, string> = {
  "Today": "today",
  "Tomorrow": "tomorrow",
  "Yesterday": "yesterday",
  "ThisWeek": "thisWeek",
  "LastWeek": "lastWeek",
  "ThisMonth": "thisMonth",
  "LastMonth": "lastMonth",
  "Past7Days": "last7Days",
  "Next7Days": "next7Days",
  "Past30Days": "last30Days",
  "Next30Days": "next30Days",
};

const DATE_TYPES = new Set(["DateTime", "CreatedTime", "ModifiedTime"]);
const SELECT_TYPES = new Set(["SingleSelect", "MultiSelect", "ai_classify", "ai_tag"]);

function convertPRDToInternal(prd: PRDFilterOutput, fields: Field[]): ViewFilter {
  const fieldMap = new Map<string, Field>();
  for (const f of fields) {
    fieldMap.set(f.id, f);
    fieldMap.set(f.name, f);
  }

  const conditions: FilterCondition[] = [];

  // Normalize condition: accept both tuple [field, op, value] and object {field, operator, value}
  function normalizeTuples(rawConditions: unknown[]): [string, string, unknown][] {
    const result: [string, string, unknown][] = [];
    for (const item of rawConditions) {
      if (Array.isArray(item) && item.length >= 3) {
        result.push(item as [string, string, unknown]);
      } else if (item && typeof item === "object" && !Array.isArray(item)) {
        const obj = item as Record<string, unknown>;
        // Handle object format: {field, operator, value}
        if (obj.field && obj.operator) {
          result.push([String(obj.field), String(obj.operator), obj.value]);
        }
        // Handle nested group: {logic, conditions} — flatten into parent
        if (obj.conditions && Array.isArray(obj.conditions)) {
          result.push(...normalizeTuples(obj.conditions));
        }
      }
    }
    return result;
  }

  const normalizedConditions = normalizeTuples(prd.conditions);

  for (const tuple of normalizedConditions) {
    const [fieldRef, prdOp, rawValue] = tuple;

    const field = fieldMap.get(String(fieldRef));
    if (!field) continue;

    const isDateField = DATE_TYPES.has(field.type);
    const isSelectField = SELECT_TYPES.has(field.type);

    const opMap = isDateField ? PRD_DATE_OP_MAP : PRD_OP_MAP;
    const operator = opMap[String(prdOp)] ?? PRD_OP_MAP[String(prdOp)];
    if (!operator) continue;

    if (field.type === "Checkbox") {
      conditions.push({
        id: uuidv4(),
        fieldId: field.id,
        operator: "eq",
        value: rawValue === true ? "true" : "false",
      });
      continue;
    }

    let value: CellValue = rawValue as CellValue;

    if (operator === "isEmpty" || operator === "isNotEmpty") {
      value = null;
    } else if (isDateField && typeof rawValue === "string") {
      if (rawValue in PRD_DATE_VALUE_MAP) {
        value = PRD_DATE_VALUE_MAP[rawValue];
      } else {
        const exactMatch = rawValue.match(/^ExactDate\((\d{4})-(\d{2})-(\d{2})\)$/);
        if (exactMatch) {
          value = `${exactMatch[1]}/${exactMatch[2]}/${exactMatch[3]}`;
        }
      }
    } else if (isSelectField && Array.isArray(rawValue)) {
      if (field.type === "SingleSelect" || field.type === "ai_classify") {
        value = rawValue.length === 1 ? (rawValue[0] as string) : (rawValue[0] as string);
      } else {
        value = rawValue.length === 1 ? (rawValue[0] as string) : rawValue as unknown as CellValue;
      }
    }

    conditions.push({
      id: uuidv4(),
      fieldId: field.id,
      operator,
      value,
    });
  }

  return {
    logic: prd.logic || "and",
    conditions,
  };
}


// ─── Internal format → PRD format converter (for get_view_filter and user prompt) ───

const INTERNAL_OP_TO_PRD: Record<string, string> = {
  eq: "==",
  neq: "!=",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
  contains: "intersects",
  notContains: "disjoint",
  isEmpty: "empty",
  isNotEmpty: "non_empty",
  after: ">",
  before: "<",
  checked: "==",
  unchecked: "==",
};

const INTERNAL_DATE_VALUE_TO_PRD: Record<string, string> = {
  today: "Today",
  tomorrow: "Tomorrow",
  yesterday: "Yesterday",
  thisWeek: "ThisWeek",
  lastWeek: "LastWeek",
  thisMonth: "ThisMonth",
  lastMonth: "LastMonth",
  last7Days: "Past7Days",
  next7Days: "Next7Days",
  last30Days: "Past30Days",
  next30Days: "Next30Days",
};

function convertInternalToPRD(filter: ViewFilter, fields: Field[]): PRDFilterOutput {
  const fieldMap = new Map<string, Field>();
  for (const f of fields) {
    fieldMap.set(f.id, f);
  }

  const conditions: [string, string, unknown][] = [];

  for (const cond of filter.conditions) {
    const field = fieldMap.get(cond.fieldId);
    if (!field) continue;

    const fieldRef = field.name;

    // Handle Checkbox
    if (field.type === "Checkbox") {
      if (cond.operator === "checked") {
        conditions.push([fieldRef, "==", true]);
      } else if (cond.operator === "unchecked") {
        conditions.push([fieldRef, "==", false]);
      } else {
        // eq operator with string "true"/"false"
        conditions.push([fieldRef, "==", cond.value === "true" || cond.value === true]);
      }
      continue;
    }

    // Handle empty/non_empty
    if (cond.operator === "isEmpty" || cond.operator === "isNotEmpty") {
      const prdOp = INTERNAL_OP_TO_PRD[cond.operator]!;
      conditions.push([fieldRef, prdOp, null]);
      continue;
    }

    const prdOp = INTERNAL_OP_TO_PRD[cond.operator] || "==";

    // Handle date values
    if (DATE_TYPES.has(field.type) && typeof cond.value === "string") {
      const prdDateValue = INTERNAL_DATE_VALUE_TO_PRD[cond.value];
      if (prdDateValue) {
        conditions.push([fieldRef, prdOp, prdDateValue]);
      } else if (cond.value.match(/^\d{4}\/\d{2}\/\d{2}$/)) {
        const [y, m, d] = cond.value.split("/");
        conditions.push([fieldRef, prdOp, `ExactDate(${y}-${m}-${d})`]);
      } else {
        conditions.push([fieldRef, prdOp, cond.value]);
      }
      continue;
    }

    // Handle select fields - wrap single value in array
    if (SELECT_TYPES.has(field.type) && cond.value != null &&
        (prdOp === "==" || prdOp === "!=" || prdOp === "intersects" || prdOp === "disjoint")) {
      const val = Array.isArray(cond.value) ? cond.value : [cond.value];
      conditions.push([fieldRef, prdOp, val]);
      continue;
    }

    conditions.push([fieldRef, prdOp, cond.value]);
  }

  return {
    logic: filter.logic || "and",
    conditions,
  };
}


// ─── Extract JSON from model output ───

function extractPRDJSON(text: string): PRDFilterOutput | null {
  try {
    return JSON.parse(text.trim()) as PRDFilterOutput;
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]) as PRDFilterOutput;
      } catch {
        return null;
      }
    }
    return null;
  }
}


// ─── Call Responses API (non-streaming, for tool loop rounds) ───

interface ResponsesAPIResult {
  output: Array<{
    type: string;
    // function_call fields
    id?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
    // text fields
    text?: string;
    content?: Array<{ type: string; text?: string }>;
  }>;
  // fallback for chat-completions style
  choices?: Array<{
    message?: {
      content?: string;
      tool_calls?: Array<{
        id: string;
        type: string;
        function: { name: string; arguments: string };
      }>;
    };
  }>;
}

async function callResponsesAPI(
  apiKey: string,
  input: unknown[],
  withTools: boolean
): Promise<ResponsesAPIResult> {
  const body: Record<string, unknown> = {
    model: ARK_MODEL,
    input,
    max_output_tokens: 4096,
    temperature: 0.1,
    stream: false,
    thinking: { type: "disabled" },
  };

  if (withTools) {
    body.tools = TOOL_DEFINITIONS;
  }

  const response = await fetch(`${ARK_BASE_URL}/responses`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`API ${response.status}: ${errorBody}`);
  }

  return response.json() as Promise<ResponsesAPIResult>;
}


// ─── Extract text output from API response ───

function extractTextFromResponse(result: ResponsesAPIResult): string | null {
  // Responses API format
  if (result.output) {
    for (const item of result.output) {
      if (item.type === "message" && item.content) {
        for (const c of item.content) {
          if (c.type === "output_text" && c.text) return c.text;
        }
      }
      if (item.type === "output_text" && item.text) return item.text;
    }
  }
  // Chat completions fallback
  if (result.choices?.[0]?.message?.content) {
    return result.choices[0].message.content;
  }
  return null;
}


// ─── Extract function calls from API response ───

interface FunctionCall {
  callId: string;
  name: string;
  arguments: string;
}

function extractFunctionCalls(result: ResponsesAPIResult): FunctionCall[] {
  const calls: FunctionCall[] = [];

  // Responses API format
  if (result.output) {
    for (const item of result.output) {
      if (item.type === "function_call" && item.name && item.arguments) {
        calls.push({
          callId: item.call_id || item.id || uuidv4(),
          name: item.name,
          arguments: item.arguments,
        });
      }
    }
  }

  // Chat completions fallback
  if (calls.length === 0 && result.choices?.[0]?.message?.tool_calls) {
    for (const tc of result.choices[0].message.tool_calls) {
      calls.push({
        callId: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      });
    }
  }

  return calls;
}


// ─── Main generate function (with multi-turn tool loop) ───

const MAX_TOOL_ROUNDS = 3;

export async function generateFilter(
  req: FilterGenerateRequest,
  fields: Field[],
  onChunk: (event: string, data: object) => void
): Promise<void> {
  const apiKey = process.env.ARK_API_KEY;
  if (!apiKey) {
    onChunk("error", {
      code: "NO_API_KEY",
      message: "未配置 ARK_API_KEY，请在 backend/.env 文件中填入您的火山引擎 API Key",
    });
    return;
  }

  const userPrompt = buildUserPrompt(req, fields);

  const input: unknown[] = [
    { role: "system", content: [{ type: "input_text", text: SYSTEM_PROMPT }] },
    { role: "user", content: [{ type: "input_text", text: userPrompt }] },
  ];

  const toolCallLog: unknown[] = [];
  const sessionStart = Date.now();
  const usageLog: unknown[] = [];

  try {
    onChunk("thinking", { text: "正在分析字段定义..." });

    // Log initial request with all params
    logAI({
      type: "session_start",
      query: req.query,
      tableId: req.tableId,
      model: ARK_MODEL,
      apiBaseUrl: ARK_BASE_URL,
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      existingFilter: req.existingFilter || null,
      apiParams: {
        max_output_tokens: 4096,
        temperature: 0.1,
        stream: false,
        thinking: { type: "disabled" },
        tools: TOOL_DEFINITIONS,
      },
    });

    let finalText: string | null = null;

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      onChunk("thinking", {
        text: round === 0
          ? "AI 正在生成筛选条件..."
          : `正在查询数据（第 ${round} 轮工具调用）...`,
      });

      // Log full API request for this round
      logAI({
        type: "api_request",
        round,
        endpoint: `${ARK_BASE_URL}/responses`,
        requestBody: {
          model: ARK_MODEL,
          input,
          max_output_tokens: 4096,
          temperature: 0.1,
          stream: false,
          thinking: { type: "disabled" },
          tools: TOOL_DEFINITIONS,
        },
      });

      const roundStart = Date.now();
      const result = await callResponsesAPI(apiKey, input, true);
      const roundElapsed = Date.now() - roundStart;

      // Extract usage from response
      const usage = (result as Record<string, unknown>).usage || null;
      usageLog.push({ round, elapsedMs: roundElapsed, usage });

      // Log full API response for this round
      logAI({ type: "api_response", round, elapsedMs: roundElapsed, usage, fullResponse: result });

      // Check for text output (final answer)
      const text = extractTextFromResponse(result);
      if (text) {
        finalText = text;
        logAI({ type: "final_output", query: req.query, round, modelOutput: text });
        break;
      }

      // Check for function calls
      const funcCalls = extractFunctionCalls(result);
      if (funcCalls.length === 0) {
        logAI({ type: "error", message: "模型无输出", round, fullResponse: result });
        onChunk("error", { code: "PARSE_ERROR", message: "模型未返回有效内容，请重试" });
        return;
      }

      // Execute tool calls and append results to input
      for (const fc of funcCalls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(fc.arguments);
        } catch {}

        const toolResult = await executeTool(fc.name, args, req.existingFilter, fields);
        let parsedResult: unknown;
        try { parsedResult = JSON.parse(toolResult); } catch { parsedResult = toolResult; }

        // Log full tool call input and output
        logAI({
          type: "tool_call",
          round,
          callId: fc.callId,
          tool: fc.name,
          rawArguments: fc.arguments,
          parsedArguments: args,
          result: parsedResult,
        });

        toolCallLog.push({ tool: fc.name, args, result: parsedResult });

        input.push({
          type: "function_call",
          call_id: fc.callId,
          name: fc.name,
          arguments: fc.arguments,
        });
        input.push({
          type: "function_call_output",
          call_id: fc.callId,
          output: toolResult,
        });
      }
    }

    if (!finalText) {
      logAI({ type: "error", message: "工具调用轮次耗尽，模型未返回最终结果", toolCallLog });
      onChunk("error", { code: "PARSE_ERROR", message: "AI 工具调用轮次超限，请简化查询后重试" });
      return;
    }

    // Parse PRD format JSON
    const prdOutput = extractPRDJSON(finalText);

    if (!prdOutput) {
      logAI({ type: "parse_error", fullText: finalText });
      onChunk("error", { code: "PARSE_ERROR", message: "模型返回格式异常，请重试" });
      return;
    }

    // Convert PRD format → internal format
    const filter = convertPRDToInternal(prdOutput, fields);

    // Log session complete with full summary
    const sessionElapsed = Date.now() - sessionStart;
    logAI({
      type: "session_end",
      query: req.query,
      prdOutput,
      internalFilter: filter,
      toolCallLog,
      usageLog,
      totalElapsedMs: sessionElapsed,
    });

    onChunk("result", { filter });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "未知错误";
    logAI({ type: "error", message });
    onChunk("error", { code: "UNKNOWN_ERROR", message: "AI 调用失败：" + message });
  }
}
