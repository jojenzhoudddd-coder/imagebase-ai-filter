import { useEffect, useRef, useState, useCallback } from "react";

export interface WorkspaceSyncHandlers {
  onTableCreate: (table: { id: string; name: string; order: number }) => void;
  onTableDelete: (tableId: string) => void;
  onTableReorder: (updates: Array<{ id: string; order: number }>) => void;
  onTableRename: (tableId: string, name: string) => void;
}

export function useWorkspaceSync(
  workspaceId: string,
  clientId: string,
  handlers: WorkspaceSyncHandlers,
): { connected: boolean } {
  const [connected, setConnected] = useState(false);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const isReconnect = useRef(false);

  const doFullSync = useCallback(() => {
    // On reconnect, refetch the table list
    fetch(`/api/workspaces/${workspaceId}/tables`)
      .then(r => r.json())
      .then((tables: Array<{ id: string; name: string; order: number }>) => {
        // Emit as individual creates — the handler in App.tsx will reconcile
        for (const t of tables) {
          handlersRef.current.onTableCreate(t);
        }
      })
      .catch(err => console.warn("[useWorkspaceSync] full-sync failed:", err));
  }, [workspaceId]);

  useEffect(() => {
    const url = `/api/sync/workspaces/${workspaceId}/events?clientId=${encodeURIComponent(clientId)}`;
    const es = new EventSource(url);

    es.addEventListener("connected", () => {
      setConnected(true);
      if (isReconnect.current) {
        doFullSync();
      }
      isReconnect.current = true;
    });

    es.addEventListener("workspace-change", (e) => {
      try {
        const event = JSON.parse(e.data);
        if (event.clientId === clientId) return;

        const h = handlersRef.current;
        const p = event.payload;

        switch (event.type) {
          case "table:create":
            h.onTableCreate(p.table);
            break;
          case "table:delete":
            h.onTableDelete(p.tableId);
            break;
          case "table:reorder":
            h.onTableReorder(p.updates);
            break;
          case "table:rename":
            h.onTableRename(p.tableId, p.name);
            break;
        }
      } catch (err) {
        console.warn("[useWorkspaceSync] failed to parse event:", err);
      }
    });

    es.onerror = () => {
      setConnected(false);
    };

    return () => {
      es.close();
    };
  }, [workspaceId, clientId, doFullSync]);

  return { connected };
}
