# Idea Editor Bug 报告

> 基于完整代码审查（`index.tsx` 1618 行 + `MarkdownPreview.tsx` 2268 行），
> 按测试用例逐条分析代码路径后发现的 bug。

---

## BUG-1: Preview 模式 `commitEdits` 偏移量累积漂移 — 多次编辑后内容错位

**关联用例**: T-9-2, T-12-6
**严重程度**: P0 — 数据丢失
**文件**: `MarkdownPreview.tsx:979-1016`

**问题**: `commitEdits` 在应用 edits 后会更新 DOM 上的 `data-md-start/end` 偏移量（第 1001-1016 行），但 `editsByStart` map 的 key 使用的是 **编辑前的原始 `start`**。当一个 block 内发生多次编辑（例如用户快速输入多个字符），`forEach` 遍历 `blocks` 时 `editsByStart.get(oldStart)` 会查找 **更新前**的 start 值。但如果有 **orphan rescue** 路径介入（第 1027-1098 行），orphan rescue 会完全重建 `newSource`，此时第 1001-1016 行的偏移量更新逻辑仍然会执行，基于已经过时的 `edits` 数组去修改 DOM 属性——但此时 `newSource` 已经被 orphan rescue 完全替换了，偏移量全部失效。

**根因**: orphan rescue（第 1027 行 `if (hasOrphan)`）覆盖了 `newSource`，但 **没有重新计算**所有 block 的 `data-md-start/end`。orphan rescue 之后的所有块的偏移量都指向旧 source 的位置，下一次 `commitEdits` 调用时 `sourceSnapshotRef.current.slice(start, end)` 会取到错误的 slice → 内容错位或丢失。

**复现路径**:
1. Preview 模式输入一段文字
2. 按 Enter（浏览器产生 orphan `<div>`）
3. 输入更多文字
4. 再按 Enter
5. 此时后续段落的偏移量已经漂移，编辑第 1 段文字 → 第 2 段内容被覆盖或丢失

**修复方向**: orphan rescue 生成新 source 后，应该 `setRenderToken(t => t + 1)` 强制 InnerMarkdown 重新渲染，让 React 重新计算所有 block 的 `data-md-start/end`。或者在 orphan rescue 之后跳过偏移量更新逻辑。

---

## BUG-2: Preview→Source 切换时 `sourceSnapshotRef` 不同步 — 编辑丢失

**关联用例**: T-11-2, T-12-1
**严重程度**: P0 — 数据丢失
**文件**: `MarkdownPreview.tsx:735-739`, `index.tsx:746-780`

**问题**: `toggleMode` (index.tsx:746) 切换到 source 模式时，不会调用 `commitEdits()`。但 `MarkdownPreview` 的 `handleBlur` (1254-1262) 会在失焦时调用 `commitEdits()`。问题在于 **`toggleMode` 先执行 `setMode("source")`，React 会卸载 MarkdownPreview 组件**（因为 mode !== "preview" 时不渲染 MarkdownPreview），此时 `handleBlur` 的 `commitEdits()` 调用中 `rootRef.current` 可能已经是 null（DOM 已被移除），导致最后一次编辑被静默丢弃。

**关键代码路径**:
```
toggleMode() → setMode("source") → React re-render
→ MarkdownPreview 被 unmount → useEffect cleanup 运行
→ 但 handleBlur 的 commitEdits 此时 rootRef.current === null
→ commitEdits 第 802 行 `if (!root) return` 直接退出
→ 最后一次编辑丢失
```

**复现路径**:
1. Preview 模式编辑段落文字（不等 blur）
2. 立即 Cmd+/ 切换到 Source
3. 查看 Source 内容 — **缺少最后一次编辑**

**修复方向**: `toggleMode` 在切换前应该显式调用 `previewRef.current?.forceRemount()` 或添加一个 `flush()` 方法先提交 pending edits。

---

## BUG-3: `setCaretFromSourceOffset` 不处理 operator prefix — 标题/列表中光标偏移

**关联用例**: T-10-1, T-10-2
**严重程度**: P1 — 光标错位
**文件**: `MarkdownPreview.tsx:2116-2228`

**问题**: `setCaretFromSourceOffset` 计算 `caretInBlock` 时直接用 `const rel = offset - bStart`（第 2132 行），然后 `Math.min(rel, flat.length)`。但对于标题 `# Hello`，source offset 指向 `H` 的位置是 2（`# ` 占 2 字符），而 flat text 是 `Hello`（5 字符）。`rel = 2` 会被映射到 flat text 的第 2 个字符 `l`，但实际上应该映射到第 0 个字符 `H`（因为 flat text 不包含 `# ` 前缀）。

