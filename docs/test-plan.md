# AI Filter 测试计划与测试用例

## 测试策略

- **P0（功能可用性）**：验证所有功能的核心链路能正常工作，阻断性问题
- **P1（产品体验）**：验证交互细节、视觉表现、边界场景的用户体验

---

## 1. 表格视图

### P0 — 功能可用性

| ID | 用例 | 预期结果 |
|----|------|----------|
| T-01 | 页面加载后表格正确渲染 | 所有字段列头和数据行完整显示，字段顺序与 fieldOrder 一致 |
| T-02 | 双击文本单元格进入编辑 | 出现文本输入框，聚焦，显示当前值 |
| T-03 | 编辑单元格后按 Enter 提交 | 值更新显示，API 调用 updateRecord 成功 |
| T-04 | 编辑单元格后按 Escape 取消 | 恢复原值，不调用 API |
| T-05 | 编辑数字字段输入非数字 | 提交时转换为数字或忽略无效输入 |
| T-06 | 单选字段编辑弹出下拉 | 显示所有选项，点击选中后更新 |
| T-07 | 多选字段编辑弹出下拉 | 支持多选，勾选/取消即时反映 |
| T-08 | 日期字段编辑弹出日期选择器 | 选择日期后更新单元格值 |
| T-09 | Checkbox 字段单击切换 | 值在 true/false 间切换，API 同步 |
| T-10 | AutoNumber 字段不可编辑 | 双击无反应，Delete 键不清空 |
| T-11 | 列宽拖拽调整 | 拖拽列边界可调整宽度，释放后宽度保持 |
| T-12 | 刷新页面后列宽保持 | localStorage 持久化列宽配置 |
| T-13 | 列头拖拽排序 | 拖拽列头到目标位置，列顺序更新，同步后端 |

### P1 — 产品体验

| ID | 用例 | 预期结果 |
|----|------|----------|
| T-14 | 列宽拖到最小值（60px） | 不能再缩小，无布局错乱 |
| T-15 | 编辑单元格时点击另一个单元格 | 退出当前编辑，选中新单元格 |
| T-16 | 单击已选中单元格再次点击 | 进入编辑态（click-again-to-edit） |
| T-17 | 行悬浮时显示行号/复选框 | 非选择态显示行号，悬浮或有选择态时显示复选框 |
| T-18 | 表格水平滚动 | 列头与数据行对齐，不错位 |
| T-19 | 空记录表格 | 只显示列头和「Add record」按钮 |

---

## 2. 单元格选择与操作

### P0 — 功能可用性

| ID | 用例 | 预期结果 |
|----|------|----------|
| C-01 | 单击数据单元格 | 单元格蓝色高亮选中 |
| C-02 | 鼠标拖拽选择矩形区域 | 区域内所有单元格高亮 |
| C-03 | 选中单元格后按 Delete 键 | 选中单元格内容清空，只读字段不受影响 |
| C-04 | 批量清空后显示 Undo toast | Toast 显示「Cleared N cells」，点击 Undo 恢复 |
| C-05 | 复选框选中行 + Delete 键 | 弹出确认弹窗（Safety Delete 开启时），确认后清空该行所有单元格 |
| C-06 | 复选框选中行 + Delete + 确认后 | 复选框恢复未选中状态 |
| C-07 | 复选框选中行 + Delete 键（Safety Delete 关闭） | 直接清空行单元格，不弹窗 |
| C-08 | Escape 键取消单元格选区 | 蓝色高亮消失 |

### P1 — 产品体验

| ID | 用例 | 预期结果 |
|----|------|----------|
| C-09 | 拖选后释放立即点击同一单元格 | 不误触发编辑（justCellDraggedRef 保护） |
| C-10 | 拖选到表格外部 | 选区保持最后有效位置，不报错 |
| C-11 | 选中单元格后勾选行复选框 | 单元格选区自动清除 |
| C-12 | 勾选行复选框后拖选单元格 | 复选框选择保持不变，单元格选区独立 |
| C-13 | 清空行单元格弹窗文案 | 标题 "Clear Records"，正文 "clear all cells of N record(s)" |
| C-14 | 清空行单元格 Toast 文案 | 显示 "Cleared N records"（非 "cells"） |

---

## 3. 行选择与删除

### P0 — 功能可用性

| ID | 用例 | 预期结果 |
|----|------|----------|
| R-01 | 点击行号/复选框选中单行 | 行高亮，复选框打勾 |
| R-02 | Shift+Click 范围选择 | 两次点击之间的所有行被选中 |
| R-03 | 表头复选框全选 | 所有行被选中，再点击取消全选 |
| R-04 | 右键选中行 → 删除记录 | Safety Delete 开启时弹确认框，确认后记录从表格消失 |
| R-05 | 删除记录后 Undo | 记录恢复到原位置，数据完整 |
| R-06 | 右键未选中行 → 删除 | 只删除右键对应行 |
| R-07 | 右键在单元格选区内 → 删除 | 删除选区覆盖的所有行 |

### P1 — 产品体验

