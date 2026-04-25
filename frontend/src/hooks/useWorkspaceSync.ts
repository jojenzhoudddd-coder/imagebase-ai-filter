import { useEffect, useRef, useState, useCallback } from "react";

export interface WorkspaceSyncHandlers {
  onTableCreate: (table: { id: string; name: string; order: number }) => void;
  onTableDelete: (tableId: string) => void;
  onTableReorder: (updates: Array<{ id: string; order: number }>) => void;
  onTableRename: (tableId: string, name: string) => void;
  onIdeaCreate?: (idea: { id: string; name: string; parentId: string | null; order: number }) => void;
  onIdeaDelete?: (ideaId: string) => void;
  onIdeaRename?: (ideaId: string, name: string) => void;
  onIdeaReorder?: (updates: Array<{ id: string; order: number }>) => void;
  // Vibe Demo V1 — demo artifact events
  onDemoCreate?: (demo: { id: string; name: string; parentId: string | null; order: number }) => void;
  onDemoDelete?: (demoId: string) => void;
  onDemoRename?: (demoId: string, name: string) => void;
  onDemoReorder?: (updates: Array<{ id: string; order: number }>) => void;
  onDemoPublish?: (demoId: string, slug: string) => void;
  onDemoUnpublish?: (demoId: string) => void;
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

        // 通知顶栏 stats 刷新 —— 任何 artifact CRUD / publish / unpublish 都会
        // 改 artifacts/workend 数。TopBar 监听这个 window 事件做即时 refetch，
        // 避免它再独立开一条 SSE。
        try { window.dispatchEvent(new CustomEvent("workspace-stats-changed")); } catch { /* noop */ }

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
          case "idea:create":
            h.onIdeaCreate?.(p.idea);
            break;
          case "idea:delete":
            h.onIdeaDelete?.(p.ideaId);
            break;
          case "idea:rename":
            h.onIdeaRename?.(p.ideaId, p.name);
            break;
          case "idea:reorder":
            h.onIdeaReorder?.(p.updates);
            break;
          case "demo:create":
            h.onDemoCreate?.(p.demo);
            break;
          case "demo:delete":
            h.onDemoDelete?.(p.demoId);
            break;
          case "demo:rename":
            h.onDemoRename?.(p.demoId, p.name);
            break;
          case "demo:reorder":
            h.onDemoReorder?.(p.updates);
            break;
          case "demo:publish":
            h.onDemoPublish?.(p.demoId, p.slug);
            break;
          case "demo:unpublish":
            h.onDemoUnpublish?.(p.demoId);
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
