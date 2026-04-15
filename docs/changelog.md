# AI Filter 更新日志

## 格式说明
每条记录包含：日期、commit hash、改动类型（feat/fix/style/docs）、改动说明。

---

## 2026-04-15

### fix: undo 后端不同步问题修复
- **commit**: `96d05aa`
- **改动点**: 修复 undo 操作前端生效但后端未同步的问题
- **详细说明**:
  1. `api.ts`：`updateRecord`/`deleteRecords`/`batchCreateRecords` 增加 `res.ok` 检查，后端 4xx/5xx 不再静默吞掉
  2. `performUndo`：所有后端调用改为 `await`，失败时回退前端状态并 toast 提示 "撤销失败，数据未能同步，请刷新页面"
  3. `executeDelete`：通过 `deletePendingRef` 追踪删除 Promise，`performUndo` 执行前先 await，防止竞态条件（undo 在删除未完成时触发导致 batchCreate 先于 batchDelete）
  4. `handleCellChange`/`executeClearCells`：后端失败时回退乐观更新 + toast 提示

### feat: 增加请求日志中间件
- **commit**: `c905156`
- **改动点**: 所有 API 请求增加结构化日志
- **详细说明**: `index.ts` 新增中间件，记录 method、path、clientId、请求体（mutation）、响应状态码、耗时、响应摘要。SSE 和 health 端点跳过详细日志

### feat: 实时数据同步（SSE）
- **commit**: `c241340`
- **改动点**: 实现多标签页和多用户实时数据同步
- **详细说明**:
  - 新增 `eventBus.ts`：Node.js EventEmitter 事件总线，按 tableId 作用域
  - 新增 `sseRoutes.ts`：SSE 端点 `GET /api/sync/:tableId/events?clientId=xxx`，30 秒心跳
  - `tableRoutes.ts`：13 个变更端点添加 `eventBus.emitChange()`
  - `api.ts`：导出 `CLIENT_ID` + `mutationFetch` 包装函数注入 `X-Client-Id` 头
  - 新增 `useTableSync.ts`：前端 SSE 订阅 Hook，防回声 + 断线重连全量同步
  - `App.tsx`：12 个远程事件处理函数，远程变更不入 undo 栈
  - Nginx 配置 SSE location block（`proxy_buffering off`）

### fix: 输入框图标顺序与 Loading 截断优化
- **commit**: `e373adb`
- **改动点**: FilterPanel AI 输入框有文本时，叉号(X)和麦克风(🎤)图标互换位置；Loading 动效省略号距输入框右边保持 12px 间距
- **详细说明**: 有文本输入后图标顺序调整为 ✕ → 🎤 → ↑，符合「先清除、再语音、最后发送」的操作优先级。LoadingDots 组件设置 `flex-shrink: 0` 防止压缩，`.fp-ai-loading-text` 增加 `padding-right: 12px`

### fix: LoadingDots 作为截断标识，移除重复省略号
- **commit**: `45a352d`
- **改动点**: Loading 状态文本过长时，移除 CSS `text-overflow: ellipsis` 静态省略号，改用 LoadingDots 动画直接作为截断符
- **详细说明**: 之前长文本截断会同时显示 CSS 静态省略号和 LoadingDots 动态省略号。修改为 `.fp-ai-loading-query` 只用 `overflow: hidden` 裁剪文字，LoadingDots 紧跟其后作为唯一截断指示器

### fix: Loading 文本过长时省略号截断
- **commit**: `13a0d0d`
- **改动点**: "Generating filter by ..." Loading 文本超长时用省略号截断
- **详细说明**: 将 Loading 文字部分包裹在 `.fp-ai-loading-query` span 中（`flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis`），LoadingDots 保持在外部作为 flex 兄弟元素

### fix: AI 筛选输入框长文本截断
- **commit**: `1a8a6f8`
- **改动点**: 输入框文本过长时单行截断显示，不换行
- **详细说明**: `.fp-ai-input` 添加 `overflow: hidden; text-overflow: ellipsis; white-space: nowrap`。`.fp-ai-loading` 和 `.fp-ai-loading-text` 添加 `min-width: 0` 支持 flex 子元素截断