| ID | 用例 | 预期结果 |
|----|------|----------|
| R-08 | 全选后删除部分 | 表头复选框变为 indeterminate 状态 |
| R-09 | 删除后记录数量更新 | 页脚 "N records" 数字正确 |
| R-10 | 右键菜单在表格外点击 | 菜单关闭 |

---

## 4. 撤销系统

### P0 — 功能可用性

| ID | 用例 | 预期结果 |
|----|------|----------|
| U-01 | 删除记录后 Ctrl+Z | 记录恢复，位置正确 |
| U-02 | 编辑单元格后 Ctrl+Z | 单元格恢复原值 |
| U-03 | 批量清空单元格后 Ctrl+Z | 所有清空的单元格恢复原值 |
| U-04 | 删除字段后 Ctrl+Z | 字段恢复，数据恢复，筛选条件恢复 |
| U-05 | Toast 中点击 Undo 按钮 | 与 Ctrl+Z 效果一致 |
| U-06 | 连续执行 3 次操作后连续 Ctrl+Z 3 次 | 三个操作都正确恢复 |

### P1 — 产品体验

| ID | 用例 | 预期结果 |
|----|------|----------|
| U-07 | 在输入框中按 Ctrl+Z | 触发浏览器原生 undo，不触发应用 undo |
| U-08 | 撤销栈为空时按 Ctrl+Z | 无反应，不报错 |
| U-09 | 超过 20 步后最早的操作被移除 | 第 21 次操作后，第 1 次的操作不可撤销 |
| U-10 | 撤销按钮灰色态 | 栈为空时 Undo 按钮显示为禁用/灰色 |

---

## 5. AI 智能筛选

### P0 — 功能可用性

| ID | 用例 | 预期结果 |
|----|------|----------|
| A-01 | 输入「优先级为 P0」按 Enter | 生成筛选条件：优先级 eq P0，表格只显示 P0 记录 |
| A-02 | 输入「负责人是陈晓明」 | 生成筛选条件：负责人 contains 陈晓明 |
| A-03 | 输入「截止日期在本周之内」 | 生成相对日期条件 thisWeek |
| A-04 | 输入拼音「youxianji P0」 | 拼音模糊匹配到「优先级」字段 |
| A-05 | Loading 状态正确显示 | 显示 "Generating filter by ..." + 动态省略号 |
| A-06 | 生成完成后条件面板更新 | FilterPanel 显示生成的条件列表 |
| A-07 | 生成失败时显示错误 | 错误 toast + 输入框恢复可编辑状态 |

### P1 — 产品体验

| ID | 用例 | 预期结果 |
|----|------|----------|
| A-08 | 长文本查询输入框不换行 | 文本单行截断，ellipsis 显示 |
| A-09 | Loading 长文本截断 | 文字裁剪 + LoadingDots 动效作为截断标识，无双重省略号 |
| A-10 | Loading 动效省略号距右边 12px | LoadingDots 与右边界保持 12px 间距 |
| A-11 | 有文本时图标顺序 | 顺序为：✕(清除) → 🎤(麦克风) → ↑(发送) |
| A-12 | 空查询按 Enter | 不发送请求 |
| A-13 | 生成过程中再次按 Enter | 不重复发送请求 |

---

## 6. 语音输入

### P0 — 功能可用性

| ID | 用例 | 预期结果 |
|----|------|----------|
| V-01 | 点击麦克风按钮 | 开始录音，图标变色 + 脉冲动画 |
| V-02 | 录音中说话后点击停止 | 识别文字填入输入框 |
| V-03 | 长按空格键 500ms+ | 触发语音输入 |
| V-04 | 浏览器不支持 Speech API | 麦克风按钮不显示 |

### P1 — 产品体验

| ID | 用例 | 预期结果 |
|----|------|----------|
| V-05 | 快速按放空格（<500ms） | 不触发语音，正常输入空格 |
| V-06 | 录音中输入框状态 | 输入框只读，不可手动输入 |
| V-07 | 停止录音后 800ms Grace Period | 等待最后结果到达再结束 |

---

## 7. 筛选条件管理

### P0 — 功能可用性

| ID | 用例 | 预期结果 |
|----|------|----------|
| F-01 | 点击 + Add condition | 新增一行空条件 |
| F-02 | 选择字段后操作符列表更新 | 文本字段显示 contains 等，数字显示 gt/lt 等 |
| F-03 | 设置条件后表格实时过滤 | 不匹配的记录隐藏 |
| F-04 | 切换 AND / OR 逻辑 | 筛选结果正确变化 |
| F-05 | 点击条件行 ✕ 删除条件 | 条件移除，表格更新 |
| F-06 | 保存筛选 | ViewTabs 标签更新，刷新后筛选保持 |
| F-07 | 清除筛选 | 恢复到上次保存的筛选状态 |

### P1 — 产品体验

