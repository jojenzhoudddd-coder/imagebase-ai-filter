# UX & Frontend Design Skill

Use this skill when implementing any UI component, styling change, or interaction pattern in the AI Filter project. It codifies the project's design system, ensuring visual and interaction consistency.

## When to Use
- Creating new UI components
- Modifying existing component styles
- Adding new interaction patterns (mouse, keyboard, etc.)
- Reviewing CSS changes for consistency
- Deciding color, spacing, or typography choices

**⚠️ 强制要求**: 每次涉及 UI 组件或图标的新增/修改时，必须先通过 Figma MCP 工具从设计库获取最新设计规范，再进行编码。

## Design System Reference

Read `docs/design-resources.md` for the complete design token reference (colors, spacing, typography, shadows, border-radius).

## Figma 设计资源（必须使用）

实现任何 UI 变更前，**必须**通过 Figma MCP 工具获取设计规范：

### 组件库
- **File Key**: `7rik2X7IeAxfH0qXFklqjb` (UD-03-基础组件-桌面端)
- 包含：按钮、输入框、下拉框、弹窗、Toast 等全部基础组件

### 图标库
- **File Key**: `z27mSnJ9vbBeW6VnkLVAg6` (UD-07-图标表情库)
- 包含：所有工具栏、状态、操作图标

### 获取方式
```
# 获取组件设计上下文
use Figma MCP: get_design_context(fileKey="7rik2X7IeAxfH0qXFklqjb", ...)

# 获取图标设计上下文
use Figma MCP: get_design_context(fileKey="z27mSnJ9vbBeW6VnkLVAg6", ...)

# 获取截图
use Figma MCP: get_screenshot(fileKey="...", nodeId="...")
```

## Core Principles

1. **Follow Lark Base visual language** — Clean, high-density enterprise UI. No decorative elements.
2. **Use CSS custom properties** — All colors via `var(--color-*)`, radii via `var(--radius-*)`, shadows via `var(--shadow-*)`. Never hardcode hex values in component CSS.
3. **Base font: 14px / 22px line-height** — Use PingFang SC font family. Column headers and panel titles use 13px.
4. **Flex layout with min-width: 0** — Always add `min-width: 0` on flex children that may need text truncation.
5. **Text truncation pattern** — Use `overflow: hidden; text-overflow: ellipsis; white-space: nowrap` for single-line truncation. When combined with flex, ensure parent has `min-width: 0`.
6. **No wrapping in constrained containers** — Input boxes, loading text, toolbar items must never wrap. Always truncate.

## Color Usage Rules

| Context | Color Variable |
|---------|---------------|
| Primary text | `--color-text-primary` |
| Secondary/helper text | `--color-text-secondary` |
| Placeholder text | `--color-text-placeholder` |
| Borders | `--color-border` |
| Backgrounds | `--color-bg` (grey) or `white` |
| Hover states | `--color-bg-hover` |
| Primary action | `--color-primary` |
| Danger/destructive | `#D83931` |
| Selection highlight | `rgba(20, 86, 240, 0.10)` for bg, `#1456F0` for border |

## Component Sizing

| Component | Height | Notes |
|-----------|--------|-------|
| Table header row | 36px | Background: `--color-bg` |
| Table data row | 36px | Hover: `--color-bg` |
| Input field | 32px | Border: `--color-border` |
| Toolbar button | 28px | Padding: 4px 8px |
| Min column width | 60px | `MIN_COL_WIDTH` constant |

## Interaction Patterns

### Drag Threshold
All drag operations (cell selection, column reorder, column resize) use a **4px movement threshold** before activating. This prevents accidental drags on click.

```typescript
const THRESHOLD = 4;
if (Math.abs(dx) > THRESHOLD || Math.abs(dy) > THRESHOLD) {
  // Start drag
}
```

### Edit Triggering
- **Double-click**: Enter edit mode (all editable fields except Checkbox)
- **Click already-selected cell**: Enter edit mode (click-again-to-edit)
- **Checkbox**: Single click toggles value (never enters text edit)
- **Read-only fields**: AutoNumber, CreatedTime, ModifiedTime — never editable

### Selection Mutual Exclusion
- Selecting cells clears column selection: `setSelectedColIds(new Set())`
- Checking row checkbox clears cell selection: `setCellRange(null)`
- Starting column selection clears cell selection: `setCellRange(null)`

### Keyboard Handler Pattern
Use `useRef` to sync state for native DOM event handlers (eliminates stale closure issues):

```typescript
const stateRef = useRef(state);
stateRef.current = state;

useEffect(() => {
  const handler = (e: KeyboardEvent) => {
    const current = stateRef.current; // Always fresh
  };
  document.addEventListener("keydown", handler);
  return () => document.removeEventListener("keydown", handler);
}, [/* stable deps only */]);
```

### Context Menu Positioning
Right-click menus use `position: fixed` with `e.clientX` / `e.clientY`. Close on any outside `mousedown`.