**影响**: Source→Preview 切换时，标题/列表内的光标会偏移 `operator prefix` 的长度（标题偏 2-7 字符，列表偏 2-4 字符）。

**修复方向**: `setCaretFromSourceOffset` 需要从 `rel` 中减去 operator prefix 的长度，与 `mapFlatOffsetToSource` 的逻辑对称。

---

## BUG-4: InnerMarkdown memo 在编辑期间永不更新 — `sourceSnapshotRef` 与 DOM 渐进脱节

**关联用例**: T-9-2, T-12-6
**严重程度**: P0 — 渐进性数据损坏
**文件**: `MarkdownPreview.tsx:539-548`

**问题**: InnerMarkdown 的 `memo` comparator（第 539-548 行）在 `editable` 为 true 时 **总是返回 true**（即永不重新渲染）：
```javascript
if (next.editable && prev.editable) return true;
```

这意味着一旦用户开始编辑，InnerMarkdown 的 React 渲染就被完全冻结了。所有后续编辑全靠浏览器原生 DOM 操作 + `commitEdits` 的 delta 拼接来维护 source 一致性。

**这在以下场景会失败**:
- 用户在 block A 编辑 → `commitEdits` 更新 block A 的 `data-md-start/end`
- 浏览器原生 Enter 分裂 block A 为 A1 + A2（orphan）
- orphan rescue 重写 source
- 但 A2 的 `data-md-start/end` 从未被 React 设置过（它不是 React 创建的 DOM 节点）
- 后续编辑 A2 → `commitEdits` 读到 undefined/NaN 的偏移量 → 编辑被丢弃

**这就是"连续切换 5 次后内容退化"的根因**——每次切换都触发 React 重新渲染（`source` prop 变化），InnerMarkdown 会重新 mount 一次并重新计算 offset。但在编辑期间，DOM 和 source 的偏移量会渐进脱节。

**修复方向**: 需要在 orphan rescue 后、或在 Enter 产生新段落后，调用 `setRenderToken(t => t + 1)` 强制 InnerMarkdown 重新渲染一次。当前代码有注释说明了为什么不这么做（第 1543-1574 行 handleKeyDown 注释：renderToken bump 会导致 React 走 stale fiber → NotFoundError 崩溃），这说明当前架构存在根本性矛盾。

---

## BUG-5: Preview 模式粘贴图片不工作

**关联用例**: P-4-1
**严重程度**: P1 — 功能缺失
**文件**: `MarkdownPreview.tsx:1931-1964`

**问题**: Preview 模式的 `handlePaste`（第 1931 行）只处理 `text/plain`：
```javascript
const text = e.clipboardData?.getData("text/plain");
if (text == null) return;
e.preventDefault();
```

当用户粘贴截图时，clipboardData 中只有 `image/png` 类型，`getData("text/plain")` 返回 `""`（空字符串，非 null），所以 `e.preventDefault()` 会执行，但 `document.execCommand("insertText", false, "")` 插入的是空字符串。图片上传路径 **根本不会被触发**，因为 Preview 的 `handlePaste` 截断了事件。

Source 模式的 `handlePaste`（index.tsx:899-911）正确处理了文件类型，但 Preview 模式没有。

**修复方向**: Preview 的 `handlePaste` 应该先检查是否有文件类型 items，如果有则走上传路径；只有纯文本粘贴才走 `execCommand("insertText")`。

---

## BUG-6: Preview 模式 Drop 图片不工作

**关联用例**: P-4-2
**严重程度**: P1 — 功能缺失
**文件**: `MarkdownPreview.tsx:2240-2265`, `index.tsx:1538-1597`

**问题**: Preview 模式下的 `MarkdownPreview` 组件（第 2240-2265 行）没有 `onDrop` / `onDragOver` handler。虽然 index.tsx 的 `.idea-preview-stack` 包裹了 MarkdownPreview，但事件绑定只在 Source 模式的 textarea 上有（index.tsx:1371 `onDrop={handleDrop}`, 1372 `onDragOver={handleDragOver}`）。Preview 的 wrapper `div.idea-preview-stack`（第 1538 行）没有这两个 handler。

**修复方向**: 在 `div.idea-preview-stack` 上添加 `onDrop={handleDrop}` 和 `onDragOver={handleDragOver}`。

---

## BUG-7: `getCaretSourceOffset` root fallback 的 `indexOf` 对空内容返回 0 而非正确偏移

