import type { TranslationKeys } from "./en";

export const zh: TranslationKeys = {
  // Sidebar
  "sidebar.search": "搜索",
  "sidebar.table": "数据表",
  "sidebar.dashboard": "仪表盘",
  "sidebar.workflow": "工作流",
  "sidebar.new": "新建",
  "sidebar.design": "设计稿",
  "sidebar.album": "相册",

  // TopBar
  "topbar.menu": "菜单",
  "topbar.home": "首页",
  "topbar.pin": "固定",
  "topbar.l2Internal": "L2 – 内部",
  "topbar.lastModified": "最近修改：刚刚",
  "topbar.publicWarning": "请确保内容公开可接受",
  "topbar.share": "分享",
  "topbar.robot": "机器人",
  "topbar.permissions": "权限",
  "topbar.extensions": "扩展",
  "topbar.notifications": "通知",
  "topbar.more": "更多",
  "topbar.search": "搜索",
  "topbar.add": "新建",
  "topbar.ai": "AI",
  "topbar.safeDelete": "安全删除",
  "topbar.language": "语言",
  "topbar.langEnglish": "English",
  "topbar.langChinese": "简体中文",

  // Toolbar
  "toolbar.addRecord": "添加记录",
  "toolbar.customizeField": "字段设置",
  "toolbar.viewSettings": "视图配置",
  "toolbar.filter": "筛选",
  "toolbar.filterCount": "{{count}} 筛选",
  "toolbar.groupBy": "分组",
  "toolbar.sort": "排序",
  "toolbar.rowHeight": "行高",
  "toolbar.conditionalColoring": "填色",
  "toolbar.undo": "撤销",

  // ViewTabs
  "viewTabs.filterConfigured": "已配置筛选",
  "viewTabs.clear": "清除",
  "viewTabs.save": "保存",
  "viewTabs.addView": "新建视图",
  "viewTabs.more": "更多",

  // FilterPanel
  "filter.title": "设置筛选条件",
  "filter.aiPlaceholder": "告诉 AI 你想看什么，例如：与我相关的记录",
  "filter.generatingBy": "正在生成筛选条件",
  "filter.clear": "清除",
  "filter.voiceFinishing": "正在完成...",
  "filter.voiceStop": "停止录音",
  "filter.voiceInput": "语音输入",
  "filter.submit": "提交",
  "filter.conditionsGenerated": "筛选条件已生成",
  "filter.conditionsGeneratedNoMatch": "筛选条件已生成，但没有匹配的记录",
  "filter.match": "匹配",
  "filter.all": "所有",
  "filter.any": "任一",
  "filter.conditions": "条件",
  "filter.addCondition": "添加条件",
  "filter.saveAsNewView": "另存为新视图",
  "filter.failedToGenerate": "筛选条件生成失败",
  "filter.deleteCondition": "删除条件",

  // Operators
  "op.contains": "包含",
  "op.notContains": "不包含",
  "op.eq": "等于",
  "op.neq": "不等于",
  "op.isEmpty": "为空",
  "op.isNotEmpty": "不为空",
  "op.hasOption": "包含选项",
  "op.notHasOption": "不包含选项",
  "op.after": "晚于",
  "op.onOrAfter": "不早于",
  "op.before": "早于",
  "op.onOrBefore": "不晚于",
  "op.is": "等于",
  "op.isNot": "不等于",
  "op.gt": "大于",
  "op.gte": "大于等于",
  "op.lt": "小于",
  "op.lte": "小于等于",
  "op.numIsEmpty": "为空",
  "op.numIsNotEmpty": "不为空",
  "op.userIs": "是",
  "op.userIsNot": "不是",
  "op.userContains": "包含",
  "op.userNotContains": "不包含",
  "op.checkboxIs": "是",

  // Date value options
  "date.exactDate": "精确日期",
  "date.today": "今天",
  "date.yesterday": "昨天",
  "date.tomorrow": "明天",
  "date.last7Days": "过去 7 天",
  "date.last30Days": "过去 30 天",
  "date.next7Days": "未来 7 天",
  "date.next30Days": "未来 30 天",
  "date.thisWeek": "本周",
  "date.lastWeek": "上周",
  "date.thisMonth": "本月",
  "date.lastMonth": "上月",

  // Value inputs
  "value.select": "请选择...",
  "value.checked": "已勾选",
  "value.unchecked": "未勾选",
  "value.enterNumber": "输入数字...",
  "value.enterHere": "在此输入",
  "value.selectDate": "选择日期",

  // FieldConfigPanel
  "fieldConfig.title": "字段设置",
  "fieldConfig.searchPlaceholder": "搜索字段...",
  "fieldConfig.noFields": "未找到字段",
  "fieldConfig.showField": "显示字段",
  "fieldConfig.hideField": "隐藏字段",

  // TableView
  "table.addField": "添加字段",
  "table.addRecord": "添加记录",
  "table.records": "条记录",
  "table.hideField": "隐藏字段",
  "table.hideFields": "隐藏 {{count}} 个字段",
  "table.deleteField": "删除字段",
  "table.deleteFields": "删除 {{count}} 个字段",
  "table.deleteRecord": "删除记录",
  "table.deleteRecords": "删除 {{count}} 条记录",
  "table.clickToEdit": "再次点击以编辑",

  // DatePicker month abbreviations
  "datePicker.months": "1月,2月,3月,4月,5月,6月,7月,8月,9月,10月,11月,12月",
  "datePicker.weekdays": "日,一,二,三,四,五,六",

  // TableView date editor full month names
  "table.months": "一月,二月,三月,四月,五月,六月,七月,八月,九月,十月,十一月,十二月",
  "table.weekdayLetters": "一,二,三,四,五,六,日",

  // ConfirmDialog
  "confirm.confirm": "确认",
  "confirm.cancel": "取消",
  "confirm.clear": "清除",
  "confirm.delete": "删除",

  // App.tsx confirm dialogs
  "app.deleteFields": "删除字段",
  "app.deleteFieldsMsg": "确定要删除 {{count}} 个字段吗？此操作可以撤销。",
  "app.deleteRecords": "删除记录",
  "app.deleteRecordsMsg": "确定要删除 {{count}} 条记录吗？此操作可以撤销。",
  "app.clearRecords": "清除记录",
  "app.clearRecordsMsg": "确定要清除 {{count}} 条记录的所有单元格吗？此操作可以撤销。",
  "app.clearCells": "清除单元格",
  "app.clearCellsMsg": "确定要清除 {{count}} 个单元格吗？此操作可以撤销。",

  // Toast messages
  "toast.saveFailed": "保存失败，修改已回退",
  "toast.undoFailed": "撤销失败，数据未能同步，请刷新页面",
  "toast.deleteFailed": "删除失败，请重试",
  "toast.clearFailed": "清除失败，修改已回退",
  "toast.deletedRecords": "已删除 {{count}} 条记录",
  "toast.deletedFields": "已删除 {{count}} 个字段",
  "toast.clearedCells": "已清除 {{count}} 个单元格",
  "toast.clearedRecords": "已清除 {{count}} 条记录",
  "toast.failedDeleteFields": "字段删除失败",
  "toast.undo": "撤销",

  // Search
  "search.placeholder": "搜索...",

  // AddFieldPopover
  "addField.fieldTitle": "标题",
  "addField.fieldTitlePlaceholder": "输入字段标题或 AI 推荐字段",
  "addField.aiSuggestions": "AI 推荐字段",
  "addField.refresh": "换一批",
  "addField.aiLoading": "思考中...",
  "addField.fieldType": "字段类型",
  "addField.exploreShortcuts": "探索字段捷径",
  "addField.cancel": "取消",
  "addField.confirm": "确认",
  "addField.creating": "...",
  "addField.createFailed": "创建字段失败",
  "addField.save": "保存",
  "addField.saving": "...",
  "addField.saveFailed": "保存字段失败",
  "addField.editTitle": "编辑字段",

  // Context menu
  "table.editField": "编辑字段",

  // Field type options — Basic
  "fieldType.text": "文本",
  "fieldType.number": "数字",
  "fieldType.singleSelect": "单选",
  "fieldType.multiSelect": "多选",
  "fieldType.user": "人员",
  "fieldType.dateTime": "日期",
  "fieldType.attachment": "附件",
  "fieldType.checkbox": "复选框",
  "fieldType.stage": "流程",
  "fieldType.autoNumber": "自动编号",
  "fieldType.url": "超链接",
  "fieldType.phone": "电话号码",
  "fieldType.email": "Email",
  "fieldType.location": "地理位置",
  "fieldType.barcode": "条码",
  "fieldType.progress": "进度",
  "fieldType.currency": "货币",
  "fieldType.rating": "评分",
  // Field type options — System
  "fieldType.createdUser": "创建人",
  "fieldType.modifiedUser": "修改人",
  "fieldType.createdTime": "创建时间",
  "fieldType.modifiedTime": "最后更新时间",
  // Field type options — Extended
  "fieldType.formula": "公式",
  "fieldType.singleLink": "单向关联",
  "fieldType.duplexLink": "双向关联",
  "fieldType.lookup": "查找引用",
  // Field type options — AI
  "fieldType.aiSummary": "总结",
  "fieldType.aiTransition": "翻译",
  "fieldType.aiExtract": "信息提取",
  "fieldType.aiClassify": "分类",
  "fieldType.aiTag": "智能标签",
  "fieldType.aiCustom": "自定义 AI",
  // Field type groups
  "fieldType.groupBasic": "基础字段",
  "fieldType.groupSystem": "系统字段",
  "fieldType.groupExtended": "扩展字段",
  "fieldType.groupAI": "AI 字段",

  // LookupConfigPanel
  "lookup.lookupDataIn": "在此字段中查找数据",
  "lookup.selectTable": "选择目标数据表",
  "lookup.selectField": "选择字段",
  "lookup.referenceIf": "引用数据条件",
  "lookup.allConditions": "所有",
  "lookup.anyConditions": "任一",
  "lookup.conditionsMet": "条件满足时命中",
  "lookup.addCondition": "+ 添加条件",
  "lookup.addConditionMax": "+ 添加条件（最多 5 条）",
  "lookup.displayAs": "计算方式",
  "lookup.fieldFormat": "显示格式",
  "lookup.fieldInCurrent": "当前表字段",
  "lookup.valuePlaceholder": "请输入值",
  "lookup.switchToConstant": "切换为常量",
  "lookup.switchToField": "切换为字段",
  "lookup.removeCondition": "删除条件",
  "lookup.relative": "相对日期",
  "lookup.absolute": "绝对日期",
  "lookup.datePlaceholder": "yyyy/MM/dd",
  "lookup.yesterday": "昨天",
  "lookup.today": "今天",
  "lookup.tomorrow": "明天",

  // Lookup calc methods
  "calc.original": "原值",
  "calc.deduplicate": "去重",
  "calc.count": "计数",
  "calc.deduplicateCount": "去重计数",
  "calc.sum": "求和",
  "calc.average": "平均值",
  "calc.max": "最大值",
  "calc.min": "最小值",

  // Lookup output formats
  "format.default": "默认",
  "format.text": "文本",
  "format.number": "数字",
  "format.date": "日期",
  "format.currency": "货币",
  "format.autoNumber": "自动编号",

  // Context menu
  "contextMenu.rename": "重命名",
  "contextMenu.delete": "删除",
  "contextMenu.moveTo": "移动到",
  "contextMenu.moveToRoot": "根目录",

  // Delete table
  "app.deleteTable": "删除数据表",
  "app.deleteTableMsg": "确定要删除数据表「{{name}}」吗？删除后不可恢复。",

  // Toast (rename)
  "toast.renameFailed": "重命名失败，修改已回退",

  // Create menu
  "createMenu.quickCreate": "快速创建",
  "createMenu.aiCreate": "通过AI创建",
  "createMenu.template": "模板中心",
  "createMenu.new": "新建",
  "createMenu.table": "数据表",
  "createMenu.form": "收集表",
  "createMenu.dashboard": "仪表盘",
  "createMenu.workflow": "工作流",
  "createMenu.doc": "文档",
  "createMenu.manage": "管理",
  "createMenu.folder": "文件夹",
  "createMenu.design": "设计稿",
  "createMenu.album": "相册",
  "createMenu.import": "导入/同步数据",
  "createMenu.appSection": "应用",
  "createMenu.app": "应用",

  // Toast (table creation)
  "toast.createTableFailed": "创建数据表失败",
  "toast.reorderFailed": "排序失败",

  // Default view/field names
  "view.defaultGrid": "表格",
  "defaultField.text": "文本",

  // AI Table Generation
  "aiTable.title": "数据表名称",
  "aiTable.placeholder": "准确的名称有助于 AI 生成表结构",
  "aiTable.create": "AI 创建表",
  "aiTable.generating": "正在规划字段名称",
  "aiTable.complete": "已创建 \u201C{{name}}\u201D",
  "aiTable.adopt": "效果不错，采纳",
  "aiTable.blank": "效果一般，重置为空白表",
  "aiTable.blankCreate": "创建空白表",
  "aiTable.failed": "AI 生成失败，请重试",
  "aiTable.creating": "正在规划字段名称",

  // Placeholder pages
  "placeholder.design": "选择一个设计稿进行预览",
  "placeholder.album": "选择一个相册查看",

  // Design panel
  "design.urlPlaceholder": "在此粘贴 Figma 链接",
  "design.create": "创建设计稿",
  "design.invalidUrl": "请输入有效的 Figma 链接",
  "design.goToEdit": "在 Figma 中打开",
  "design.copyLink": "复制链接",
  "design.linkCopied": "链接已复制",
  "design.linkCopyFailed": "复制失败，请重试",
  "design.panHint": "点击并拖动画布可平移，双指捏合可缩放",
  "design.panHintGotIt": "知道了",
  "design.loading": "正在加载设计稿...",
  "design.notFound": "未找到设计稿",
  "design.sharingHint": "请确保 Figma 文件已开启共享",

  // Folder
  "folder.defaultName": "新建文件夹",
  "folder.deleteConfirm": "确定要删除此文件夹吗？文件夹中的项目将被移动到根目录。",
};