| ID | 用例 | 预期结果 |
|----|------|----------|
| F-08 | isEmpty / isNotEmpty 操作符无需值输入 | 值输入区域隐藏或禁用 |
| F-09 | 删除字段后对应筛选条件自动移除 | 不残留无效条件 |
| F-10 | 筛选条件中日期选择器 | 支持绝对日期和相对日期（今天、本周等） |
| F-11 | 筛选面板 Escape 关闭 | 面板关闭，筛选条件保持 |

---

## 8. 字段配置

### P0 — 功能可用性

| ID | 用例 | 预期结果 |
|----|------|----------|
| FC-01 | 打开字段配置面板 | 显示所有字段列表，含可见性开关 |
| FC-02 | 拖拽字段排序 | 字段顺序更新，表格列顺序同步 |
| FC-03 | 隐藏字段 | 表格中对应列消失，筛选下拉不受影响 |
| FC-04 | 显示已隐藏字段 | 表格中对应列恢复 |
| FC-05 | 搜索字段（中文） | 匹配到包含关键字的字段 |
| FC-06 | 搜索字段（拼音） | 拼音模糊匹配到中文字段名 |

### P1 — 产品体验

| ID | 用例 | 预期结果 |
|----|------|----------|
| FC-07 | 点击字段名滚动定位 | 表格水平滚动到对应列，列高亮 |
| FC-08 | 搜索无匹配 | 显示空状态 |

---

## 9. Safety Delete

### P0 — 功能可用性

| ID | 用例 | 预期结果 |
|----|------|----------|
| SD-01 | Safety Delete 开启 + 删除记录 | 弹出确认框 |
| SD-02 | Safety Delete 关闭 + 删除记录 | 直接删除，不弹框 |
| SD-03 | Safety Delete 开启 + 清空行单元格 | 弹出确认框，标题 "Clear Records" |
| SD-04 | Safety Delete 开关状态刷新后保持 | localStorage 持久化 |
| SD-05 | 拖选单元格 + Delete 键 | 不受 Safety Delete 管控，直接清空 |

### P1 — 产品体验

| ID | 用例 | 预期结果 |
|----|------|----------|
| SD-06 | 确认弹窗中取消 | 关闭弹窗，不执行操作 |
| SD-07 | 确认弹窗文案正确 | 删除记录/删除字段/清空行单元格各有对应文案 |

---

## 10. 数据持久化

### P0 — 功能可用性

| ID | 用例 | 预期结果 |
|----|------|----------|
| D-01 | 编辑单元格后刷新页面 | 修改保持，API 已调用 updateRecord |
| D-02 | 清空单元格后刷新页面 | 清空状态保持 |
| D-03 | 删除记录后刷新页面 | 记录不再出现 |
| D-04 | 服务重启后数据保持 | Mock 数据只在首次启动 seed，后续不覆盖 |
| D-05 | 字段顺序刷新后保持 | viewFieldOrder 持久化到后端 |

### P1 — 产品体验

| ID | 用例 | 预期结果 |
|----|------|----------|
| D-06 | API 调用失败时乐观更新回滚 | UI 恢复原状 + 错误 toast |

---

## 11. 实时数据同步

### P0 — 功能可用性

| ID | 用例 | 预期结果 |
|----|------|----------|
| SS-01 | 打开两个标签页，Tab A 编辑单元格 | Tab B 在 ~1 秒内同步显示新值 |
| SS-02 | Tab A 删除记录 | Tab B 记录自动消失 |
| SS-03 | Tab A 批量删除字段 | Tab B 字段消失 + 筛选条件自动清理 |
| SS-04 | Tab A 修改视图筛选 | Tab B 视图配置同步更新 |
| SS-05 | Tab A 编辑后自身不重复更新（防回声） | Tab A 修改不触发自身 SSE 回调 |

### P1 — 产品体验

| ID | 用例 | 预期结果 |
|----|------|----------|
| SS-06 | 断网 5 秒后恢复 | SSE 自动重连 + 全量同步补齐 |
| SS-07 | 多用户（不同浏览器）同时编辑 | 各自看到对方的修改，无冲突 |
| SS-08 | Tab A 编辑后 Tab B 的 undo 栈不受影响 | 远程变更不推入 undo 栈 |

---

## 12. Undo 可靠性（删除 → Undo → 后端一致性）

> 核心链路：删除时后端真删 + 前端保存快照 → Undo 时前端恢复 + 调 batchCreate 重新插入后端

### P0 — 功能可用性

