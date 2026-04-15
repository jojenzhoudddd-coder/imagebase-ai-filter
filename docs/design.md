# AI Filter 系统设计文档

## 1. 产品概述

AI Filter 是一个飞书多维表格（Lark Base）克隆项目，核心亮点是**AI 智能筛选**——用户通过自然语言描述即可生成结构化筛选条件。系统采用前后端分离架构，前端 React + TypeScript，后端 Express + PostgreSQL + Prisma。

### 1.1 目标用户
- 需要管理结构化数据的团队成员（PM、研发、测试）
- 不熟悉复杂筛选条件语法的普通用户

### 1.2 核心价值
- 自然语言 → 结构化筛选，降低使用门槛
- 多字段类型支持，覆盖主流数据管理场景
- 撤销/重做保障操作安全性

---

## 2. 功能模块

### 2.1 表格视图（TableView）

#### PRD
- 展示字段列头和数据记录行的二维网格
- 支持列宽拖拽调整、列头拖拽排序
- 支持单元格内联编辑（文本、数字、单选、多选、用户、日期、复选框）
- 支持行号列、自增序号列、添加字段列、添加记录行

#### 技术方案
- 组件：`TableView/index.tsx`，使用 `<table>` 原生标签 + CSS 控制布局
- 列宽持久化：`localStorage` 存储 `col_widths_v1`
- 列顺序：App.tsx 维护 `viewFieldOrder`，通过 `onFieldOrderChange` 回调同步
- 内联编辑器：`EditableCell` 根据字段类型渲染不同编辑组件（TextEditor / SelectEditor / UserEditor / DateEditor）

#### Edge Cases
| 场景 | 处理逻辑 |
|------|----------|
| 列宽拖到最小值 | 限制最小宽度 `MIN_COL_WIDTH = 60px` |
| 拖拽列排序时释放在原位 | `justDraggedRef` 检测 4px 阈值，未超过则不触发重排 |
| 编辑单元格时点击其他单元格 | 退出当前编辑态，选中新单元格（`if (editing) setEditing(null)` 后继续处理） |
| 只读字段（AutoNumber, CreatedTime, ModifiedTime）| 双击不进入编辑态，Delete 键跳过这些字段 |
| Checkbox 字段 | 单击直接切换值（不进入编辑态），双击无效 |
| 拖拽排序与列宽调整冲突 | 列宽调整 handle 上 `e.stopPropagation()` 阻止冒泡到拖拽逻辑 |

---

### 2.2 单元格选择与操作

#### PRD
- 单击选中单个单元格（蓝色高亮）
- 鼠标拖拽选中矩形单元格区域
- 再次点击已选中单元格进入编辑态
- Delete/Backspace 键清空选中单元格内容（无确认弹窗）
- 复选框选中行 + Delete 键：清空该行所有单元格（受 Safety Delete 管控）
- 复选框选中行 + 右键删除：删除整行记录（受 Safety Delete 管控）

#### 技术方案
- 选区模型：`CellRange { startRowIdx, startColIdx, endRowIdx, endColIdx }`
- 拖拽检测：`mousedown` 记录起点 → `mousemove` 超过 4px 阈值开始拖选 → `mouseup` 确认
- `<td>` 上绑定 `data-row-idx` / `data-col-idx`，拖拽时用 `elementFromPoint` 获取目标单元格
- 键盘事件通过 `document.addEventListener("keydown")` 全局监听
- **防止闭包过期**：`selectedRowIdsRef` / `cellRangeRef` 同步最新状态，键盘 handler 从 ref 读取

#### Edge Cases
| 场景 | 处理逻辑 |
|------|----------|
| 拖选时拖到表格外 | `elementFromPoint` 返回 null，忽略该 move 事件 |
| 拖选后立即单击同一单元格 | `justCellDraggedRef` 防止拖选结束后误触发编辑 |
| 选中单元格后再勾选复选框 | `handleRowCheckChange` 调用 `setCellRange(null)` 清除单元格选区 |
| 勾选复选框后再选择单元格 | `handleCellMouseDown` 中 `setSelectedColIds(new Set())` 清除列选择 |
| 编辑态中按 Delete | `!editing` guard 阻止，不清空单元格 |
| 焦点在 INPUT（非 checkbox）或 TEXTAREA 时按 Delete | handler 直接 return，不拦截浏览器原生行为 |
| 复选框选中行 + Delete 后 | 复选框恢复未选中（`clearRowSelection()`） |