**关联用例**: T-10-1, P-1-1
**严重程度**: P1 — 光标错位
**文件**: `MarkdownPreview.tsx:2106-2111`

**问题**: 当 `block` 为 null（root fallback 路径）时：
```javascript
const origIdx = srcSlice.indexOf(currentText);
if (origIdx < 0) return blockEnd;
return blockStart + origIdx + caretInBlock;
```

对于空文档（`source = ""`），`srcSlice = ""`，`currentText = ""`。`"".indexOf("") === 0`，所以返回 `0 + 0 + caretInBlock`。但 `caretInBlock` 是基于 DOM innerText 长度计算的，而空文档的 innerText 可能包含 `\n`（来自 `<br>`），导致返回值超出 source 长度。

**影响**: 空文档首次输入后切换模式可能导致光标跑到错误位置。

---

## BUG-8: 嵌套列表编辑在 Preview 模式下丢失子项

**关联用例**: T-4-7, T-4-8, P-3-5
**严重程度**: P0 — 数据丢失
**文件**: `MarkdownPreview.tsx:830-838`

**问题**: `commitEdits` 有一个跳过嵌套 block 的逻辑（第 830-838 行）：
```javascript
// Skip blocks that contain wrapped descendants
if (block.querySelector("[data-md-start]") !== null) return;
```

这意味着**外层 `<li>` 被跳过**，只处理内层 `<li>`。但当用户编辑外层 `<li>` 的文本（不是子列表部分），这个编辑会被完全忽略。

**复现**:
```markdown
1. 外层项（编辑这里）
   - 子项一
   - 子项二
```
在 Preview 中编辑"外层项"的文字 → `commitEdits` 跳过这个 block（因为它包含 `[data-md-start]` 子节点） → 编辑丢失。

**修复方向**: 需要对嵌套列表做特殊处理——外层 `<li>` 的文本部分（不包括嵌套列表）应该独立 splice。

---

## BUG-9: Preview 模式 Undo (Cmd+Z) 与浏览器原生 undo 冲突

**关联用例**: P-7-1
**严重程度**: P1 — 行为异常
**文件**: `index.tsx:597-614`

**问题**: 全局 Cmd+Z handler（第 601-614 行）在 bodyRef 内有焦点时拦截所有 undo 操作并走自定义 undo 栈。但 contentEditable 有浏览器原生 undo 栈（由 `execCommand("insertText")` 等操作维护），自定义栈和原生栈不同步：

- 用户在 Preview 模式输入 "ABC" → 浏览器原生 undo 栈有 3 次输入
- `commitEdits` 触发 `onEditableInput` → `setContent(text)` → 自定义 undo 栈 push 一次
- Cmd+Z → 自定义 undo 栈 pop → `setContentRaw(prev)` → **但此时 DOM 仍显示 "ABC"**，因为 InnerMarkdown 的 memo 在 editable 时不重新渲染
- 用户看到 DOM 显示 "ABC"，但 source 已经回退到 "AB" → **数据不一致**

**修复方向**: Preview 模式的 undo 应该调用 `document.execCommand("undo")` 走浏览器原生路径，或者 undo 后调用 `forceRemount()` 重新渲染 DOM。

---

## BUG-10: `handlePreviewMentionQuery` 覆盖 source origin 的 mentionState

**关联用例**: 非直接关联但影响切换
**严重程度**: P2 — 边缘情况
**文件**: `index.tsx:952-963`

**问题**: 第 1546-1557 行直接 `setMentionState` 覆盖了任何来源的 state：
```javascript
onMentionQuery={(state) => {
  if (!state) {
    setMentionState(null);  // 直接 null，不检查 origin
    return;
  }
```

对比 `handlePreviewMentionQuery`（第 952-963 行）有守卫：
```javascript
setMentionState(cur => (cur?.origin === "preview" ? null : cur));
```

第 1546 行的内联 handler 没有 origin 守卫，会无条件清除 mentionState。虽然 source 和 preview 不会同时渲染，但在切换瞬间可能有竞态。

---

## BUG-11: 多次 insertAttachmentMarkdown 只插入到初始 `content` 的位置

**关联用例**: S-4-1（快速粘贴多张图）
**严重程度**: P1 — 内容错位
**文件**: `index.tsx:854-875`

**问题**: `insertAttachmentMarkdown` 依赖闭包中的 `content`（第 857 行 `const start = ta?.selectionStart ?? content.length`），但 `uploadFiles` 循环中连续调用多次时，`content` 是 **第一次调用时闭包捕获的值**，不是中间更新后的值。

