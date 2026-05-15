# Idea Block Tree 测试用例

> 对应方案：`docs/idea-block-tree-plan.md`
> 分三期（PR-A / PR-B / PR-C），每期上线前必须全部通过

---

## PR-A：后端 Block 写 API

### 1. 数据库迁移

| ID | 用例 | 操作 | 预期结果 | 优先级 |
|----|------|------|---------|--------|
| A-1.1 | Prisma migrate 不破坏现有数据 | 跑 `prisma migrate deploy` | 现有 IdeaBlock 行的 `parentId` = null, `version` = 0；无数据丢失 | P0 |
| A-1.2 | 存量 Idea.content 与 blocks 一致 | 对所有现有 Idea，查 blocks 拼接 === Idea.content | 全部一致 | P0 |
| A-1.3 | 新增索引生效 | `EXPLAIN` 查询 `SELECT * FROM idea_blocks WHERE parentId = ? ORDER BY order` | 走 `idea_blocks_parentId_order_idx` 索引 | P1 |

### 2. PATCH /api/ideas/:ideaId/blocks/:blockId（增强）

| ID | 用例 | 操作 | 预期结果 | 优先级 |
|----|------|------|---------|--------|
| A-2.1 | 基本内容更新 | PATCH blockId, `{ content: "新段落" }` | block.content 更新；Idea.content 重建一致；block.version + 1；idea.version + 1 | P0 |
| A-2.2 | 乐观并发——版本匹配 | PATCH blockId, `{ content: "x", baseVersion: 0 }` | 200 成功，blockVersion = 1 | P0 |
| A-2.3 | 乐观并发——版本不匹配 | 先 PATCH blockId 一次（version → 1），再 PATCH `{ baseVersion: 0 }` | 409 Conflict，body 包含最新 block 内容和 version | P0 |
| A-2.4 | 不传 baseVersion 跳过检查 | PATCH blockId, `{ content: "y" }`（无 baseVersion） | 200 成功，无论当前 version 是多少 | P0 |
| A-2.5 | 类型转换 | PATCH blockId, `{ transformTo: "heading", props: { level: 2 } }` | block.type = "heading"；content 前面加 `## ` 前缀；Idea.content 重建一致 | P1 |
| A-2.6 | 修改不存在的 blockId | PATCH 不存在的 id | 404 | P1 |
| A-2.7 | 跨 Idea 越权 | PATCH ideaA 的路径 + ideaB 的 blockId | 404（block 不属于该 idea） | P1 |
| A-2.8 | Mention 联动 | PATCH block content 包含 `[@表](mention://table/xxx)` | Mention 表新增一行；删除原 content 里的旧 mention | P0 |
| A-2.9 | Sections 联动 | PATCH heading block 修改标题文本 | Idea.sections 更新 slug | P1 |
| A-2.10 | SSE 事件 | PATCH 后监听 SSE | 收到 `idea:block-update` 事件（含 blockId, blockVersion）+ `idea:content-change` 兼容事件 | P0 |
| A-2.11 | SSE 反回声 | 用 clientId=A 发 PATCH，clientId=A 的 SSE 不收到事件 | clientId=B 收到，A 不收到 | P0 |

### 3. POST /api/ideas/:ideaId/blocks（新增）

| ID | 用例 | 操作 | 预期结果 | 优先级 |
|----|------|------|---------|--------|
| A-3.1 | 在末尾插入 | POST `{ type: "paragraph", content: "新段落\n" }` | 新 block order > 最后一个 block；Idea.content 末尾多了新段落 | P0 |
| A-3.2 | 在中间插入 | POST `{ afterBlockId: "block2", type: "paragraph", content: "插入\n" }` | 新 block order 在 block2 和 block3 之间；Idea.content 拼接一致 | P0 |
| A-3.3 | 在开头插入 | POST `{ afterBlockId: null, type: "heading", content: "# 标题\n" }` | 新 block order < 第一个 block；Idea.content 开头是新标题 | P0 |
| A-3.4 | afterBlockId 不存在 | POST `{ afterBlockId: "不存在" }` | 400 或 404 | P1 |
| A-3.5 | Idea.version 递增 | 插入前 version = N，插入后 | version = N + 1 | P0 |
| A-3.6 | SSE 事件 | POST 后 | 收到 `idea:block-create` + `idea:content-change` | P0 |
| A-3.7 | Fractional indexing 精度 | 连续 60 次在同一位置后插入 | 所有 block order 严格递增，无精度坍缩（或自动 reindex） | P1 |