| ID | 用例 | 操作步骤 | 预期结果 |
|----|------|----------|----------|
| U-01 | 删除单条记录 → Undo → 刷新验证 | 1. 记住某条记录内容 2. 右键删除该记录 3. 点 Toast 上的 Undo 4. 刷新页面 | 记录恢复到原位置，刷新后数据仍在（后端 batchCreate 成功） |
| U-02 | 批量删除多条记录 → Undo → 刷新验证 | 1. 勾选 3 条记录 2. 右键删除 3. 点 Undo 4. 刷新 | 3 条记录全部恢复到原位置，刷新后仍在 |
| U-03 | 删除记录 → 不 Undo → 刷新验证 | 1. 删除 1 条记录 2. 等 Toast 消失（5 秒） 3. 刷新 | 记录确实不在了（后端已删除） |
| U-04 | 编辑单元格 → Ctrl+Z → 刷新验证 | 1. 双击单元格改值 2. Enter 确认 3. Ctrl+Z 4. 刷新 | 单元格恢复原值，刷新后是恢复后的值 |
| U-05 | 清空多个单元格 → Undo → 刷新验证 | 1. 拖选多个单元格 2. Delete 键 3. 点 Undo 4. 刷新 | 所有单元格恢复原值，刷新后一致 |
| U-06 | 删除字段 → Undo → 刷新验证 | 1. 右键删除某个字段 2. 点 Undo 3. 刷新 | 字段恢复 + 该字段下数据恢复 + 筛选条件恢复 |
| U-07 | 快速删除后立即 Undo（竞态） | 1. 删除记录 2. 立即（<1 秒）点 Undo 3. 刷新 | Undo 等删除完成后再恢复，刷新后数据在（无竞态） |
| U-08 | 连续多次操作 → 多次 Ctrl+Z | 1. 编辑 A 2. 编辑 B 3. 删除 C 4. Ctrl+Z ×3 5. 刷新 | 按 LIFO 顺序依次恢复：先恢复 C，再 B，再 A |
| U-09 | 刷新后 Undo 栈清空 | 1. 删除记录 2. 刷新页面 3. Ctrl+Z | 无反应（undo 栈是纯前端内存，刷新后丢失） |

### P1 — 产品体验

| ID | 用例 | 操作步骤 | 预期结果 |
|----|------|----------|----------|
| U-10 | 后端故障时 Undo 恢复删除 | 1. 删除记录 2. 断开后端 3. 点 Undo | 前端先显示恢复 → 后端失败 → 前端回退（记录再次消失）+ toast "撤销失败，数据未能同步，请刷新页面" |
| U-11 | 后端故障时编辑单元格 | 1. 断开后端 2. 双击修改单元格 | 前端先显示新值 → 后端失败 → 回退到旧值 + toast "保存失败，修改已回退" |
| U-12 | 后端故障时删除记录 | 1. 断开后端 2. 删除记录 | 前端先消失 → 后端失败 → 记录恢复 + toast "删除失败，请重试" |
| U-13 | 后端故障时清除单元格 | 1. 断开后端 2. 拖选单元格 + Delete | 前端先清空 → 后端失败 → 恢复原值 + toast "清除失败，修改已回退" |
| U-14 | Undo 恢复后其他标签页同步 | 1. Tab A 删除记录 2. Tab A Undo 3. 观察 Tab B | Tab B 先看到记录消失，Undo 后又看到记录恢复（SSE 同步） |
| U-15 | Toast Undo 按钮 5 秒后消失 | 1. 删除记录 2. 等待 Toast | Toast 5 秒后自动消失，Undo 按钮不可再点 |

---

## 13. 国际化 (i18n)

### P0 — 功能可用性

| ID | 用例 | 预期结果 |
|----|------|----------|
| I18N-01 | 默认加载页面（无 localStorage） | UI 以英文渲染，所有按钮、标签、操作符标签为英文 |
| I18N-02 | 头像菜单切换到简体中文 | 页面 reload 后所有 UI 文本变为中文 |
| I18N-03 | 中文界面下切换回 English | 页面 reload 后所有 UI 文本恢复英文 |
| I18N-04 | 切换语言后刷新页面 | 语言保持不变（localStorage `app_lang` 持久化） |
| I18N-05 | 头像下拉 → Language 子菜单 | 当前语言旁显示勾选标记（checkmark） |

### P1 — 产品体验

| ID | 用例 | 预期结果 |
|----|------|----------|
| I18N-06 | 筛选操作符下拉（中文/英文） | 所有操作符显示翻译后的标签（如 "contains" / "包含"） |
| I18N-07 | 日期选择器月份和星期名 | 中文界面显示中文月份/星期，英文界面显示英文 |
| I18N-08 | Toast 消息翻译 | 成功/失败/警告 toast 显示对应语言文案 |
| I18N-09 | Language 子菜单不溢出视口 | 子菜单向左展开（`right: calc(100% + 4px)`），右边缘不超出屏幕 |
| I18N-10 | 用户数据不受语言切换影响 | 字段名、记录值、选项值保持原样，仅 UI 框架文本翻译 |

---

## 14. 多表管理

### P0 — 功能可用性