---

### 2.3 行选择与删除

#### PRD
- 悬浮行号列显示复选框，点击勾选单行
- Shift+Click 范围选择多行
- 表头复选框全选/全不选
- 右键上下文菜单提供「删除记录」选项
- 删除受 Safety Delete 开关管控

#### 技术方案
- `selectedRowIds: Set<string>` 状态管理已选行
- Shift+Click：记录 `lastClickedRowRef`，计算范围内所有行 ID
- 右键菜单：`handleRowContextMenu` 判断右键行是否在已选集合中，若在则操作所有已选行，否则只操作右键行
- 右键在单元格选区内：收集选区覆盖的所有行用于删除

#### Edge Cases
| 场景 | 处理逻辑 |
|------|----------|
| 删除后记录数变化 | `useEffect([records])` 清理 `selectedRowIds` 中已不存在的 ID |
| 全选后删除部分记录 | 自动从全选态退出为部分选择态 |
| 右键菜单打开时滚动/点击外部 | `mousedown` 外部事件关闭所有上下文菜单 |
| 右键点击未选中行 | 只删除右键对应行，不影响已选择的行 |

---

### 2.4 撤销系统（Undo）

#### PRD
- 支持最多 20 步撤销（`MAX_UNDO = 20`）
- 快捷键 Ctrl+Z / ⌘+Z
- 删除记录后 Toast 中提供「Undo」按钮
- 支持四种撤销类型：删除记录、删除字段、编辑单元格、批量清空单元格

#### 技术方案
- `undoStackRef = useRef<UndoItem[]>([])`，超过 MAX_UNDO 时 shift 最旧项
- UndoItem 联合类型：
  - `"records"`: 快照完整记录 + 原始索引
  - `"fields"`: 快照字段定义 + 单元格数据 + 视图配置 + 筛选条件
  - `"cellEdit"`: 单个单元格 oldValue / newValue
  - `"cellBatchClear"`: 多个单元格的 oldValue 列表
- 撤销时调用对应 API（batchCreateRecords / batchRestoreFields / updateRecord）

#### Edge Cases
| 场景 | 处理逻辑 |
|------|----------|
| 在 INPUT/TEXTAREA 中按 Ctrl+Z | 不拦截，让浏览器原生 undo 生效 |
| API 调用失败的撤销 | 删除操作 catch 中 pop undo 栈并恢复 UI |
| 撤销字段删除后筛选条件恢复 | 快照中保存了 `removedConditions` 和 `removedSavedConditions`，恢复时合并回 filter |
| 撤销栈已满再新增 | `pushUndo` 中 `while (stack.length >= MAX_UNDO) stack.shift()` |
| 页面刷新 | 撤销栈丢失（存在 ref 中，设计上接受此行为） |

---

### 2.5 AI 智能筛选

#### PRD
- 输入框位于 FilterPanel 顶部，支持自然语言输入
- 按 Enter 或点击发送按钮提交
- 流式返回（SSE）：显示 thinking 状态 → 显示筛选结果
- 支持拼音模糊匹配字段名和操作符
- 支持相对日期表达（今天、本周、上月等）
- 生成失败时显示错误提示

#### 技术方案
- 前端：`api.ts` 中 `generateFilter()` 使用 `fetch` + `ReadableStream` 解析 SSE
- 后端：`aiRoutes.ts` 接收请求 → `aiService.ts` 调用 Anthropic Claude API
- System Prompt 包含字段表、操作符映射、拼音规则、日期值规则
- 响应格式：`event: thinking/result/error/done`
- AI 日志写入 `backend/logs/AI 日志.log`（GMT+8 时间戳）

