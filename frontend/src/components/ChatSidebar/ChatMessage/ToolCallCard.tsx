import { ToolCogIcon } from "../icons";
import type { ChatToolCall } from "../../../api";

// User-facing labels for each tool name. Falls back to the raw tool name.
const TOOL_LABELS: Record<string, string> = {
  list_tables: "查询数据表",
  get_table: "获取表详情",
  create_table: "创建数据表",
  rename_table: "重命名数据表",
  delete_table: "删除数据表",
  reset_table: "重置表结构",
  list_fields: "查询字段",
  create_field: "创建字段",
  update_field: "修改字段",
  delete_field: "删除字段",
  batch_delete_fields: "批量删除字段",
  query_records: "查询记录",
  create_record: "新增记录",
  batch_create_records: "批量新增记录",
  update_record: "修改记录",
  delete_record: "删除记录",
  batch_delete_records: "批量删除记录",
  list_views: "查询视图",
  create_view: "创建视图",
  update_view: "修改视图",
  delete_view: "删除视图",
};

function statusLabel(status?: string): string {
  switch (status) {
    case "running":
      return "执行中";
    case "success":
      return "已完成";
    case "error":
      return "失败";
    case "awaiting_confirmation":
      return "等待确认";
    default:
      return "";
  }
}

export default function ToolCallCard({ call }: { call: ChatToolCall }) {
  const label = TOOL_LABELS[call.tool] || call.tool;
  const status = call.status || "running";
  const targetTag = extractTargetTag(call.args);

  return (
    <div className={`chat-tool-card ${status}`}>
      {status === "running" ? <span className="chat-tool-spinner" /> : <ToolCogIcon size={14} className="chat-tool-icon" />}
      <span className="chat-tool-label">{label}</span>
      {targetTag && <span className="chat-tool-status">{targetTag}</span>}
      {status !== "running" && (
        <span className={`chat-tool-status ${status}`}>{statusLabel(status)}</span>
      )}
    </div>
  );
}

/** Try to extract a short, human-readable target label from common tool args. */
function extractTargetTag(args: Record<string, unknown>): string | null {
  if (!args) return null;
  if (typeof args.name === "string" && args.name) return args.name;
  if (typeof args.tableId === "string") {
    return args.tableId.length > 16 ? args.tableId.slice(0, 14) + "…" : args.tableId;
  }
  if (typeof args.viewId === "string") return args.viewId.slice(0, 14);
  if (typeof args.recordId === "string") return args.recordId.slice(0, 14);
  if (typeof args.fieldId === "string") return args.fieldId.slice(0, 14);
  return null;
}