| ID | 用例 | 预期结果 |
|----|------|----------|
| MT-01 | 点击 Sidebar「+ 新建」→「数据表」 | 新表创建成功，自动切换到新表，显示 1 列文本字段 + 5 行空记录 |
| MT-02 | 新表默认字段列宽 | 主字段（Text）列宽 280px |
| MT-03 | 中文环境建第二个表 | 名称为「数据表 2」（数字前有空格），不与已有表重名 |
| MT-04 | 英文环境建表 | 名称为「Table」，第二个为「Table 2」 |
| MT-05 | 点击 Sidebar 不同表项切换表 | 表格数据正确切换、SSE 重新订阅、undo 栈清空 |
| MT-06 | 切换表时表名无闪烁 | 切换瞬间 sidebar 和 topbar 立即显示新表名，不短暂显示旧表名 |
| MT-07 | 刷新页面后表保持 | 所有已建表还在、lastActiveTableId 正确恢复 |
| MT-08 | 多端同步：Tab A 建表 | Tab B 通过 document SSE 看到新表出现 |
| MT-09 | 拖拽排序 Sidebar 中的表项 | 蓝线指示器显示目标位置，松手后顺序更新、刷新后保持 |
| MT-10 | 删除表：右键数据表 → 删除 | 弹出确认弹窗，确认后表被删除 |
| MT-11 | 删除表：点击 more icon → 删除 | 同 MT-10，弹出确认弹窗后删除 |
| MT-12 | 删除当前活跃表 | 删除后自动切换到上一个表（非第一个） |
| MT-13 | 唯一一个表不可删除 | 只剩 1 个表时删除操作不执行 |
| MT-14 | 多端同步：Tab A 删表 | Tab B 通过 document SSE 看到表被移除 |

### P1 — 产品体验

| ID | 用例 | 预期结果 |
|----|------|----------|
| MT-15 | 新建菜单非功能选项点击 | 菜单不关闭，无反应 |
| MT-16 | 新建菜单「数据表」点击 | 建表成功后菜单关闭 |
| MT-17 | Sidebar 宽度拖拽调整 | 拖拽右侧边缘可调整宽度（120px–400px），刷新后保持 |
| MT-18 | 仪表盘/工作流静态项 | 不可拖动排序，不可删除 |
| MT-19 | 右键菜单宽度 | 上下文菜单宽度 180px |
| MT-20 | 新建菜单宽度 | 下拉菜单宽度 240px |

---

## 15. Add Record（空白行录入）

### P0 — 功能可用性

| ID | 用例 | 预期结果 |
|----|------|----------|
| AR-01 | 点击表格底部 `+ Add Record` | 最底部出现一条空行，行数 +1 |
| AR-02 | 新增行后自动编辑 | 新行首列 `<input>` 立即 focus，`td` 带 `td-editing` class |
| AR-03 | 在编辑态输入文本并 Enter 提交 | 内容保存、行退出编辑态、下次刷新仍存在 |
| AR-04 | 点击工具栏 `+ Add Record` | 与表格底部按钮行为一致，新行 + 自动编辑 |
| AR-05 | 新行超出可视区 | 自动 scrollIntoView，新行在视口内可见 |
| AR-06 | 多端同步：A 端 Add Record | B 端通过 SSE 收到新行，不进入编辑态 |
| AR-07 | 自己 Add Record 触发的 SSE 回声 | 本地不出现重复行（id 去重） |
| AR-08 | 连续点击 Add Record 多次 | 连续追加多条空行，每条 id 唯一 |

### P1 — 产品体验

| ID | 用例 | 预期结果 |
|----|------|----------|
| AR-09 | 隐藏首列后新增记录 | 编辑态落在 `visibleFields[0]`（可见首列） |
| AR-10 | API 失败 | 不显示空行，不进入编辑态，不影响后续操作 |
| AR-11 | 编辑态 Escape 取消 | 空行保留，只退出编辑态（空白行合法） |
| AR-12 | 工具栏按钮 chevron 点击区 | 整个按钮可点击；未来 chevron 可扩展为类型下拉（当前无反应） |

---

## 16. Sidebar 新建菜单精简

### P0 — 功能可用性

| ID | 用例 | 预期结果 |
|----|------|----------|
| CM-01 | 打开 Sidebar「+」新建菜单 | 仅显示：AI 建表 / 数据表 / 设计 / 新建文件夹（共 4 项，不含 template/form/dashboard/workflow/import/app） |
| CM-02 | 菜单分组显示 | 「快速创建」「新建」「管理」分组 header 正确渲染 |
| CM-03 | 点击 "数据表" | 打开 CreateTablePopover |
| CM-04 | 点击 "AI 建表" | 进入 AI 建表流程 |

### P1 — 产品体验

| ID | 用例 | 预期结果 |
|----|------|----------|
| CM-05 | CreateTablePopover 标题 icon | 显示紫色 `#8D55ED` 表格 icon（与菜单 "数据表" 项 icon 一致） |
| CM-06 | 生成中 / 创建中动画 icon | 仍使用 AI 渐变四芒星，视觉区分状态 |
| CM-07 | 代码中 HIDE_CREATE_MENU_KEYS 清空 | 6 项隐藏入口全部恢复显示（回归验证） |

---

## 17. Chat 工具卡片展开体验

### P0 — 功能可用性

| ID | 用例 | 预期结果 |
|----|------|----------|
| CT-01 | 展开思考卡片 | 标题与正文之间有 8px 间距，正文不贴边 |
| CT-02 | 展开工具调用卡片 | 同上；每步前可见「执行中…」「执行完成」等状态文案 |
| CT-03 | 触发危险工具（如 delete_table） | 走文本式二次确认（模型用自然语言询问），用户回复「确认」后才执行 |
| CT-04 | ConfirmCard 出现（仅非文本路径） | "信息确认" 标题 + 「跳过」「开始执行」按钮语义正确 |

