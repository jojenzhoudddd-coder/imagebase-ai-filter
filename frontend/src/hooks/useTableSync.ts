import { useEffect, useRef, useState, useCallback } from "react";
import { Field, TableRecord, View } from "../types";
import { fetchFields, fetchRecords, fetchViews } from "../api";

export interface TableSyncHandlers {
  onRecordCreate: (record: TableRecord) => void;
  onRecordUpdate: (recordId: string, cells: Record<string, any>, updatedAt: number) => void;
  onRecordDelete: (recordId: string) => void;
  onRecordBatchDelete: (recordIds: string[]) => void;
  onRecordBatchCreate: (records: TableRecord[]) => void;
  onFieldCreate: (field: Field) => void;
  onFieldUpdate: (fieldId: string, changes: { name?: string; config?: any }) => void;
  onFieldDelete: (fieldId: string) => void;
  onFieldBatchDelete: (fieldIds: string[]) => void;
  onFieldBatchRestore: (fields: Field[]) => void;
  onViewUpdate: (viewId: string, changes: Partial<View>) => void;
  onViewCreate: (view: View) => void;
  onViewDelete: (viewId: string) => void;
  onTableUpdate?: (changes: { name?: string }) => void;
  onDocumentUpdate?: (changes: { documentId: string; name: string }) => void;
  onFullSync: (fields: Field[], records: TableRecord[], views: View[]) => void;
}

export function useTableSync(
  tableId: string,
  clientId: string,
  handlers: TableSyncHandlers,
): { connected: boolean } {
  const [connected, setConnected] = useState(false);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const isReconnect = useRef(false);

  const doFullSync = useCallback(() => {
    Promise.all([
      fetchFields(tableId),
      fetchRecords(tableId),
      fetchViews(tableId),
    ]).then(([fields, records, views]) => {
      handlersRef.current.onFullSync(fields, records, views);
    }).catch((err) => {
      console.warn("[useTableSync] full-sync failed:", err);
    });
  }, [tableId]);

  useEffect(() => {
    const url = `/api/sync/${tableId}/events?clientId=${encodeURIComponent(clientId)}`;
    const es = new EventSource(url);

    es.addEventListener("connected", () => {
      setConnected(true);
      if (isReconnect.current) {
        doFullSync();
      }
      isReconnect.current = true;
    });

    es.addEventListener("table-change", (e) => {
      try {
        const event = JSON.parse(e.data);
        // Anti-echo: skip events from self
        if (event.clientId === clientId) return;

        const h = handlersRef.current;
        const p = event.payload;

        switch (event.type) {
          case "record:create":
            h.onRecordCreate(p.record);
            break;
          case "record:update":
            h.onRecordUpdate(p.recordId, p.cells, p.updatedAt);
            break;
          case "record:delete":
            h.onRecordDelete(p.recordId);
            break;
          case "record:batch-delete":
            h.onRecordBatchDelete(p.recordIds);
            break;
          case "record:batch-create":
            h.onRecordBatchCreate(p.records);
            break;
          case "field:create":
            h.onFieldCreate(p.field);
            break;
          case "field:update":
            h.onFieldUpdate(p.fieldId, p.changes);
            break;
          case "field:delete":
            h.onFieldDelete(p.fieldId);
            break;
          case "field:batch-delete":
            h.onFieldBatchDelete(p.fieldIds);
            break;
          case "field:batch-restore":
            h.onFieldBatchRestore(p.fields);
            break;
          case "view:create":
            h.onViewCreate(p.view);
            break;
          case "view:update":
            h.onViewUpdate(p.viewId, p.changes);
            break;
          case "view:delete":
            h.onViewDelete(p.viewId);
            break;
          case "table:update":
            h.onTableUpdate?.(p);
            break;
          case "document:update":
            h.onDocumentUpdate?.(p);
            break;
        }
      } catch (err) {
        console.warn("[useTableSync] failed to parse event:", err);
      }
    });

    es.onerror = () => {
      setConnected(false);
    };

    return () => {
      es.close();
    };
  }, [tableId, clientId, doFullSync]);

  return { connected };
}