### 4. PUT /api/ideas/:ideaId/blocks/batch（新增）

| ID | 用例 | 操作 | 预期结果 | 优先级 |
|----|------|------|---------|--------|
| A-4.1 | 混合操作 | `[{op:"update",blockId,content:"x"},{op:"create",type:"paragraph",content:"y\n"},{op:"delete",blockId2}]` | 三个操作全部执行；Idea.content 一致 | P0 |
| A-4.2 | 事务回滚 | batch 包含一个对不存在 block 的 update | 全部回滚，无 block 变更，无 version 递增 | P0 |
| A-4.3 | 空操作列表 | `{ operations: [] }` | 200 成功，无变更 | P1 |
| A-4.4 | 大批量 | 50 个 create 操作 | 全部成功，content 拼接一致 | P1 |
| A-4.5 | SSE 事件 | batch 成功后 | 收到每个操作对应的 block 级 SSE + 一次 content-change | P0 |

### 5. 现有 API 向后兼容

| ID | 用例 | 操作 | 预期结果 | 优先级 |
|----|------|------|---------|--------|
| A-5.1 | PUT /content 仍可用 | `PUT /api/ideas/:id` 发送完整 Markdown | Idea.content 更新；blocks 表 sync 一致 | P0 |
| A-5.2 | POST /write 仍可用 | 用 anchor 模式追加一段 | 新 block 出现在 blocks 表；content 一致 | P0 |
| A-5.3 | GET /api/ideas/:id 返回 content | 请求 | 返回由 blocks 重建的 content，与直接拼接一致 | P0 |
| A-5.4 | DELETE /api/ideas/:id CASCADE | 删除 idea | 所有 blocks 级联删除；mentions 级联删除 | P0 |
| A-5.5 | 混合路径一致性 | 先用 block API 改一个 block，再用 PUT /content 全量保存另一个版本 | blocks 表与最后的 content 一致 | P0 |

### 6. MCP 工具

| ID | 用例 | 操作 | 预期结果 | 优先级 |
|----|------|------|---------|--------|
| A-6.1 | create_idea_block | 调用 MCP 工具在 idea 中间插入一个 heading | block 创建成功；Idea.content 包含新 heading | P0 |
| A-6.2 | batch_update_idea_blocks | 调用 MCP 工具同时 create 2 个 + delete 1 个 | 三个操作全部执行 | P0 |
| A-6.3 | 旧工具 append_to_idea | 调用旧的 append 工具追加段落 | 内部走 POST /write → sync blocks，结果一致 | P0 |
| A-6.4 | 旧工具 insert_into_idea | 用 section anchor 插入 | 插入成功，block 表对应更新 | P0 |
| A-6.5 | 旧工具 replace_idea_content | 整段替换 | 替换成功，block 表全量 re-sync | P0 |
| A-6.6 | begin/end_idea_stream_write | Agent 流式写入一段内容 | finalize 后 block 表新增对应 block；SSE 广播 block-create | P1 |
| A-6.7 | delete_idea_block（现有） | 删除一个 block | block 删除；content 重建无该段；mention 清理 | P0 |
| A-6.8 | move_idea_block（现有） | 移动一个 block 到新位置 | order 更新；content 重建顺序变更 | P0 |

### 7. Content 重建一致性（交叉验证）

| ID | 用例 | 操作 | 预期结果 | 优先级 |
|----|------|------|---------|--------|
| A-7.1 | 空文档 | 创建空 idea（无 block） | Idea.content === ""；blocks 列表为空 | P0 |
| A-7.2 | 单段落 | idea 只有一个 paragraph block | content 精确等于该 block.content | P0 |
| A-7.3 | 复杂文档 | 包含 heading + paragraph + code + list + table + blockquote + hr | blocks 按 order 拼接 === content；无丢失、无重复 | P0 |
| A-7.4 | 含空行的文档 | 段落间有 2-3 个空行 | 空行保留在 block content 中，拼接后与原始 content 一致 | P0 |
| A-7.5 | 含 HTML 的文档 | 包含 `<div>` 内联 HTML block | HTML block 正确保持为独立 block | P1 |
| A-7.6 | 含 mention 的文档 | 段落包含 `[@表名](mention://table/xxx)` | mention 解析正确；mention 表行存在；删除段落后 mention 行也删除 | P0 |

---

## PR-B：前端 Preview 模式 Block 编辑

### 8. BlockList 渲染

