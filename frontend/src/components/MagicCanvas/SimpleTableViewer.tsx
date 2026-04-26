/**
 * SimpleTableViewer —— per-block 表格内容查看器(V2 限制版)。
 *
 * 上下文:Magic Canvas V1 让多个 artifact block 共享 global activeTableId,所以
 * 多 block 同时打开 table 时内容一样。V2 完整方案要把 ~500 行 fields/records/
 * filter/undo state 抽到 per-tableId hook,工作量大。
 *
 * V2 折中:一个"主"artifact block(其 active 与 global activeTableId 一致)
 * 走 ArtifactViewContext 的 global render()(完整 UX:Toolbar/Filter/Undo/Customize/...)。
 * 其它 active.type=table 的 block 渲染本组件 —— 自包含 fetch + useTableSync,
 * 只读 + 简化 toolbar(只有 add record),编辑等高级功能交回主 block 操作。
 *
 * 优点:用户能"同时看到不同表",sidebar 高亮与内容一致。
 * 局限:从这里编辑要切到主 block。后续 V3 完整 lift state 后下线本组件。
 */

import { useEffect, useState, useRef, useCallback } from "react";
import type { Field, TableRecord } from "../../types";
import { fetchFields, fetchRecords, fetchViews, updateRecord, createRecord, CLIENT_ID } from "../../api";
import { useTableSync } from "../../hooks/useTableSync";
import TableView, { type TableViewHandle } from "../TableView/index";

interface Props {
  tableId: string;
}

export default function SimpleTableViewer({ tableId }: Props) {
  const [fields, setFields] = useState<Field[]>([]);
  const [records, setRecords] = useState<TableRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const tableViewRef = useRef<TableViewHandle>(null);

  // 加载初始数据
  useEffect(() => {
    let alive = true;
    setLoading(true);
    Promise.all([fetchFields(tableId), fetchRecords(tableId), fetchViews(tableId)])
      .then(([f, r]) => {
        if (!alive) return;
        setFields(f);
        setRecords(r);
        setLoading(false);
      })
      .catch(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [tableId]);

  // SSE 同步 —— 字段 / 记录 远程变化都重拉
  useTableSync(tableId, CLIENT_ID, {
    onRecordCreate: (record: TableRecord) =>
      setRecords((prev) => (prev.some((r) => r.id === record.id) ? prev : [...prev, record])),
    onRecordUpdate: (record: TableRecord) =>
      setRecords((prev) => prev.map((r) => (r.id === record.id ? record : r))),
    onRecordDelete: (recordId: string) => setRecords((prev) => prev.filter((r) => r.id !== recordId)),
    onRecordBatchDelete: (ids: string[]) => setRecords((prev) => prev.filter((r) => !ids.includes(r.id))),
    onRecordBatchCreate: (newRecords: TableRecord[]) =>
      setRecords((prev) => {
        const existing = new Set(prev.map((r) => r.id));
        return [...prev, ...newRecords.filter((r) => !existing.has(r.id))];
      }),
    onFieldCreate: (field: Field) => setFields((prev) => [...prev, field]),
    onFieldUpdate: (field: Field) => setFields((prev) => prev.map((f) => (f.id === field.id ? field : f))),
    onFieldDelete: (fieldId: string) => setFields((prev) => prev.filter((f) => f.id !== fieldId)),
    onFieldBatchDelete: (ids: string[]) => setFields((prev) => prev.filter((f) => !ids.includes(f.id))),
    onFieldBatchRestore: (restoredFields: Field[]) =>
      setFields((prev) => {
        const existing = new Set(prev.map((f) => f.id));
        return [...prev, ...restoredFields.filter((f) => !existing.has(f.id))];
      }),
  } as any);

  const handleCellChange = useCallback(
    (recordId: string, fieldId: string, value: any) => {
      // 乐观更新
      setRecords((prev) => prev.map((r) =>
        r.id === recordId ? { ...r, cells: { ...r.cells, [fieldId]: value } } : r,
      ));
      void updateRecord(tableId, recordId, { [fieldId]: value }).catch(() => undefined);
    },
    [tableId],
  );

  const handleAddRecord = useCallback(
    async (position?: "start" | "end"): Promise<string> => {
      const record = await createRecord(tableId, {});
      setRecords((prev) =>
        prev.some((r) => r.id === record.id)
          ? prev
          : position === "start"
            ? [record, ...prev]
            : [...prev, record],
      );
      return record.id;
    },
    [tableId],
  );

  if (loading) {
    return <div className="mc-artifact-empty">加载中…</div>;
  }

  return (
    <div className="mc-simple-table-viewer">
      <div className="mc-simple-table-viewer-hint">
        只读副本 —— 编辑请切到主 block (与全局 active table 一致的那一个)
      </div>
      <div className="mc-simple-table-viewer-body">
        <TableView
          ref={tableViewRef}
          fields={fields}
          records={records}
          onCellChange={handleCellChange}
          onAddRecord={handleAddRecord}
          fieldOrder={fields.map((f) => f.id)}
        />
      </div>
    </div>
  );
}
