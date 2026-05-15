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

// ── Block-level SSE event payloads (PR-B) ──

export interface BlockUpdatePayload {
  blockId: string;
  content: string;
  type: string;
  props: Record<string, unknown>;
  blockVersion: number;
  ideaVersion: number;
}

export interface BlockCreatePayload {
  block: {
    id: string;
    order: number;
    type: string;
    content: string;
    props: Record<string, unknown>;
    version: number;
  };
  afterBlockId: string | null;
  ideaVersion: number;
}

export interface BlockDeletePayload {
  blockId: string;
  ideaVersion: number;
}

export interface BlockMovePayload {
  blockId: string;
  newOrder: number;
  ideaVersion: number;
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
  // V2 block-level events (PR-B)
  onBlockUpdate?: (payload: BlockUpdatePayload) => void;
  onBlockCreate?: (payload: BlockCreatePayload) => void;
  onBlockDelete?: (payload: BlockDeletePayload) => void;
  onBlockMove?: (payload: BlockMovePayload) => void;
  /** PR-C: fired when the SSE connection is re-established after a disconnect. */
  onReconnect?: () => void;
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

  // PR-C: track whether we've had an initial connection so subsequent
  // "connected" events can be identified as reconnections.
  const hadConnectionRef = useRef(false);

  useEffect(() => {
    if (!ideaId) return;
    hadConnectionRef.current = false;
    const url = `/api/sync/ideas/${ideaId}/events?clientId=${encodeURIComponent(clientId)}`;
    const es = new EventSource(url);

    es.addEventListener("connected", () => {
      const isReconnect = hadConnectionRef.current;
      hadConnectionRef.current = true;
      setConnected(true);
      if (isReconnect) {
        handlersRef.current.onReconnect?.();
      }
    });

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
          // V2 block-level events (PR-B)
          case "idea:block-update":
            h.onBlockUpdate?.(p);
            break;
          case "idea:block-create":
            h.onBlockCreate?.(p);
            break;
          case "idea:block-delete":
            h.onBlockDelete?.(p);
            break;
          case "idea:block-move":
            h.onBlockMove?.(p);
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