| ID | 用例 | 操作 | 预期结果 | 优先级 |
|----|------|------|---------|--------|
| B-8.1 | 正常渲染 | 打开一篇含 heading + paragraph + code + list 的 idea，Preview 模式 | 每个 block 独立渲染，排版与旧 Tiptap 一致 | P0 |
| B-8.2 | 空文档 | 打开空 idea，Preview 模式 | 显示 placeholder 提示文字 | P0 |
| B-8.3 | 大文档虚拟化 | 打开 200+ block 的文档 | viewport 外的 block 不创建 Tiptap 实例；滚动流畅（无卡顿） | P1 |
| B-8.4 | Block 类型图标 | hover 每个 block | 左侧显示对应类型的 ⋮ 菜单 handle | P1 |

### 9. Block 点击编辑

| ID | 用例 | 操作 | 预期结果 | 优先级 |
|----|------|------|---------|--------|
| B-9.1 | 段落编辑 | 点击一个 paragraph block | 原地变为 Tiptap inline editor，光标出现，可输入 | P0 |
| B-9.2 | 标题编辑 | 点击 heading | 原地可编辑，保留 heading 样式（字号/字重） | P0 |
| B-9.3 | 代码块编辑 | 点击 code block | 打开 CodeMirror mini 编辑器（有语法高亮） | P0 |
| B-9.4 | 列表编辑 | 点击 list block | 可编辑列表项，Enter 新增项，Backspace 在空行合并 | P0 |
| B-9.5 | 表格编辑 | 点击 table block | 打开编辑 UI（V2 可以是 textarea 展示 markdown） | P1 |
| B-9.6 | HR / divider | 点击分割线 | 不进入编辑态（只显示 hover handle 供删除/移动） | P1 |

### 10. Block 编辑保存

| ID | 用例 | 操作 | 预期结果 | 优先级 |
|----|------|------|---------|--------|
| B-10.1 | blur 保存 | 编辑一个段落，点击其他 block | 旧 block 自动保存（PATCH API），新 block 进入编辑态 | P0 |
| B-10.2 | 无变更不保存 | 点击 block 进入编辑态，不修改内容，blur | 不发 PATCH 请求 | P0 |
| B-10.3 | Escape 取消 | 编辑修改后按 Escape | 内容回退到修改前，不发 PATCH | P0 |
| B-10.4 | Cmd+S 保存 | 编辑中按 Cmd+S | 立即 PATCH 保存当前 block | P1 |
| B-10.5 | 并发冲突处理 | 两个 tab 编辑同一 block，后者 PATCH 收到 409 | 显示 toast "内容已被更新"，回退到服务端版本 | P0 |
| B-10.6 | 保存后 content 一致 | PATCH 成功后，刷新页面 | Idea.content === 所有 blocks 拼接 | P0 |

### 11. Block 跨块操作

| ID | 用例 | 操作 | 预期结果 | 优先级 |
|----|------|------|---------|--------|
| B-11.1 | Enter 在段落末尾 | 段落末尾按 Enter | 在当前 block 下方创建新的空 paragraph block（POST API） | P0 |
| B-11.2 | Backspace 在空 block | 空 block 内按 Backspace | 删除当前 block（DELETE API），光标移到上一个 block 末尾 | P0 |
| B-11.3 | Arrow Up/Down 跨 block | 在 block 首行按 ↑ / 末行按 ↓ | 光标跳到上/下一个 block 对应位置 | P0 |
| B-11.4 | 拖拽排序 | 拖动 block handle 到新位置 | 发 MOVE API；UI 即时反映新顺序 | P1 |
| B-11.5 | 删除 block | 点 ⋮ 菜单 → 删除 | 发 DELETE API；block 消失；content 重建 | P0 |

### 12. Source 模式兼容

| ID | 用例 | 操作 | 预期结果 | 优先级 |
|----|------|------|---------|--------|
| B-12.1 | Preview → Source 切换 | 在 Preview 编辑一个 block 后切换到 Source | CodeMirror 显示完整 Markdown（包含刚编辑的内容） | P0 |
| B-12.2 | Source → Preview 切换 | 在 Source 模式修改文本后切换到 Preview | 每个 block 渲染更新后的内容 | P0 |
| B-12.3 | Source 保存 → blocks sync | Source 模式保存后（PUT /content） | blocks 表 re-sync；切换 Preview 后各 block 正确 | P0 |
| B-12.4 | Toggle 锁定 | Preview 模式 block 编辑中 | ⌘/ 切换按钮 disabled，无法切换 | P0 |

