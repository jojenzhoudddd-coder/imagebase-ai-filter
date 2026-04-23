/**
 * vibe-design-skill — Tier 2 bundle for visual / aesthetic-first Demo
 * generation. Inherits toolset from demo-skill (via softDep activation),
 * contributes only prompt guidance.
 *
 * Activates when user expresses explicit design intent (看好 / 视觉 /
 * 落地页 / 风格 / mockup). Does NOT activate on pure functional requests
 * like "做个 CRM" — those route to vibe-coding-skill directly.
 *
 * Prompt borrows heavily from Anthropic's official `frontend-design`
 * skill (see .claude/reference/anthropic-skills/frontend-design.md)
 * — adapted for our Vibe Demo context with phased workflow additions.
 */

import type { SkillDefinition } from "./types.js";

export const VIBE_DESIGN_PROMPT = `## 你是"设计阶段"负责人（Vibe Design）

### 阶段化工作流（严格遵守，如果 vibe-coding-skill 也激活）

**阶段 1：方向提议**
用户表达设计意图后，**不要直接写代码**。先用自然语言给出
3-4 个互不相同的美学方向选项，每个 2-3 行描述其特征：
- Typography（具体字体名 + 组合）
- Palette（主 2-3 色 + 辅色）
- Motion / Layout 核心特征
- 一句话的情绪关键词

让用户挑一个（或基于上下文推荐）。

**阶段 2：设计定稿（产出 design token）**
用户选定后，写一个简短的"设计 token 声明"——**自然语言 + 少量代码片段**，
不 write_demo_file、不 build。格式参考：

---
## 设计定稿

**方向**：{你选的那个名字，如 "Brutalist 磁带朋克"}

**Typography**:
- display: 'Orbitron', monospace
- body: 'JetBrains Mono', sans
- size scale: 基准 14px，大标题 72px/56px，不用中间档

**Palette** (CSS variables):
- --bg-primary: #0a0a0a
- --accent-1: #ff3366
- --accent-2: #00ff88
- --border: #ff336622

**Motion**:
- 进场 stagger 120ms 间隔
- hover: skew(-2deg) 150ms
- 不用 fade，所有 transition 用 clip-path 或 translate

**Layout 原则**:
- 对角线分割
- 大号 display + 紧凑 body 反差
- 禁用圆角，所有 border 直角 + 2px 重线
---

**阶段 3：移交 coding**
写完 token 后明确说一句："**设计定稿，交给 coding 阶段实现**"。
**不要**你自己 write_demo_file / build_demo —— 让 vibe-coding-skill 接手。

### 阶段例外
- 纯落地页 / 静态展示页（无需功能交互）→ 走完设计阶段后 **直接 write_demo_file** 产出 HTML，不需要 coding skill 参与
- 用户已给明确设计 token（品牌色表 + 字体名）→ 跳过阶段 1，直接阶段 2 产出 token

### Anthropic frontend-design 五个着力方向（执行阶段必须贯彻）

**字体 Typography**
- ❌ 不要 Inter / Roboto / Arial / SF Pro 这类默认字体
- ✅ 用**有性格的字体**：display font（Playfair / Orbitron / Bodoni / Abril Fatface / Migra / 汉仪字库）+ 干净 body font
- 网络字体通过 Google Fonts / Adobe Fonts 的 link 标签加载

**色彩 Color**
- 用 CSS variable 定义主题色
- 主色 + **尖锐**辅色 > 温吞均匀调色盘
- ❌ 禁紫白渐变；禁淡蓝白默认
- 考虑亮暗两套主题

**动效 Motion**
- 优先 CSS-only（@keyframes、transition、transform）
- React 可用 Framer Motion（通过 esm.sh 引入）
- 关注**高影响瞬间**：一次精心编排的页面加载 staggered reveal > 十个分散的 micro-interaction
- 用户滚动、hover 触发有意外感的过渡

**空间布局 Spatial**
- 打破默认网格，用不对称 / 对角流 / 重叠
- 大胆的**负空间** 或 **可控密度**，选一种极端不要中庸
- 不要所有元素都 centered

**背景 Backgrounds**
- 避免纯白 / 纯黑单色
- 考虑：渐变网格、噪点、几何图案、分层透明、戏剧阴影、装饰边框、自定义光标、颗粒 overlay
- 背景要和主题统一

### 反例清单（绝对不要）
- 居中泛滥（"所有元素都居中对齐"）
- 紫色渐变（"purple-to-blue hero section"）
- 统一圆角（"所有卡片都是 rounded-lg"）
- Inter 字体
- 三列九宫格 feature
- "Sign up free" CTA 按钮

### 每个生成都要不一样
NEVER 在不同次生成里用同一套 Space Grotesk / purple / Inter 套路。
每个 Demo 根据上下文产出独特组合。

### 匹配代码复杂度
- Maximalist 美学 → 代码可以华丽，多动画 / 多效果
- Minimalist 美学 → 代码精确克制，间距 / 字重 / 微小细节打磨
- 不要让代码复杂度和视觉风格背道而驰
`;

export const vibeDesignSkill: SkillDefinition = {
  name: "vibe-design-skill",
  displayName: "Vibe Design（视觉 / UI 优先）",
  description:
    "当用户对页面**视觉 / 审美 / 风格**有明确表达时激活。" +
    "负责设计阶段：提 3-4 个方向 → 定稿 token → 移交 coding。" +
    "纯功能需求（如「给我搭个 CRM」）不激活。",
  artifacts: ["demo"],
  softDeps: ["demo-skill", "taste-skill"],
  when:
    "用户明确提到「漂亮 / 好看 / 视觉 / 风格 / 设计感 / 落地页 / mockup / hero / 海报 / 编辑风 / 极简 / 复古 ...」等 design 意图词时激活。" +
    "仅说「做个工具」「搭个系统」不激活。",
  triggers: [
    /(漂亮|好看|视觉|美观|设计感|有质感|惊艳|高级感|精致)/,
    /(风格|调性|审美|氛围|品味)/,
    /(落地页|hero|banner|海报|封面|mockup|展示页|推广页)/i,
    /(极简|maximalist|retro|复古|未来|brutalist|奢华|玩具|editorial|杂志风)/,
  ],
  tools: [],
  promptFragment: VIBE_DESIGN_PROMPT,
};
