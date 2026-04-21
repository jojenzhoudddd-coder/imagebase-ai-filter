import { useEffect, useRef, useState } from "react";

export interface IdeaSyncHandlers {
  onContentChange?: (content: string, version: number) => void;
  onRename?: (name: string) => void;
}

/**
 * Per-idea SSE channel. Mirrors `useWorkspaceSync`'s reconnect handling at the
 * entity level: the editor subscribes on open, the backend pushes every other
 * client's saves / renames into the channel, and we filter by clientId.
 */
export function useIdeaSync(
  ideaId: string | null,
  clientId: string,
  handlers: IdeaSyncHandlers,
): { connected: boolean } {
  const [connected, setConnected] = useState(false);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!ideaId) return;
    const url = `/api/sync/ideas/${ideaId}/events?clientId=${encodeURIComponent(clientId)}`;
    const es = new EventSource(url);

    es.addEventListener("connected", () => setConnected(true));

    es.addEventListener("idea-change", (e: MessageEvent) => {
      try {
        const event = JSON.parse(e.data);
        if (event.clientId === clientId) return;
        const h = handlersRef.current;
        const p = event.payload;
        switch (event.type) {
          case "idea:content-change":
            h.onContentChange?.(p.content, p.version);
            break;
          case "idea:rename":
            h.onRename?.(p.name);
            break;
        }
      } catch (err) {
        console.warn("[useIdeaSync] parse error:", err);
      }
    });

    es.onerror = () => setConnected(false);

    return () => {
      es.close();
      setConnected(false);
    };
  }, [ideaId, clientId]);

  return { connected };
}