### P1 — 产品体验

| ID | 用例 | 预期结果 |
|----|------|----------|
| CT-05 | 用户向上翻阅历史时流式输出 | 不再被强制拉回底部（与 2026-04-20 既有修复一致） |
| CT-06 | 浏览器 tab 标题 | 显示 "Table Agent · AI 智能多维表格" |

---

## 18. Agent Identity（Phase 1 · OpenClaw-style）

### P0 — 功能可用性

| ID | 用例 | 预期结果 |
|----|------|----------|
| AI-01 | 首次启动后端 | console 打印 seed 信息；`~/.imagebase/agents/agent_default/` 自动创建，含 soul.md / profile.md / config.json / memory/ 子目录 |
| AI-02 | `GET /api/agents` | 返回数组，至少包含 `{id: "agent_default", name: "Claw", userId: "user_default"}` |
| AI-03 | `GET /api/agents/agent_default/identity` | 返回 `{soul, profile, config}` 三字段，soul 和 profile 是非空 markdown 字符串 |
| AI-04 | `PUT /api/agents/agent_default/identity/profile`（合法内容） | 返回 `{ok: true}`；readback 得到新内容；filesystem 上 profile.md 同步更新 |
| AI-05 | `PUT /identity/soul`（空字符串 / 全空格） | 400，不写入 filesystem |
| AI-06 | `PUT /identity/profile`（> 64 KiB） | 400 "内容超过 64 KiB 上限" |
| AI-07 | ChatSidebar header 不再暴露 Identity 入口 | header 只有 "..." 溢出按钮；没有 IdentityIcon / Modal 可打开（Phase 1 决策：soul/profile 仅通过对话读写） |
| AI-08 | _(已并入 AI-14 — Agent 自编辑走对话路径)_ | — |
| AI-09 | _(已并入 AI-14)_ | — |
| AI-10 | _(删除：无 UI 表单)_ | — |
| AI-11 | _(删除：无 UI 表单)_ | — |
| AI-12 | 创建新对话 → 问 "你是谁" | 回复（或 thinking 过程）包含 soul.md 里的关键词（"OpenClaw"、"长期 Agent"、"属于用户" 等之一） |
| AI-13 | 编辑 profile.md 加入 "我的时区是 GMT+8" 后再对话 | Agent 在对话中能体现这条偏好（如询问时间相关问题时使用 GMT+8） |
| AI-14 | 对话中请 Agent 记住一件事（如 "记住我偏好中文回复"） | Agent 调用 `update_profile` 或 `create_memory`；回答后端 filesystem 可见新内容 / 新 episodic md |
| AI-15 | 请 Agent 执行危险操作（如删除表） | Agent 不直接执行；必须先征求用户同意（Layer 1 META 约束） |
| AI-16 | 新建对话时不传 `agentId` | 后端默认 fallback 到 `agent_default`，对话可正常进行 |
| AI-17 | DELETE agent 后原对话 | 对话 `agentId` 变 NULL（DB 验证）；仍可继续，走 agent_default fallback |

### P1 — 产品体验

| ID | 用例 | 预期结果 |
|----|------|----------|
| AI-18 | _(删除：Phase 1 无 IdentityIcon UI)_ | — |
| AI-19 | _(删除：Phase 1 无 Modal UI)_ | — |
| AI-20 | _(删除：Phase 1 无 Modal 专属 i18n 键需显示给用户)_ | — |
| AI-21 | _(删除：Phase 1 无 Modal)_ | — |
| AI-22 | _(删除：Phase 1 无 textarea)_ | — |
| AI-23 | 对话中让 Agent 自改 soul/profile 失败时 | Agent 回复中告知失败原因（如超 64 KiB / 网络断开）；不污染 filesystem；后续对话仍可重试 |
| AI-24 | `AGENT_HOME` 环境变量 | 指向临时目录时，启动不读 `~/.imagebase/agents`，测试隔离 |
| AI-25 | `phase1-meta-smoke.ts` | `cd backend && npx tsx src/scripts/phase1-meta-smoke.ts` 输出全部 `{ok: true}`，"empty content rejection" 返回 `{ok: false}` |

---

## 执行检查清单

- [ ] 所有 P0 用例通过
- [ ] P1 用例无阻断性问题
- [ ] 无 console error（忽略已知 DOM nesting warning）
- [ ] 主流浏览器验证（Chrome, Safari, Edge）

---

## Analyst Skill（AI 问数）测试用例

### P0 — 核心功能

1. **加载 + 全表描述（纯聚合）**
   - 输入："分析一下需求管理表"
   - 预期：Agent 激活 analyst-skill → `load_workspace_table` → `describe_result`
   - 回复包含：行数、每字段非空率、分类字段 top-K、数值字段 mean/p50/p95
   - **开头有快照时点声明**（"本次分析基于 … 的数据快照"）

