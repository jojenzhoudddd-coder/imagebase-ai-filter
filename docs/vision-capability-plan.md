# Vision Capability 方案 V2 — Subagent 架构

**状态**：仅分析，未排期。决策完成后再启动。
**创建日期**：2026-05-07
**V2 更新**：2026-05-07 — 放弃"每个 provider 单独接 vision"路线，改为 subagent 统一架构

## 目标

让 chat agent 具备视觉理解能力 —— 用户在 chat 里上传/粘贴图片，模型能看到内容并理解。**用户不需要知道当前模型是否支持 vision**，体验完全一致。

> 注意：本 plan 解决的是**视觉理解**（model reads image）。**视觉生成**（model produces image，Seedream / Seedance）已经在另一条管线里跑通，跟本 plan 无关。

## 核心设计：两条路径，用户无感

```
用户发送带图消息
       │
       ▼
  主模型支持 vision？
     ╱        ╲
   YES         NO
    │           │
    ▼           ▼
 直接传        调 vision subagent
 image block   (Claude/GPT via OneAPI)
    │           │
    ▼           ▼
 主模型        subagent 返回描述/分析
 直接看图      → 注入主模型 context
    │           │
    ▼           ▼
   正常回复    主模型基于文字描述回复
```

### 路径判断

| 主模型 | vision 支持 | 走哪条路径 |
|--------|-------------|-----------|
| Claude Opus 4.7 | ✅ 原生 | 直传 image block |
| Claude Opus 4.6 | ✅ 原生 | 直传 image block |
| GPT-5.5 | ✅ 原生 | 直传 image block |
| GPT-5.4 | ✅ 原生 | 直传 image block |
| GPT-5.4 mini | ✅ 原生 | 直传 image block |
| Doubao 2.0 | ❌ | → subagent (Claude/GPT) |
| 用户自定义模型 | 按 modality 字段判断 | 有 "image" → 直传，否则 → subagent |

### Subagent 模型选择

Doubao（或其他无 vision 的模型）场景下，vision subagent 模型选择复用 `resolveModelForCall` 现有 fallback 链：

1. 优先 Claude Opus 4.7（效果最好）
2. 不可用 → Claude Opus 4.6
3. 不可用 → GPT-5.5 / GPT-5.4
4. 全不可用 → 降级为纯文字（告知用户"当前无可用 vision 模型"）

**不引入 Doubao Vision 独立 model ID**，不新增 ARK vision adapter。Vision 能力全部复用现有 OneAPI 通道。

## 当前管线缺口（V2 更新）

| 路径 | 状态 | 备注 |
|------|------|------|
| 用户上传图到 chat | ❌ | `~/.imagebase/uploads/chat/`，markdown URL 拼进 `message: string`，后端永远当文本处理 |
| `Message` 存储 | ❌ | Prisma 里 `content: string`，无 attachments 结构化字段 |
| `assembleInput()` → 主模型 | ❌ | 永远包成 `[{type:"input_text", text}]`，没有 image block |
| Claude user message image block | ❌ | 工具回包路径有（`__IBASE_IMAGE_v1__` marker），用户消息路径没接 |
| GPT user message image block | ❌ | `/v1/chat/completions` 支持 `image_url`，代码没接 |
| Vision subagent 调用链 | ❌ | 需新建 `visionSubagentService` |
| `analyze_image` MCP tool | ❌ | 补充工具，任何模型均可主动调用 |
| modelRegistry `modality` 字段 | ⚠️ | Claude/GPT 实际支持 vision 但标的 `["text"]`，需修正为 `["text", "image"]` |

## 实现方案（分三层）

### Layer 1: 数据结构 — 让图能"流"到后端

- 前端 `ChatInput`：上传成功后**结构化**附加在 message：
  ```ts
  POST /api/chat/conversations/:id/messages
  { message: "...text...", attachments: [{kind:"image", url, mime, fileId}] }
  ```
- 后端：扩 `Message` Prisma model 加 `attachments Json?` 字段，保留 `content: string` 不动 —— history 全兼容，改动最小。
- `assembleInput()` 检测 `Message.attachments`：不空时进入 vision 分支。

**工作量：1-2 天**

### Layer 2: 双路径 Vision 核心

#### 2a. 直传路径（Claude + GPT 原生 vision）

主模型 `modality` 含 `"image"` 时，`assembleInput()` 把图编成对应 provider 的 image content block：