### Dropdown Menus — 两套规格不要混用

项目里有两类下拉菜单，**类目不同、规范不同**，新增 UI 时务必先确认归类：

#### A. Regular menu（DropdownMenu / `.topbar-menu`）—— 操作型

用于"更多操作 / 工具栏二级菜单 / 右键菜单"等纯命令场景。

| Token | 值 |
|---|---|
| 容器 width | 220 px |
| 容器 padding | 4 px |
| Item height | 32 px |
| Item padding | 0 12 px |
| Item gap | 0（item 紧贴）|
| Item radius | `var(--radius-s)` = 4 px |
| Hover bg | `var(--color-bg-hover)` |
| Font size | 14 px |
| Icon size | 16 px |

JSX 用 `<DropdownMenu>` 组件 / 普通 `.topbar-menu` 类。**不要改这套 token**，会影响多个老菜单。

#### B. Profile popover（`.topbar-profile-popover`）—— 身份信息卡

只用于"头像下拉、用户信息编辑"场景。明显比 regular menu 更宽、行间距更大、更"卡片化"。

| Token | 值 |
|---|---|
| 容器 width | **280 px** 固定（非 min-width）|
| 容器 padding | 6 px |
| **Item height** | **40 px**（比 regular 高 8px，更呼吸）|
| Item padding | 0 12 px |
| **Item gap** | **4 px**（item 之间留白，flex `gap: 4px`）|
| Item radius | `var(--radius-s)` |
| Header padding | 14 14 12（top L/R bottom）|
| Header layout | flex-row：左 48px avatar + 右 username/email 列 |
| Avatar hover | 半透明黑覆盖 + 白色相机 SVG（**无文字**）|
| Username | 双击进入 `<InlineEdit>`，blur/Enter 提交，Esc 取消 |
| Email | `font-size: 12px; color: #8F959E`（DM: `#A6ADB6`）只读 |
| 定位 | `position: fixed; top: rect.bottom + 4; left: rect.right - 280`（保证 popover 右边对齐 avatar 右边）|

**用途约束**：profile popover 只在 TopBar 用一次。如果未来出现"用户卡 / 团队成员卡"等类似形态，复用这套 token；其它"操作菜单"必须用 regular menu。

## i18n Pattern

- All non-user-data UI strings use `t("key")` from `useTranslation()` hook
- Translation keys are flat dot-separated: `"toolbar.addRecord"`, `"op.contains"`, `"toast.saveFailed"`
- Module-scope constants (e.g., `OPERATORS_BY_TYPE`) store translation keys as labels, resolved at render with `t(op.label)`
- Default props that need translation: make prop optional, resolve inside component body with `t()`
- Locale stored in `localStorage("app_lang")`, `setLocale()` writes + `window.location.reload()`
- New translations: add key to `en.ts`, add matching key to `zh.ts` (typed for compile-time safety)

## CSS Naming Convention

- Component wrapper: `.component-name` (e.g., `.filter-panel`, `.table-view`)
- Sub-elements: `.component-prefix-element` (e.g., `.fp-ai-input`, `.fp-ai-loading`)
- State modifiers: `.element.state` (e.g., `.fp-ai-input.echo`, `.td-editing`)
- BEM-like but simpler — no `__` or `--`, use `-` separators

## Responsive Behavior

- No responsive breakpoints — desktop-only application
- Table is horizontally scrollable within its container
- Panels (FilterPanel, FieldConfigPanel) are fixed-position overlays
- Minimum viable viewport: ~1024px width

## Icon Guidelines

- Use inline SVG (not icon fonts)
- Standard size: 14px for toolbar, 12px for inline (close buttons)
- Stroke-based icons: `strokeWidth="2"`, `strokeLinecap="round"`
- Color: `currentColor` (inherits from parent text color)

## Animation Guidelines

- Toast enter/leave: 0.3s / 0.25s ease
- Loading dots: 1.2s ease-in-out infinite blink, staggered 0.2s per dot
- SparkleIcon: conditional animated class
- Mic pulse: CSS keyframe scale animation
- Prefer CSS animations over JS — simpler, more performant

## Checklist for New UI Work

- [ ] **从 Figma 获取设计规范** — 新增/修改组件前，先通过 Figma MCP 获取最新设计
- [ ] **从 Figma 获取图标** — 新增/修改图标前，先从图标库获取标准 SVG
- [ ] Using CSS custom properties (no hardcoded colors)
- [ ] Text truncation handles long content
- [ ] Keyboard interaction works (Delete, Escape, Enter, Ctrl+Z)
- [ ] Right-click context menu closes on outside click
- [ ] Flex containers have `min-width: 0` where needed
- [ ] Icons use `currentColor` and inline SVG
- [ ] Loading/empty states handled
- [ ] Optimistic updates with error rollback
- [ ] Drag operations use 4px threshold