#### Edge Cases
| 场景 | 处理逻辑 |
|------|----------|
| 查询过程中用户取消 | `AbortController.abort()` 中断请求 |
| AI 返回不存在的字段 ID | 前端跳过该条件（不 crash） |
| 输入框文本过长 | CSS `overflow: hidden; text-overflow: ellipsis` 截断显示 |
| Loading 文本过长 | 文字截断裁剪，LoadingDots 动画作为截断标识（无静态省略号） |
| 网络超时 | SSE stream error → 显示错误 toast |
| 空查询 | 前端不发送请求（`query.trim()` 检查） |

---

### 2.6 语音输入

#### PRD
- FilterPanel 中提供麦克风按钮
- 长按空格键（500ms）触发语音识别
- 识别结果自动填入输入框
- 支持中文识别（zh-CN）

#### 技术方案
- Web Speech API（`SpeechRecognition`），`lang: "zh-CN"`
- 长按检测：`keydown` 开始计时，`keyup` 在 500ms 内则取消
- 停止后 800ms Grace Period 等待最后结果
- 状态：`isListening` / `isStopping` 控制 UI 反馈

#### Edge Cases
| 场景 | 处理逻辑 |
|------|----------|
| 浏览器不支持 Speech API | `speechSupported` 为 false，不渲染麦克风按钮 |
| 语音识别中途用户手动输入 | 输入框设为 `readOnly` 防止冲突 |
| 识别结果为空 | 不更新输入框内容 |
| 快速按放空格 | 未达 500ms 阈值，不触发语音 |

---

### 2.7 筛选条件管理

#### PRD
- 手动添加/删除筛选条件
- 每个条件包含：字段、操作符、值
- 操作符根据字段类型动态变化
- 条件间支持 AND / OR 逻辑切换
- 筛选状态显示在 ViewTabs 上（Filter configured 标签）
- 支持保存/清除筛选

#### 技术方案
- `FilterRow.tsx` 渲染单条条件
- 操作符映射表按字段类型分组（Text, Number, DateTime, Select, Checkbox 等）
- 值输入根据类型渲染不同控件：文本框、数字框、下拉选择、日期选择器
- 前端客户端侧筛选：`filterEngine.ts` 中 `filterRecords()` 纯函数

#### Edge Cases
| 场景 | 处理逻辑 |
|------|----------|
| 条件不完整（无值） | `isEmpty` / `isNotEmpty` 操作符无需值，其他操作符跳过该条件 |
| 删除字段后筛选条件引用该字段 | 字段删除级联清除对应筛选条件 |
| 多选字段的 `contains` 操作 | 检查记录值数组是否包含目标选项 |
| 日期字段的相对日期 | 运行时计算相对日期范围（如 "本周" → 当前周一到周日） |
| 切换 AND / OR | 重新执行客户端筛选，立即更新表格 |

---

### 2.8 字段配置（Field Config）

#### PRD
- 侧滑面板管理字段顺序和可见性
- 拖拽排序字段
- 搜索字段（支持拼音模糊匹配）
- 点击字段名滚动定位到表格对应列

#### 技术方案
- `FieldConfigPanel/index.tsx`
- 拖拽排序使用 HTML5 drag-and-drop API
- 搜索使用 `pinyin-pro` 库进行拼音匹配
- 列滚动使用 `scrollIntoView({ behavior: "smooth" })`

#### Edge Cases
| 场景 | 处理逻辑 |
|------|----------|
| 隐藏所有字段 | 至少保留主字段（isPrimary）不可隐藏 |
| 搜索无匹配 | 显示空状态 |
| 拖拽排序包含隐藏字段 | `viewFieldOrder` 包含全部字段 ID（含隐藏），排序对隐藏字段也生效 |

---

### 2.9 Safety Delete（安全删除）

#### PRD
- 文档级开关，控制删除操作是否需要二次确认
- 持久化到 `localStorage`（key: `doc_delete_protection`）
- 受管控操作：删除记录、删除字段、清空行单元格
- 不受管控操作：拖选单元格 + Delete（直接执行，靠 Undo 保障）

#### 技术方案
- `deleteProtection` 状态 + `setDeleteProtection` 写入 localStorage
- `ConfirmDialog` 组件弹窗确认
- 三种弹窗类型：`"records"` / `"fields"` / `"rowCells"`
- `"rowCells"` 类型标题 "Clear Records"，文案 "clear all cells of N record(s)"