- **Claude (oneapiAdapter anthropic 分支)**：后端读本地文件 → base64 → `{type:"image", source:{type:"base64", media_type, data}}`
  - 复用 `__IBASE_IMAGE_v1__` 已有的编码逻辑，从"工具回包"路径扩展到"用户消息"路径
- **GPT (oneapiAdapter openai 分支)**：`{type:"image_url", image_url:{url:"data:mime;base64,..."}}`
  - data URL inline，不依赖公网可访问的 URL

**工作量：1 天**（两个 adapter 分支各半天）

#### 2b. Subagent 路径（Doubao 等无 vision 模型）

新建 `services/visionSubagentService.ts`：

```ts
async function analyzeImageForContext(
  imageAttachments: Attachment[],
  userMessage: string,
  conversationContext?: string  // 可选：最近几轮对话摘要，帮 subagent 理解上下文
): Promise<string>
```

流程：
1. 从 `modelRegistry` 找一个 `modality` 含 `"image"` 且 `available` 的模型（优先 Claude → GPT）
2. 构造一次性 vision 请求：system prompt 指示"描述图片内容，回答用户问题" + 用户原始消息 + image blocks
3. 拿到 subagent 的文字回复
4. 注入回主模型的 context：`[图片分析结果]\n{subagent 输出}\n[/图片分析结果]`
5. 主模型（Doubao）基于文字描述正常回复

**Subagent system prompt 设计要点**：
- 不废话，直接输出分析内容
- 如果用户问题明确（"这张图里有什么数据"）→ 带着问题分析
- 如果用户只是发了图没说话 → 全面描述（布局、文字、数据、色彩等）
- 表格/数据截图 → 尽量 OCR 成结构化 markdown table
- UI 截图 → 描述组件布局 + 交互状态

**工作量：1 天**

#### 2c. `analyze_image` MCP 工具（补充能力）

即使主模型已经"看到"图片，有时也需要更深入的分析。注册为 Tier 1 always-on 工具：

```ts
// analyze_image tool
{
  name: "analyze_image",
  description: "对图片进行深度分析（OCR、表格提取、UI 描述等）",
  inputSchema: {
    imageUrl: string,      // 本地 uploads 路径或 http URL
    question?: string,     // 可选：带着具体问题分析
    mode?: "describe" | "ocr" | "table-extract" | "ui-audit"
  }
}
```

内部复用 `visionSubagentService`，按 mode 切换不同的 system prompt。

**工作量：半天**

### Layer 3: modelRegistry 修正 + 用户自定义模型支持

- 修正 Claude/GPT 的 `modality` 为 `["text", "image"]`
- `CustomModel` 创建时支持声明 `modality`（默认 `["text"]`）
- `add_model` MCP 工具增加可选 `modality` 参数
- 路径判断逻辑统一读 `model.modality.includes("image")`

**工作量：半天**

## 推荐路径

```
Day 1       Layer 1 数据结构     (FE attachments + Prisma 迁移 + assembleInput 分支)
Day 1.5     Layer 2a 直传        (Claude + GPT adapter 接 user image block)
            Layer 3 registry     (修正 modality 字段)
            ← 这里 Claude/GPT 用户已有完整 vision 体验
Day 2       Layer 2b subagent    (visionSubagentService + Doubao 透明代理)
Day 2.5     Layer 2c tool        (analyze_image MCP 工具)
```

总计 **~2.5 天**。最小可见集 = Layer 1 + 2a + 3 = **1.5 天**（Claude/GPT 直传）。Doubao subagent 第二天补上。

## 对比 V1 方案的改进

| 维度 | V1（每家单独接） | V2（subagent 架构） |
|------|-----------------|-------------------|
| 用户感知 | 切模型可能丢 vision | 所有模型统一体验 |
| Doubao Vision | 需注册独立 model ID + adapter | 不需要，复用 OneAPI |
| 新增模型适配 | 每个 provider 单独写 | 只看 `modality` 字段 |
| 配置成本 | ARK vision API key + model ID | 零新增 |
| 额外延迟 | 无 | Doubao 场景多一轮 subagent（~2-5s） |
| 分析深度 | 取决于主模型 | `analyze_image` tool 可深度分析 |

## 已决策事项

1. **图片存储 → S3**：上传走 S3，模型侧用公网 URL（`source.type:"url"`）而非 base64 inline，省 token、支持多图
2. **预 resize → 做**：前端上传前缩到 1568px 长边（Anthropic 推荐值），再传 S3

## 启动条件

✅ 所有决策已完成，可以开始实施。推荐先做 Layer 1 + 2a + 3（1.5 天出 demo），体验 Claude/GPT vision 后再补 subagent。
