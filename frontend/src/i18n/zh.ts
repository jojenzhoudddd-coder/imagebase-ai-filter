import type { TranslationKeys } from "./en";

export const zh: TranslationKeys = {
  // Sidebar
  "sidebar.search": "搜索",
  "sidebar.table": "数据表",
  "sidebar.dashboard": "仪表盘",
  "sidebar.workflow": "工作流",
  "sidebar.new": "新建",

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
  "viewTabs.addView": "添加视图",
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

  // Context menu
  "contextMenu.rename": "重命名",

  // Toast (rename)
  "toast.renameFailed": "重命名失败，修改已回退",
};