#### Edge Cases
| 场景 | 处理逻辑 |
|------|----------|
| 关闭安全删除后立即删除 | 直接执行，不弹窗 |
| 弹窗中取消 | 关闭弹窗，不执行操作 |
| 清空行单元格确认后 | 复选框恢复未选中（`clearRowSelection()`） |
| 新用户首次打开 | 默认开启（`localStorage` 无值时默认 `true`） |

---

### 2.10 Toast 通知

#### PRD
- 支持 success / error / warning / info 四种级别
- 可选 action 按钮（如 "Undo"）
- 自动消失（可配置 duration）
- 固定在页面顶部居中

#### 技术方案
- `ToastProvider` context + `useToast()` hook
- CSS 动画：`toast-enter` / `toast-leave`
- 多个 toast 堆叠显示

---

## 3. 数据模型

### 3.1 核心类型

```
Table
├── id, name
├── fields: Field[]
├── views: View[]
├── autoNumberCounters: Record<string, number>
└── records: Record[]

Field
├── id, tableId, name, type: FieldType, isPrimary
└── config: { options?, users?, format?, includeTime? }

Record
├── id, tableId
├── cells: Record<string, CellValue>
└── createdAt, updatedAt

View
├── id, tableId, name, type
├── filter: ViewFilter { logic, conditions[] }
├── sort, group
└── fieldOrder?, hiddenFields?
```

### 3.2 字段类型

| 类型 | 值格式 | 操作符 |
|------|--------|--------|
| Text | string | eq, neq, contains, notContains, isEmpty, isNotEmpty |
| Number | number | eq, neq, gt, gte, lt, lte, isEmpty, isNotEmpty |
| SingleSelect | string | eq, neq, contains, notContains, isEmpty, isNotEmpty |
| MultiSelect | string[] | contains, notContains, isEmpty, isNotEmpty |
| DateTime | string (ISO) | eq, before, after, isEmpty, isNotEmpty |
| Checkbox | boolean | checked, unchecked |
| User | string | eq, neq, contains, notContains, isEmpty, isNotEmpty |
| AutoNumber | number | (只读，不可编辑/筛选) |
| CreatedTime | number (timestamp) | (只读，自动生成) |
| ModifiedTime | number (timestamp) | (只读，自动更新) |

---

## 4. 接口设计

### 4.1 REST API

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/tables/:tableId/fields` | 获取字段列表 |
| GET | `/api/tables/:tableId/records` | 获取记录列表 |
| GET | `/api/tables/:tableId/views` | 获取视图列表 |
| PUT | `/api/tables/:tableId/records/:recordId` | 更新记录单元格 |
| POST | `/api/tables/:tableId/records/batch-delete` | 批量删除记录 |
| POST | `/api/tables/:tableId/records/batch-create` | 批量创建记录（Undo） |
| POST | `/api/tables/:tableId/fields/batch-delete` | 批量删除字段（返回快照） |
| POST | `/api/tables/:tableId/fields/batch-restore` | 批量恢复字段（从快照） |
| PUT | `/api/tables/views/:viewId` | 更新视图配置 |
| PUT | `/api/tables/views/:viewId/filter` | 更新视图筛选 |
| POST | `/api/ai/filter/generate` | AI 生成筛选（SSE） |

### 4.2 SSE 事件格式

```
POST /api/ai/filter/generate
Body: { tableId, query, existingFilter? }

→ event: thinking   data: { text }
→ event: result     data: { filter: { logic, conditions[] } }
→ event: error      data: { code, message }
→ event: done       data: {}
```

---

## 5. 部署架构

```
用户浏览器
  ↓ HTTP
Nginx (163.7.1.94:80) → www.baseimage.cn
  ↓ Reverse Proxy
Express (port 3001)
  ├── Serves static frontend (Vite build)
  ├── REST API (/api/tables/*)
  ├── AI API (/api/ai/*)
  └── PostgreSQL (Prisma)

Process Manager: PM2
Branch Strategy: feat/cell-selection (preview) → main (stable)
```