2. **单步分组聚合**
   - 输入："按优先级统计总工时"
   - 预期：`load_workspace_table` → `group_aggregate(groupBy=["优先级"], metrics=[{field:"工时", op:"sum"}])`
   - 结果内联为 markdown 表格（ChatTableBlock 渲染）

3. **大表截断声明**
   - 当 group_aggregate 结果 > 100 行时，回复仅展示前 20 行
   - **正文必须声明"完整结果共 N 行"并引导对话物化**

4. **time_bucket 时序分析**
   - 输入："按月看看创建时间趋势"
   - 预期：`time_bucket(granularity="month", metrics=[{op:"count"}])`
   - 结果按时间升序

5. **透视表**
   - 输入："按优先级 × 状态透视工时"
   - 预期：`pivot_result(rows=["优先级"], columns=["状态"], values=[{field:"工时", op:"sum"}])`
   - 列名从 columns 字段的值动态展开

6. **字段消歧义（严格）**
   - 表中有 amount_usd / amount_cny 两个数值字段；输入："分析一下销售额"
   - 预期：Agent 在调任何聚合工具**前**用自然语言反问："我看到 amount_usd / amount_cny 两个字段，你指的是哪个？"
   - 不应默默选一个开算

7. **run_sql 兜底 + 安全**
   - 输入涉及 window function 等专用工具表达不了的场景
   - 预期：Agent 调 `run_sql` 配合手写 SQL，在回复里解释用了什么表达式
   - 输入恶意 SQL（"DROP TABLE x" / "DELETE FROM y"）→ 后端返回 `run_sql: 仅支持 SELECT / WITH / CREATE TABLE <name> AS`，Agent 在回复里说明不能执行并拒绝

8. **快照复用 + 显式刷新**
   - 同一对话内连续问 3 个分析问题 → 只有第一次 `load_workspace_table` 写 parquet，后 2 次复用
   - 输入："基于最新数据再跑一次" → Agent 调用时加 `refresh:true`，生成新快照

9. **结果物化到 Idea（对话驱动）**
   - 前置：已有 group_aggregate 结果
   - 输入："整理成文档"
   - 预期：Agent 调 `write_analysis_to_idea` → 新建 Idea，内容含标题 + 叙述 + 核心数据 Markdown 表格 + 快照时点
   - 对话里返回 `[@分析报告 …](mention://idea/…)` chip，可点击跳转

10. **结果物化到新数据表**
    - 输入："把这个结果存为一张新数据表，叫 '季度汇总'"
    - 预期：Agent 调 `write_analysis_to_table` → 创建新表 + 默认 primary 字段被改造 + 批量 insert 记录
    - 超过 5 万行会拒绝并建议改为文档