---

## 2026-04-14

### fix: 清空行单元格英文文案
- **commit**: `e924ad9`
- **改动点**: 确认弹窗和 Toast 统一使用英文文案
- **详细说明**: 弹窗标题 "Clear Records"，正文 "Are you sure you want to clear all cells of N record(s)?"，确认按钮 "Clear"。Toast 显示 "Cleared N records"（区别于单元格清空的 "Cleared N cells"）。`executeClearCells` 增加可选 `toastLabel` 参数

### fix: 清空记录单元格中文文案 + 确认后复选框恢复未选中
- **commit**: `e101029`
- **改动点**: 初始中文文案实现 + 确认清空后复选框自动取消勾选
- **详细说明**: TableView 新增 `clearRowSelection()` imperative method，App.tsx 在 `handleConfirmDelete` 和 `handleClearRowCells`（无 deleteProtection 时）调用

### feat: 复选框+Delete 清空行单元格，右键删除行
- **commit**: `f880b9e`
- **改动点**: 区分两种删除行为——复选框选中行 + Delete 键清空单元格（受 Safety Delete 管控），右键删除行删除记录（受 Safety Delete 管控）
- **详细说明**: 
  - TableView 新增 `onClearRowCells` prop，键盘 handler Priority 1 改为收集选中行所有可编辑单元格并调用 `onClearRowCells`
  - App.tsx 新增 `handleClearRowCells`：deleteProtection 开启时弹确认框（type: "rowCells"），关闭时直接执行
  - ConfirmDialog 新增 `"rowCells"` 类型，独立文案
  - 拖选单元格 + Delete 仍通过 `onClearCells` 直接执行（不受 Safety Delete 管控）

### fix: 键盘 handler 使用 ref 防止闭包过期
- **commit**: `72faa89`
- **改动点**: `selectedRowIds` 和 `cellRange` 使用 ref 同步最新状态
- **详细说明**: 添加 `selectedRowIdsRef` 和 `cellRangeRef`，每次渲染同步 `current` 值。键盘事件 handler 从 ref 读取（而非闭包捕获值），消除 checkbox click 与 Delete keydown 之间的竞态条件。useEffect deps 移除 `selectedRowIds` 和 `cellRange`

### fix: 首次启动 seed mock 数据，后续启动不覆盖
- **commit**: `adec6bc`
- **改动点**: 服务器启动时检查表是否已存在，不重复 seed
- **详细说明**: `backend/src/index.ts` 中 `loadTable(mockTable)` 改为先调用 `getTable(mockTable.id)` 检查，已存在则跳过。解决每次部署/重启后用户数据被覆盖的问题

### feat: 右键单元格选区显示删除覆盖行
- **commit**: `bb4dae2`
- **改动点**: 在单元格选区范围内右键时，「删除记录」选项作用于选区覆盖的所有行
- **详细说明**: `handleRowContextMenu` 增加 `cellRange` 判断，收集选区内 `minRow ~ maxRow` 范围所有行 ID

### fix: 复选框 + Delete 键正常工作
- **commit**: `94512a6`
- **改动点**: 修复勾选复选框后 Delete 键不生效的问题
- **详细说明**: 键盘 handler 中 INPUT 标签检查改为 `target.type !== "checkbox"` 放行复选框。`handleRowCheckChange` 和 `handleHeaderCheckChange` 调用 `setCellRange(null)` 清除单元格选区

### feat: Delete 键删除选中行/清空选中单元格
- **commit**: `9017f85`
- **改动点**: Delete/Backspace 键行为——行选择态删除行（Safety Delete），单元格选择态清空单元格（无确认）
- **详细说明**: 键盘 handler 优先级：selectedRowIds > cellRange。行删除走 `onDeleteRecords`，单元格清空走 `onClearCells`

### fix: 单元格编辑和清空持久化到后端
- **commit**: `d6c7e4a`
- **改动点**: `handleCellChange` 和 `executeClearCells` 增加 `updateRecord` API 调用
- **详细说明**: 乐观更新后异步调用 `updateRecord(TABLE_ID, recordId, cells)`，解决编辑/清空后刷新数据丢失的问题