```javascript
const uploadFiles = useCallback(async (files: File[]) => {
  for (const f of files) {
    const att = await uploadIdeaAttachment(ideaId, f);
    insertAttachmentMarkdown(att);  // 每次都用旧 content
  }
}, [...]);
```

第二张图片的 `content.slice(0, start)` 基于的是上传第一张之前的 content → 拼接结果覆盖第一张图片的 markdown。

**修复方向**: `insertAttachmentMarkdown` 应该从 `contentRef.current` 读取最新内容而非闭包中的 `content`。

---

## BUG-12: Preview 模式的 `handleFocus` 总是将 `sourceSnapshotRef` 重置为 prop

**关联用例**: T-12-6
**严重程度**: P1 — 数据丢失
**文件**: `MarkdownPreview.tsx:1248-1252`

**问题**: `handleFocus`（第 1248-1252 行）:
```javascript
const handleFocus = useCallback(() => {
  editingRef.current = true;
  sourceSnapshotRef.current = source;
}, [source]);
```

每次 focus 时，`sourceSnapshotRef` 被重置为 **React prop 中的 `source`**。但如果用户之前在 Preview 中编辑过（`commitEdits` 更新了 `sourceSnapshotRef` 但 InnerMarkdown memo 阻止了 `source` prop 传播），此时 `source` prop 仍是旧值。Focus（例如用户点击另一个 block 然后点回来）会将 `sourceSnapshotRef` 回退到旧值 → 下一次 `commitEdits` 的 delta 拼接基于过时的 snapshot → 内容错乱。

**复现路径**:
1. Preview 模式编辑段落 A 的文字 (commitEdits 更新 sourceSnapshotRef)
2. 点击段落 B（focus 仍在 contentEditable 内，但 blur/focus 可能不触发）
3. 点击编辑器外（blur → commitEdits → focus 离开）
4. 再点回编辑器内 → **handleFocus 将 sourceSnapshotRef 重置为 stale source prop**
5. 编辑段落 B → commitEdits 基于 stale snapshot → 段落 A 的编辑被回退

**修复方向**: `handleFocus` 不应覆盖 `sourceSnapshotRef`——如果 `sourceSnapshotRef.current` 已经比 `source` prop 更新（通过 `commitEdits` 或 `onEditableInput`），应该保留较新的版本。

---

## 汇总

| Bug ID | 严重程度 | 简述 | 测试用例 |
|--------|----------|------|----------|
| BUG-1 | P0 | orphan rescue 后偏移量全部失效 | T-9-2, T-12-6 |
| BUG-2 | P0 | Preview→Source 切换丢失最后编辑 | T-11-2, T-12-1 |
| BUG-3 | P1 | Source→Preview 切换光标偏移 | T-10-1, T-10-2 |
| BUG-4 | P0 | InnerMarkdown memo 导致渐进脱节 | T-9-2, T-12-6 |
| BUG-5 | P1 | Preview 模式粘贴图片不工作 | P-4-1 |
| BUG-6 | P1 | Preview 模式拖放图片不工作 | P-4-2 |
| BUG-7 | P1 | root fallback 光标计算越界 | T-10-1 |
| BUG-8 | P0 | 嵌套列表编辑外层文字丢失 | T-4-7, P-3-5 |
| BUG-9 | P1 | Undo 与浏览器原生 undo 栈冲突 | P-7-1 |
| BUG-10 | P2 | mention 切换时 state 竞态 | — |
| BUG-11 | P1 | 连续粘贴多张图只保留最后一张 | S-4-1 |
| BUG-12 | P1 | focus 重置 sourceSnapshot 导致编辑回退 | T-12-6 |

### 架构级问题

BUG-1、BUG-4、BUG-9、BUG-12 指向同一个**架构矛盾**：Preview 模式试图在 `contentEditable` 上同时维护两个 source of truth（React fiber 和浏览器 DOM），通过 `InnerMarkdown memo` 冻结 React 渲染来"让路给浏览器"，但代价是 React 的 fiber 和实际 DOM 渐进脱节。当需要 reconcile 时（切换模式、undo、orphan rescue），两个 source of truth 无法可靠合并。

**建议**: 长期应考虑将 Preview 模式切换为成熟的富文本编辑器库（如 Tiptap / ProseMirror / Lexical），它们原生解决了 contentEditable + 结构化文档模型的同步问题。短期修复应聚焦 BUG-2 和 BUG-12（直接可修的数据丢失路径）。
