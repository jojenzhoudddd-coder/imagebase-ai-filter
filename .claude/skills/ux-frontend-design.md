# UX & Frontend Design Skill

Use this skill when implementing any UI component, styling change, or interaction pattern in the AI Filter project. It codifies the project's design system, ensuring visual and interaction consistency.

## When to Use
- Creating new UI components
- Modifying existing component styles
- Adding new interaction patterns (mouse, keyboard, etc.)
- Reviewing CSS changes for consistency
- Deciding color, spacing, or typography choices

## Design System Reference

Read `docs/design-resources.md` for the complete design token reference (colors, spacing, typography, shadows, border-radius).

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

- [ ] Using CSS custom properties (no hardcoded colors)
- [ ] Text truncation handles long content
- [ ] Keyboard interaction works (Delete, Escape, Enter, Ctrl+Z)
- [ ] Right-click context menu closes on outside click
- [ ] Flex containers have `min-width: 0` where needed
- [ ] Icons use `currentColor` and inline SVG
- [ ] Loading/empty states handled
- [ ] Optimistic updates with error rollback
- [ ] Drag operations use 4px threshold