### 13. SSE 同步（Preview 模式）

| ID | 用例 | 操作 | 预期结果 | 优先级 |
|----|------|------|---------|--------|
| B-13.1 | 收到 block-update | 另一个 tab PATCH 了 block A | 当前 tab 的 block A 内容自动更新（非编辑中） | P0 |
| B-13.2 | 收到 block-create | 另一个 tab 在 block B 后插入新 block | 当前 tab 在对应位置出现新 block | P0 |
| B-13.3 | 收到 block-delete | 另一个 tab 删除 block C | 当前 tab 的 block C 消失 | P0 |
| B-13.4 | 收到 block-move | 另一个 tab 移动 block D 到新位置 | 当前 tab 的 block D 移到新位置 | P1 |
| B-13.5 | 反回声 | 自己的修改不触发自身 SSE 更新 | 不出现内容闪烁或 toast | P0 |
| B-13.6 | 编辑中收到同 block 更新 | 正在编辑 block A 时收到另一个 tab 的 block-update(A) | 不覆盖当前编辑（延迟到 blur 后合并），或显示冲突提示 | P0 |

---

## PR-C：SSE Block Delta + 多人协同

### 14. 多人编辑场景

| ID | 用例 | 操作 | 预期结果 | 优先级 |
|----|------|------|---------|--------|
| C-14.1 | 两人改不同 block | Tab A 改 block1，Tab B 改 block2 | 两者互不干扰；各收到对方的 block-update；最终 content 包含两者修改 | P0 |
| C-14.2 | 两人改同一 block | Tab A 和 Tab B 同时改 block1 | 先到者成功，后到者 409 → 回退到服务端版本 + toast | P0 |
| C-14.3 | Source + Preview 混用 | Tab A 用 Source 模式保存全量，Tab B 在 Preview 编辑 | Tab B 收到 content-change → blocks 刷新；Tab A 收到 block-* 事件 | P0 |
| C-14.4 | Agent + 人类同时编辑 | Agent 用 create_idea_block 插入，人类在 Preview 编辑另一个 block | Agent 的 block 出现在 Preview；人类的 block 保存不受影响 | P0 |
| C-14.5 | Agent stream + 人类查看 | Agent 通过 stream write 写入新段落，人类 Preview 观看 | 人类看到实时增量（stream delta → block-create 事件） | P1 |

### 15. SSE 事件精简（PR-C 目标）

| ID | 用例 | 操作 | 预期结果 | 优先级 |
|----|------|------|---------|--------|
| C-15.1 | block 写入不重复广播 | PATCH 一个 block | 只收到 `idea:block-update`；`idea:content-change` 仅旧版 FE 需要时发 | P1 |
| C-15.2 | Source 保存广播全量 | PUT /content | 广播 `idea:content-change`（给 Source 模式用户）+ 各 block 级事件（给 Preview 用户） | P0 |
| C-15.3 | 断线重连 | SSE 断线后重连 | 全量 sync（拉最新 blocks + content），不丢失中间变更 | P0 |

### 16. 边界场景

| ID | 用例 | 操作 | 预期结果 | 优先级 |
|----|------|------|---------|--------|
| C-16.1 | 超大文档 | 1000+ 个 block 的 idea | 首屏加载 < 2s；block 级 PATCH < 200ms（含 content 重建） | P1 |
| C-16.2 | 极深嵌套（V2 预留） | parentId 链 > 5 层 | 正常渲染和编辑（V1 阶段所有 parentId = null） | P2 |
| C-16.3 | 并发 reindex | 两个用户同时在同一位置连续插入 | fractional indexing 不坍缩；必要时自动 reindex | P1 |
| C-16.4 | 网络断开再恢复 | 编辑 block → 网络断开 → 恢复 → 再 PATCH | PATCH 成功或收到 409（version 已变）→ 合理处理 | P1 |
| C-16.5 | 浏览器刷新 | 编辑 block 后立刻刷新（未 blur） | 编辑丢失（可接受）；刷新后显示最后保存的版本 | P0 |

---

## 测试统计

| 阶段 | P0 | P1 | P2 | 总计 |
|------|----|----|----|----|
| PR-A（后端） | 25 | 10 | 0 | 35 |
| PR-B（前端） | 18 | 7 | 0 | 25 |
| PR-C（协同） | 7 | 5 | 1 | 13 |
| **总计** | **50** | **22** | **1** | **73** |