11. **图表生成 + 对话内渲染**
    - 前置：已有结果 handle
    - 输入："画个柱状图"
    - 预期：Agent 调 `generate_chart(chartType="bar", x="优先级", y="hours")`
    - 回复里含 ```vega-lite 代码块 → `ChatChartBlock` 用 vega-embed 渲染为交互式 SVG

12. **长任务 progress + heartbeat**
    - 触发一个 10 万行的 snapshot（大表首次 load）→ Agent 的 tool card 显示进度条 + "已转换 N/10万 行"
    - 30s 无 progress → 前端显示"计算中 · 30s"并继续 tick，连接不断

13. **softDeps 保活 idea-skill**
    - analyst-skill 活跃 15 轮，期间没调用 idea-skill 工具
    - 输入 "写进文档" → idea-skill 仍可被 analyst 的 `_suggestActivate` 无缝激活（没被驱逐）

### P0 — 三个领域 skill

14. **互联网 · DAU/MAU**
    - 表中有 user_id + date 字段，用户问"最近一个月的日活和月活"
    - 预期：`internet-analyst-skill` 激活 → `dau_mau` → 返回每日 DAU / 月度 MAU / DAU-MAU 粘性比

15. **互联网 · 漏斗转化**
    - 表中 user_id + stage 字段，stages = ["浏览", "加购", "下单", "支付"]
    - 预期：`funnel_conversion` → 每阶段用户数 + 相邻阶段转化率 + 整体转化率

16. **互联网 · Cohort 留存**
    - 输入："按周看新用户 4 周留存"
    - 预期：`cohort_retention(granularity="week", periods=4)` → 每 cohort 一行，period_0-period_4 列为留存率

17. **财务 · 杜邦分析**
    - 用户给出四个数值：净利润 100 / 营收 1000 / 总资产 2000 / 权益 800
    - 预期：`dupont_analysis` → ROE=12.5% = 10% NPM × 0.5 AT × 2.5 EM（Agent 在回复里逐项解释）

18. **财务 · 比率 + 趋势**
    - 用户给出多个年度数据 → Agent 各年度调 `current_ratio` / `profit_margins` → 用 `generate_chart` 画趋势

19. **金融 · IRR**
    - 输入："IRR 多少，初始投资 1000，之后 4 年各收入 300/300/400/500"
    - 预期：`irr(cashflows=[-1000, 300, 300, 400, 500])` → 16.64%

20. **金融 · 夏普比率**
    - 用户给出一段日收益率序列
    - 预期：`sharpe_ratio(returns, riskFreeRate=0.03)` → 年化夏普 + 解读

21. **金融 · 最大回撤**
    - 输入净值序列 [100, 120, 90, 110, 85, 130]
    - 预期：`max_drawdown` → 29.17%

### P0 — 数据一致性 & 安全

22. **快照时点声明**
    - 每次 Analyst 回复开头都应带"本次分析基于 YYYY-MM-DD HH:MM 的数据快照"

23. **AST 白名单拒绝**
    - 测试 `DROP` / `DELETE` / `UPDATE` / `INSERT` / `ATTACH` / `COPY` / `PRAGMA` / `SET` — 全部返回错误，不执行

24. **会话隔离**
    - 两个对话同时分析同一张表 → DuckDB 文件分开，handle 互不可见（跨会话调 `resolveHandle` 返回 404）

### P1 — 细节体验

25. **ChatTableBlock 列宽**
    - 长字符串单元格（> 200 字符）被 ellipsis 截断 + hover 显示完整值
    - 超过 6 列横向滚动
    - 数值列右对齐 + `tabular-nums`

26. **Vega-lite lazy load**
    - 首次渲染图表时动态加载 vega-embed；未含图表的消息不触发加载
    - 打开 DevTools Network → 确认 embed chunk 只在 chart 出现时加载

27. **清理 cron**
    - 设置环境变量缩短 IDLE_CLOSE_MS → 观察 cleanup cron log 输出 "idle-closed=N file-deleted=… snapshots-purged=…"

28. **跨会话缓存命中**
    - 两个会话问同一表的同一个 group_aggregate → 第二次 meta.producedBy = "group_aggregate"（同结构）但命中显著快

29. **字段描述推断**
    - 调 `propose_field_descriptions(tableId)` → 每个字段有一条 proposed（基于名字模式匹配 / 类型兜底）

### 自动化 Smoke

- `backend/src/scripts/analyst-p1-smoke.ts` — 独立 DuckDB runtime 冒烟，不需要主 backend
- `backend/src/scripts/analyst-p2-smoke.ts` — 需要 `npm run dev:backend`，跑 P2 HTTP 接口全链路
- 部署流程强制在 CI 或本地运行这两个脚本

---

## Magic Canvas · Multi-block table sync (P0)

> 验证 `TableArtifactSurface` 自包含组件 + per-instance `instanceClientId` 的多 block 同表实时同步。

### P0 用例

| ID | 步骤 | 期望 |
|---|------|------|
| MC-T-01 | 打开页面，默认布局 1 chat + 1 artifact | 渲染正常，artifact block 显示当前 active table |
| MC-T-02 | TopBar `+` 加第二个 artifact block | 新 block 默认 seed 当前 globalActiveTableId（与左 block 一致） |
| MC-T-03 | A、B 两个 artifact block 在不同 table 之间切换 | 各自独立显示，互不影响 |
| MC-T-04 | A、B 切到**同一张** table | 两 block 同时显示 fields / records / 0 records 完全一致 |
| MC-T-05 | 在 A 加 record（点 + Add Record）| **A、B 同时变为 `n+1` records** |
| MC-T-06 | 在 B 加 record | **A、B 同时变更**（反向也成立）|
| MC-T-07 | 在 A 编辑 cell | **B 立即显示新值**（不需要刷新）|
| MC-T-08 | 在 A 删除 record | **A、B 同时移除该行** |
| MC-T-09 | 在 A 加 field（新列）| **A、B 同时显示新列** |
| MC-T-10 | 在 A 改 field 名/类型 | **A、B 列头同步更新** |
| MC-T-11 | 在 A 删 field | **A、B 同时移除该列** |
| MC-T-12 | 在 A 改 view filter / hidden field / fieldOrder | A 立即生效；B 因为是同一 viewId 也同步（Toolbar / FieldConfig 状态都更）|
| MC-T-13 | 在 A undo（Cmd/Ctrl+Z）| 仅撤销 A 的最后一个动作（A 内部 undo 栈独立），不会影响 B 的 undo 栈 |
| MC-T-14 | 关闭 B（block 内 close X）| layout 还原 1+1，A 继续可用 |
| MC-T-15 | 刷新页面 | layout / 各 block.active table / sidebar 宽度都保留（持久化到 user.preferences）|

### 自动化校验

`/tmp/test-sse-clientid.mjs`（开发期手动跑）：模拟两个独立 SSE 订阅 + 三种 mutation，断言 `event.clientId` 正确携带源端 clientId。**6/6 assertions pass** = 后端事件层面 OK。前端 useTableSync 的 `if (event.clientId === clientId) return` 只是一行确定性过滤，无需额外覆盖。

### 已知保留事项

- 无（V1 中"同表多开 SSE 不互通"的限制本次已消除）
