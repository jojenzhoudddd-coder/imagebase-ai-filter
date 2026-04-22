import { useEffect, useRef, useState } from "react";

/**
 * Per-design SSE subscription.
 *
 * Design/Taste events flow through the workspace-level channel (same as
 * `idea:*` and `table:*`), so this hook subscribes to
 * `/api/sync/workspaces/:workspaceId/events` and filters client-side:
 *   - design:rename / design:delete / design:auto-layout   → match event.payload.designId
 *   - taste:create / taste:update / taste:delete           → match event.payload.designId
 *   - taste:meta-updated                                   → match event.payload.designId
 *
 * Mounted by `SvgCanvas` so the canvas stays in sync when the Chat Agent
 * (or another client) creates/moves/deletes tastes or finishes AI meta
 * generation. Scope is intentionally narrower than `useWorkspaceSync`:
 * SvgCanvas only cares about the design it's currently displaying.
 */
export interface DesignSyncHandlers {
  onTasteCreate?: (taste: {
    id: string;
    designId: string;
    name: string;
    x: number;
    y: number;
    width: number;
    height: number;
    filePath: string | null;
    source: string;
  }) => void;
  onTasteUpdate?: (update: {
    id?: string;
    updates?: Array<{ id: string; x?: number; y?: number; width?: number; height?: number; name?: string }>;
    taste?: { id: string; x: number; y: number; width: number; height: number; name: string };
    batch?: boolean;
  }) => void;
  onTasteDelete?: (tasteId: string) => void;
  onTasteMetaUpdated?: (info: { tasteId: string; hasMeta: boolean }) => void;
  onAutoLayout?: (info: {
    updates: Array<{ id: string; x: number; y: number }>;
    bounds: { width: number; height: number };
  }) => void;
  onDesignRename?: (name: string) => void;
  onDesignDelete?: () => void;
}

export function useDesignSync(
  workspaceId: string,
  clientId: string,
  designId: string,
  handlers: DesignSyncHandlers,
): { connected: boolean } {
  const [connected, setConnected] = useState(false);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const url = `/api/sync/workspaces/${workspaceId}/events?clientId=${encodeURIComponent(clientId)}`;
    const es = new EventSource(url);

    es.addEventListener("connected", () => setConnected(true));

    es.addEventListener("workspace-change", (e) => {
      try {
        const event = JSON.parse((e as MessageEvent).data);
        // Skip events we originated — the local UI already applied the change
        if (event.clientId === clientId) return;

        const h = handlersRef.current;
        const p = event.payload || {};

        // Only process events scoped to our design.
        const eventDesignId = p.designId ?? (p.design && p.design.id);
        if (eventDesignId && eventDesignId !== designId) return;

        switch (event.type) {
          case "taste:create":
            if (p.taste) h.onTasteCreate?.(p.taste);
            break;
          case "taste:update":
            h.onTasteUpdate?.({
              id: p.taste?.id,
              taste: p.taste,
              updates: p.updates,
              batch: Boolean(p.batch),
            });
            break;
          case "taste:delete":
            if (p.tasteId) h.onTasteDelete?.(p.tasteId);
            break;
          case "taste:meta-updated":
            h.onTasteMetaUpdated?.({
              tasteId: p.tasteId,
              hasMeta: Boolean(p.hasMeta),
            });
            break;
          case "design:auto-layout":
            h.onAutoLayout?.({ updates: p.updates || [], bounds: p.bounds || { width: 0, height: 0 } });
            break;
          case "design:rename":
            // design:rename payload uses {designId, name} shape (see designRoutes.ts)
            if (p.name) h.onDesignRename?.(p.name);
            break;
          case "design:delete":
            h.onDesignDelete?.();
            break;
        }
      } catch (err) {
        console.warn("[useDesignSync] failed to parse event:", err);
      }
    });

    es.onerror = () => setConnected(false);

    return () => es.close();
  }, [workspaceId, clientId, designId]);

  return { connected };
}
