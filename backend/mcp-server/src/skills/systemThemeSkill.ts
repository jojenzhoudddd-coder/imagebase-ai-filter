/**
 * system-theme-skill — 当前系统主题设计规范。
 *
 * 无新工具，仅 promptFragment。当 demo-skill 激活且用户希望产出与系统
 * 风格一致的 demo 时自动（或手动）激活。注入完整的 LM/DM 双主题设计
 * token、色彩、排版、间距、组件规范，让 Agent 生成的 demo 自动沿用系统
 * 视觉语言，无需用户手动指定颜色/字号。
 */

import type { SkillDefinition } from "./types.js";

const SYSTEM_THEME_PROMPT = `## 当前系统主题设计规范

当用户希望 Demo 与系统主题保持一致时，**必须使用以下 CSS 变量和设计规范**。
在 Demo 的 HTML/CSS 中定义这些变量，使产出与系统视觉语言统一。

### 主题切换机制

系统通过 \`<html data-theme="light|dark">\` 切换主题。Demo 中用 \`:root\` 定义 LM 默认值，
\`[data-theme="dark"]\` 覆盖 DM 值。如果 Demo 不需要 DM，只用 \`:root\` 即可。

### CSS 变量 — Light Mode（默认）

\`\`\`css
:root {
  /* Surface 表面层级（5 层从底到顶） */
  --surface-base: #FAFAFA;       /* 页面底色 */
  --surface-1: #F8F9FA;          /* 侧边栏 / 次级面板 */
  --surface-2: #FFFFFF;          /* 卡片 / 弹窗 */
  --surface-3: #F0F1F3;          /* hover / active 态 */
  --surface-inset: #F5F6F7;      /* 输入框凹陷底色 */

  /* Text 文字 */
  --text-primary: #1F2329;
  --text-secondary: #646A73;
  --text-muted: #8F959E;
  --text-placeholder: #B0B5BD;
  --text-on-primary: #FFFFFF;    /* 主色按钮上的字 */
  --text-link: #1456F0;

  /* Border */
  --border-default: #DEE0E3;
  --border-light: #EFF0F1;
  --border-strong: #D0D3D6;
  --border-focus: #1456F0;

  /* Brand 主色 */
  --primary: #1456F0;
  --primary-hover: #0D45D6;
  --primary-pressed: #0934A8;
  --primary-bg: #F0F4FF;         /* 主色淡底（chip / 选中态） */
  --primary-light: #E0E9FF;

  /* Status 功能色 */
  --success: #34A853;   --success-bg: #E6F4EA;
  --warning: #F5A623;   --warning-bg: #FFF4E5;
  --danger: #F54A45;    --danger-bg: #FDECEC;

  /* Shadow */
  --shadow-card: 0 2px 8px rgba(31,35,41,0.06);
  --shadow-popover: 0 4px 16px rgba(0,0,0,0.12), 0 1px 4px rgba(0,0,0,0.06);

  /* Radius */
  --radius-s: 4px;  --radius-m: 6px;  --radius-l: 8px;  --radius-xl: 12px;
}
\`\`\`

### CSS 变量 — Dark Mode

\`\`\`css
[data-theme="dark"] {
  --surface-base: #1C1C1E;
  --surface-1: #232325;
  --surface-2: #2C2C2E;
  --surface-3: #38383A;
  --surface-inset: #161618;

  --text-primary: #F5F5F7;
  --text-secondary: #B0B0B5;
  --text-muted: #8E8E93;
  --text-placeholder: #6E6E73;
  --text-on-primary: #FFFFFF;
  --text-link: #6B9AFF;

  --border-default: #3A3A3C;
  --border-light: #323234;
  --border-strong: #48484A;
  --border-focus: #6B9AFF;

  --primary: #4A82FF;
  --primary-hover: #6B9AFF;
  --primary-pressed: #2E69E0;
  --primary-bg: #1A2543;
  --primary-light: #233056;

  --success: #5BC076;   --success-bg: #1A2E22;
  --warning: #FFB84D;   --warning-bg: #3A2A14;
  --danger: #FF6B66;    --danger-bg: #3A1F1E;

  --shadow-card: 0 1px 0 rgba(255,255,255,0.04), 0 4px 12px rgba(0,0,0,0.40);
  --shadow-popover: 0 1px 0 rgba(255,255,255,0.06), 0 8px 24px rgba(0,0,0,0.50);
}
\`\`\`

### 排版

| 属性 | 值 |
|------|------|
| 字体族 | \`'PingFang SC', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif\` |
| 基础字号 | 14px |
| 行高 | 22px |
| 标题字号 | 13px（面板/列头） |
| 字重 | 400（正文）/ 500（标题）/ 600（强调） |

### 间距

| 场景 | 间距 |
|------|------|
| 面板内边距 | 16px |
| 列表项间距 | 4px |
| 按钮内边距 | 4px 8px（小）/ 6px 12px（中） |
| 图标与文字 | 4-6px |
| 卡片间距 | 12px |

### 组件规范

**按钮**
- 主按钮：bg \`var(--primary)\`，文字 \`var(--text-on-primary)\`，圆角 4px，高度 32px
- 次按钮：bg transparent，文字 \`var(--text-primary)\`，边框 \`var(--border-default)\`
- 危险按钮：bg \`var(--danger)\`，文字白

**输入框**
- 高度 32px，bg \`var(--surface-inset)\`，边框 \`var(--border-default)\`，聚焦 \`var(--border-focus)\`，圆角 4px

**卡片**
- bg \`var(--surface-2)\`，圆角 \`var(--radius-m)\`，shadow \`var(--shadow-card)\`

**表格**
- 表头/数据行 36px，表头 bg \`var(--surface-inset)\`，hover bg \`var(--surface-3)\`
- 选中行 bg \`rgba(20,86,240,0.08)\`，选中单元格边框 \`2px solid var(--primary)\`

**标签调色板（Lark 风格，8 色）**
| 色 | 背景 | 文字 |
|----|------|------|
| Red | #FEE2E2 | #D83931 |
| Orange | #FEE7CD | #F77234 |
| Yellow | #FFF4CC | #B8860B |
| Green | #D4EFDF | #117A3E |
| Teal | #CAEFFC | #02312A |
| Blue | #E0E9FF | #002270 |
| Purple | #EDE4FF | #4A2D8B |
| Pink | #FFE4F0 | #B5295E |

### 硬规则

- **永远用 CSS 变量**，不要硬编码十六进制色值到组件里
- body/html 设置 \`background: var(--surface-base); color: var(--text-primary)\`
- 所有文本截断用 \`overflow:hidden; text-overflow:ellipsis; white-space:nowrap\`，flex 子级加 \`min-width:0\`
- 按钮/输入框统一 32px 高度
- 阴影用 \`var(--shadow-card)\`（卡片）或 \`var(--shadow-popover)\`（弹窗），不要自己写 box-shadow
`;

export const systemThemeSkill: SkillDefinition = {
  name: "system-theme-skill",
  displayName: "当前系统主题设计",
  description:
    "注入当前系统的完整 UI/UX 视觉规范（色彩体系、LM/DM 双主题 CSS 变量、排版、间距、组件样式），" +
    "让 Agent 生成的 Demo 自动沿用系统主题风格。",
  artifacts: [],
  softDeps: ["demo-skill"],
  when:
    "当用户希望 Demo 与系统主题保持一致、使用统一样式、沿用系统设计语言时激活。",
  triggers: [
    /(系统主题|系统风格|主题风格|统一样式|统一风格|设计规范|和系统一致|跟系统一样|系统配色)/,
    /(theme|design.?system|system.?style|brand.?style|consistent.?with.?system)/i,
    /(暗色模式|dark.?mode|light.?mode|明暗|LM.*DM|DM.*LM)/i,
  ],
  tools: [],
  promptFragment: SYSTEM_THEME_PROMPT,
};
