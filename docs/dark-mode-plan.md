# Dark Mode 系统化方案

> **TL;DR**：所有颜色走 `frontend/src/styles/tokens.css` 里的 semantic token，
> 不写硬编码十六进制色。LM 默认 → DM 通过 `<html data-theme="dark">` 切换。

---

## 1. 设计原则

### 1.1 DM ≠ 颜色反转
所有主流产品（macOS / Linear / Notion / GitHub / Slack）DM 底色都是**带灰度的近黑**，不是纯黑：

| 产品 | LM 底色 | DM 底色 |
|---|---|---|
| macOS | `#FFFFFF` | `#1E1E1E` |
| Linear | `#FFFFFF` | `#0F1014` |
| Notion | `#FFFFFF` | `#191919` |
| GitHub | `#FFFFFF` | `#0D1117` |
| Slack | `#FFFFFF` | `#1A1D21` |

**本项目选用** `#16181D`（介于 Linear 和 Slack 之间，偏冷调，与品牌蓝协调）。

### 1.2 文字也不是纯白

| 用法 | LM | DM | 备注 |
|---|---|---|---|
| 主文字 | `#1F2329` | `#E6E8EB` | DM ≈ 92% 白，少 30% 眩光 |
| 二级 | `#646A73` | `#A6ADB6` | DM 二级要更亮（相对底色） |
| 弱化 | `#8F959E` | `#7A828E` | DM 整体对比变小 |
| placeholder | `#B0B5BD` | `#5A6270` | |
| disabled | `#BBBFC4` | `#4A5260` | |

### 1.3 品牌色需要 DM 调子
LM 的强蓝 `#1456F0` 在 DM 周围一切都暗了的环境里会"过亮刺眼"。DM 用**降饱和 + 提亮**的版本：

| Token | LM | DM |
|---|---|---|
| `--primary` | `#1456F0` | `#4A82FF` |
| `--primary-hover` | `#0D45D6` | `#6B9AFF` |
| `--success` | `#34A853` | `#5BC076` |
| `--warning` | `#F5A623` | `#FFB84D` |
| `--danger` | `#F54A45` | `#FF6B66` |

### 1.4 表面 5 层
DM 下"层级感"靠**多层底色叠加**（LM 靠阴影；DM 阴影几乎看不见）：

```
─ Layer 0  --surface-base    LM #FFFFFF / DM #16181D   ← body / shell
─ Layer 1  --surface-1       LM #F8F9FA / DM #1B1E24   ← sidebar / 大面板
─ Layer 2  --surface-2       LM #FFFFFF / DM #22262D   ← card / popover
─ Layer 3  --surface-3       LM #F0F1F3 / DM #2C313A   ← hover / active
─ Layer 4  --surface-inset   LM #F5F6F7 / DM #14161B   ← input / 凹陷
```

每层差 ~3-4 luminance point。LM 也对应 0-4，区分小一点。

### 1.5 阴影策略

- LM：靠 `box-shadow` 制造浮起感
- DM：阴影几乎看不见，改为 **1px highlight top border + 厚重深色 shadow** 双管齐下：
  ```
  box-shadow: 0 1px 0 rgba(255,255,255,0.06), 0 8px 24px rgba(0,0,0,0.5);
  ```

---

## 2. Token 字典

完整列表在 `frontend/src/styles/tokens.css`。这里只列分组：

### Surface
- `--surface-base / 1 / 2 / 3 / inset`
- `--surface-modal-scrim`（modal 遮罩半透明）

### Text
- `--text-primary / secondary / muted / placeholder`
- `--text-on-primary`（主色按钮上的字，永远纯白）
- `--text-disabled`
- `--text-link`

### Border
- `--border-default / light / strong`
- `--border-focus`（输入框 focus）

### Brand
- `--primary / hover / pressed / bg / light`

### Status
- `--success / warning / danger / info`
- 每个都有 `-bg` 配对（chip / badge 浅底）

### Icon
- `--icon-primary / secondary / muted`

### Shadow
- `--shadow-card / popover / modal`

### Artifact palette（不随主题翻，是品牌固定色）
- `--artifact-table / taste / idea / demo`
- DM 下轻度提亮，保留识别度

---

## 3. 使用规则

### 3.1 在 CSS 里
```css
/* ✅ 正确 */
.my-card {
  background: var(--surface-2);
  color: var(--text-primary);
  border: 1px solid var(--border-default);
  box-shadow: var(--shadow-card);
}

/* ❌ 错误 —— 永远不要硬写十六进制 */
.my-card {
  background: #FFFFFF;
  color: #1F2329;
}
```

### 3.2 在 TSX 里
```tsx
// ✅ 优先：用 className，颜色全部走 token
<div className="my-card">…</div>

// ⚠️ 临时：style 里也要用 var()
<div style={{ background: "var(--surface-2)" }}>…</div>

// ❌ 永远不要：硬写
<div style={{ background: "#FFFFFF" }}>…</div>
```

### 3.3 SVG 图标
```tsx
// ✅ 用 currentColor，由父级 color 控制
<svg fill="none" stroke="currentColor" />

// ⚠️ 留下硬编码 fill 的 SVG（暂时）
//    依赖 tokens.css 里的 attribute selector 兜底转换
<svg><path fill="#2B2F36" /></svg>
```

---

## 4. Theme 切换实现

### 4.1 用户切换
- TopBar 头像 popover → 外观 → 浅色 / 深色 / 跟随系统
- `useTheme()` hook 写到 `<html data-theme="...">` + 持久化到 localStorage

### 4.2 启动时机
`frontend/src/theme.ts` 在 module load 时 eager apply 一次，避免首屏从 LM 切到 DM 闪烁。

### 4.3 跟随系统
监听 `prefers-color-scheme: dark` 变化，自动 sync。

---

## 5. 防回归

### 5.1 编码规则（写进 design skill）
- 新写 CSS：禁止 `#[0-9a-fA-F]{3,6}` 字面量，必须 `var(--...)`
- 新写 TSX：style 里也禁止硬编码颜色
- 新写 SVG：图标必须 `fill="currentColor"`，颜色由父级控制

### 5.2 Lint（建议加）
```bash
# package.json
"lint:colors": "rg --type css '#[0-9a-fA-F]{3,6}' frontend/src --no-line-number || echo 'OK'"
```

### 5.3 Code review checklist
- [ ] 改动里有没有硬编码颜色？
- [ ] DM 下视觉走查通过？

---

## 6. 已知限制 / 后续

- **第三方组件**：Markdown 渲染（IdeaEditor 里 `react-markdown`）的代码块底色由插件库默认样式决定，需要单独覆盖
- **图片 / 截图嵌入**：用户上传的浅色截图在 DM 下边界会有割裂感，可考虑加 `filter: brightness(0.9)`
- **Vega-Lite chart**：分析结果图表的配色当前固定，未来可探测 `--text-primary` 注入
- **Auth pages** 的薰衣草底图当前对所有主题用同一张图；DM 下可能需要换一张更暗的版本
