import { useEffect, useRef, useState } from "react";

export interface IdeaStreamBeginPayload {
  sessionId: string;
  startOffset: number;
  anchor: { position?: "start" | "end"; section?: string; mode?: string };
  baseVersion: number;
}
export interface IdeaStreamDeltaPayload {
  sessionId: string;
  delta: string;
  bufferLength: number;
}
export interface IdeaStreamFinalizePayload {
  sessionId: string;
  discarded: boolean;
  finalContent: string;
  newVersion: number;
  reason?: string;
}

export interface IdeaSyncHandlers {
  onContentChange?: (content: string, version: number) => void;
  onRename?: (name: string) => void;
  /** Agent opened a streaming write channel — editor should soft-lock + suspend autosave. */
  onStreamBegin?: (payload: IdeaStreamBeginPayload) => void;
  /** Agent emitted a chunk — splice at (startOffset + already-accumulated length). */
  onStreamDelta?: (payload: IdeaStreamDeltaPayload) => void;
  /** Agent closed the stream. If discarded=false, overwrite buffer with finalContent + newVersion. */
  onStreamFinalize?: (payload: IdeaStreamFinalizePayload) => void;
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
          case "idea:stream-begin":
            h.onStreamBegin?.(p);
            break;
          case "idea:stream-delta":
            h.onStreamDelta?.(p);
            break;
          case "idea:stream-finalize":
            h.onStreamFinalize?.(p);
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