### feat: 单元格拖选、Delete 清空、双击编辑、Undo
- **commit**: `0dc091e`
- **改动点**: 完整的单元格交互体系
- **详细说明**:
  - `CellRange` 模型：mousedown 起点 → mousemove 4px 阈值拖选 → mouseup 确认
  - `<td>` 绑定 `data-row-idx` / `data-col-idx`，`elementFromPoint` 获取目标
  - 双击进编辑、单击已选中单元格再次点击进编辑（`wasAlreadySelected`）
  - `justCellDraggedRef` 防止拖选后误触编辑
  - UndoItem 新增 `"cellEdit"` 和 `"cellBatchClear"` 类型

### feat: Safety Delete 文档级持久化
- **commit**: `c0c3b04`
- **改动点**: 安全删除开关存储在 localStorage（key: `doc_delete_protection`），默认开启
- **详细说明**: TopBar 中 Toggle 控件绑定 `deleteProtection` 状态，写入时同步 localStorage

### feat: 多步撤销栈、批量字段操作、语音改进、Shift 选择
- **commit**: `eee19be` (via merge `484333b`)
- **改动点**: 完整的撤销系统 + 批量字段删除/恢复 + 语音 Grace Period + Shift+Click 行选择
- **详细说明**:
  - `undoStackRef` 栈最多 20 项，支持 records / fields / cellEdit / cellBatchClear 四种类型
  - 字段删除快照包含字段定义、单元格数据、视图配置、筛选条件
  - 语音停止后 800ms Grace Period 等待最后结果
  - Shift+Click 行选择范围

### feat: 记录删除与撤销 + 上下文菜单
- **commit**: `0fbac86`
- **改动点**: 右键行上下文菜单 + 记录删除 + Toolbar Undo 按钮
- **详细说明**: 右键菜单定位、删除确认、Toast Undo action

### feat: Toast 通知 + 精确日期选择器 + AI 筛选反馈
- **commit**: `9deaf77`
- **改动点**: Toast 组件系统、DatePicker 绝对日期、AI 筛选 loading/error 状态
- **详细说明**: `ToastProvider` + `useToast()` hook，Toast 支持 action 按钮

---

## 2026-04-13

### feat: 语音输入
- **commit**: `67b7548`, `0b079cd`
- **改动点**: AI 筛选输入支持语音输入（Web Speech API）
- **详细说明**: 麦克风按钮 + 长按空格 500ms 触发，zh-CN 识别，Grace Period 800ms

### feat: 字段配置面板
- **commit**: `e874f25`, `33af631`, `b2e1b4c`
- **改动点**: Customize Field 面板，支持拖拽排序、搜索（拼音）、隐藏/显示字段、点击定位
- **详细说明**: `FieldConfigPanel` + `pinyin-pro` 模糊搜索 + `scrollIntoView` 定位

### feat: 拼音模糊搜索 + Mock 数据扩展
- **commit**: `9995b9d`
- **改动点**: 筛选面板字段下拉支持拼音搜索，mock 数据扩展到更多字段

### feat: AI 筛选查询回显
- **commit**: `238e584`
- **改动点**: AI 生成完成后，查询文本保留在输入框中作为 placeholder

### fix: 视图设置跨重启保持
- **commit**: `f1856f2`
- **改动点**: fieldOrder、hiddenFields 持久化到后端，服务重启不丢失

### feat: Lookup 字段（Phase 0-2）
- **commit**: `4895195`, `5667e34`, `5cde1a8`
- **改动点**: Lookup 字段数据模型、计算引擎、前端配置 UI

### feat: PostgreSQL + Prisma 迁移
- **commit**: `312c043`
- **改动点**: 从内存存储迁移到 PostgreSQL + Prisma ORM
- **详细说明**: JSONB 存储 fields/views/cells，GIN 索引加速查询

### 初始提交
- **commit**: `e33c994`
- **改动点**: 项目初始化——AI Filter for Lark Base clone
- **详细说明**: Express 后端 + React 前端 + Volcano ARK API 集成，基础表格视图 + 筛选面板 + AI 筛选生成
