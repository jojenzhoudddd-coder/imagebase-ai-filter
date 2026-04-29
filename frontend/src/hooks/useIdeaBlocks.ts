/**
 * useIdeaBlocks (PR7) — fetch + keep in sync with `idea:content-change`.
 *
 * Wraps `GET /api/ideas/:id/blocks` and re-fetches whenever the per-idea
 * SSE channel announces a content change OR a stream finalize. Returns
 * `null` while loading / on error so callers can show a fallback.
 *
 * Source-of-truth invariant from PR6:
 *   `blocks.map(b => b.content).join("") === idea.content`
 *
 * The caller can also pass `localContent` (e.g. when the user is typing
 * in source mode) to derive a *synthetic* block list locally — that lets
 * preview rendering follow source-mode edits live without waiting for a
 * server round trip. See `parseLocalBlocks` below.
 *
 * 详见 docs/roadmap-post-skill-v1.md PR7.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchIdeaBlocks, type IdeaBlockBrief } from "../api";

interface IdeaContentChangeEvent {
  type: string;
  payload?: {
    content?: string;
    version?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface UseIdeaBlocksOptions {
  /** When set, consult this content (typically what the source-mode textarea
   *  is showing) instead of the last-fetched server content. The result is
   *  parsed locally — no server round trip. Set to `null` to defer to
   *  server blocks (initial load / after stream finalize). */
  localContent?: string | null;
  /** Called whenever the version we know about changes. Useful for the
   *  IdeaEditor parent to update its `versionRef`. */
  onVersion?: (version: number) => void;
  /** Required for the SSE subscription — the per-idea events endpoint
   *  rejects connections without `?clientId=…`. Pass the IdeaEditor's
   *  clientId (same as the one used for `useIdeaSync`). Without this,
   *  the SSE 400s, the FE never sees `idea:content-change` events, and
   *  block-level mutations (drag/delete/transform) appear "successful"
   *  but the rendered list stays stale. (2026-04-29: this was the actual
   *  cause of the "drag in preview不生效" bug — the move endpoint did
   *  succeed server-side, but useIdeaBlocks never refetched because its
   *  SSE never connected.) */
  clientId?: string;
}

export interface UseIdeaBlocksResult {
  /** Blocks for rendering. Either fetched from server or derived from
   *  `localContent`. `null` during initial load. */
  blocks: IdeaBlockBrief[] | null;
  /** Last known server version — useful for source-mode auto-save. */
  serverVersion: number | null;
  /** Force a refetch (e.g. after a successful save). */
  refetch: () => void;
  /** Loading flag (true on first load only; refetches keep stale data). */
  loading: boolean;
  /** Last fetch error, if any. */
  error: string | null;
}

export function useIdeaBlocks(
  ideaId: string,
  opts: UseIdeaBlocksOptions = {},
): UseIdeaBlocksResult {
  const { localContent, onVersion, clientId } = opts;
  const [serverBlocks, setServerBlocks] = useState<IdeaBlockBrief[] | null>(null);
  const [serverVersion, setServerVersion] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef<AbortController | null>(null);
  const onVersionRef = useRef(onVersion);
  onVersionRef.current = onVersion;

  const refetch = useCallback(() => {
    inFlightRef.current?.abort();
    const ac = new AbortController();
    inFlightRef.current = ac;
    fetchIdeaBlocks(ideaId)
      .then((res) => {
        if (ac.signal.aborted) return;
        setServerBlocks(res.blocks);
        setServerVersion(res.version);
        setError(null);
        onVersionRef.current?.(res.version);
      })
      .catch((err) => {
        if (ac.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (ac.signal.aborted) return;
        setLoading(false);
      });
  }, [ideaId]);

  // Initial fetch + ideaId change → re-fetch
  useEffect(() => {
    setLoading(true);
    refetch();
    return () => {
      inFlightRef.current?.abort();
    };
  }, [refetch]);

  // SSE invalidation: listen to the per-idea event stream. `idea:content-change`
  // and `idea:stream-finalize` both warrant a refetch. We deliberately do
  // NOT pull `payload.content` straight in — we want the server's parsed
  // block representation, not a client-side reparse of the broadcasted
  // content (the parser can subtly differ across client/server versions).
  useEffect(() => {
    // Backend rejects SSE without `?clientId=…` (sseRoutes.ts:11). Without
    // a clientId we'd silently 400 and never get refetch events — that's
    // the bug that made drag-in-preview look broken even though the move
    // endpoint succeeded server-side. We tolerate `clientId === undefined`
    // here (skip the subscription entirely rather than burning a 400) so
    // tests / non-editor consumers can use this hook in read-only mode.
    if (!clientId) return;
    const url = `/api/sync/ideas/${encodeURIComponent(ideaId)}/events?clientId=${encodeURIComponent(clientId)}`;
    const es = new EventSource(url);
    const refetchOnEvent = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as IdeaContentChangeEvent;
        // Refetch on EVERY event including our own echoes — the cost is
        // one SQL + JSON serialization, and the alternative (skip if
        // event.clientId === ours) would fail the case that triggered
        // this bug: a successful drag emits an event whose clientId
        // matches ours, so filtering would re-introduce the staleness.
        void data;
        refetch();
      } catch {
        /* ignore malformed events */
      }
    };
    es.addEventListener("idea:content-change", refetchOnEvent);
    es.addEventListener("idea:stream-finalize", refetchOnEvent);
    return () => {
      es.removeEventListener("idea:content-change", refetchOnEvent);
      es.removeEventListener("idea:stream-finalize", refetchOnEvent);
      es.close();
    };
  }, [ideaId, refetch, clientId]);

  // 2026-04-29 fix:always prefer serverBlocks when present, even if
  // `localContent` is set. Reason: localContent parsing produces synthetic
  // ids (`local-0`, `local-1`, …) that don't exist in DB, breaking
  // block-level mutations (move/delete/transform return 404).
  // localContent path is now only an initial-load fallback before the
  // first server fetch returns. Once serverBlocks is populated, we ride
  // SSE refreshes for updates — which run after autosave (~600ms after
  // last keystroke). The slight render lag is invisible because preview-
  // mode editing is contentEditable + per-block, so user keystrokes
  // appear in the DOM immediately regardless of React's view.
  const blocks: IdeaBlockBrief[] | null =
    serverBlocks ??
    (localContent != null ? parseLocalBlocks(localContent) : null);
  // Avoid linter complaint about unused `localContent` if user switches
  // off the fallback path. (No-op.)
  void localContent;

  return { blocks, serverVersion, refetch, loading, error };
}

// ─── Local parser (reduced subset of server parseToBlocks) ──────────────

/** Cheap client-side block split. Same byte-stable invariant as server.
 *  Less rich props (no slug dedupe, no html-tag detection), but the renderer
 *  doesn't strictly need them — react-markdown re-parses inline content. */
function parseLocalBlocks(input: string): IdeaBlockBrief[] {
  if (input.length === 0) return [];
  const lines: { text: string; raw: string }[] = [];
  let cursor = 0;
  while (cursor < input.length) {
    const nl = input.indexOf("\n", cursor);
    if (nl === -1) {
      lines.push({ text: input.slice(cursor), raw: input.slice(cursor) });
      break;
    }
    lines.push({ text: input.slice(cursor, nl), raw: input.slice(cursor, nl + 1) });
    cursor = nl + 1;
  }
  const blocks: IdeaBlockBrief[] = [];
  let i = 0;
  let blockSerial = 0;
  function push(type: string, startLine: number, endLineEx: number, props: Record<string, unknown> = {}) {
    blocks.push({
      id: `local-${blockSerial++}`,
      order: blockSerial,
      type,
      content: lines.slice(startLine, endLineEx).map((l) => l.raw).join(""),
      props,
    });
  }
  while (i < lines.length) {
    const ln = lines[i];
    if (ln.text.trim() === "") {
      if (blocks.length > 0) blocks[blocks.length - 1].content += ln.raw;
      else push("paragraph", i, i + 1);
      i++;
      continue;
    }
    const fence = ln.text.match(/^(\s*)(```|~~~)([^`~\s]*)\s*$/);
    if (fence) {
      const start = i;
      const indent = fence[1];
      const f = fence[2];
      const language = (fence[3] || "").trim() || null;
      i++;
      while (i < lines.length) {
        if (new RegExp(`^${indent}${f}+\\s*$`).test(lines[i].text)) {
          i++;
          break;
        }
        i++;
      }
      push("code", start, i, { language });
      continue;
    }
    const heading = ln.text.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      push("heading", i, i + 1, { level: heading[1].length, text: heading[2].trim() });
      i++;
      continue;
    }
    if (/^\s*(\*{3,}|-{3,}|_{3,})\s*$/.test(ln.text)) {
      push("divider", i, i + 1);
      i++;
      continue;
    }
    if (/^\s*>\s?/.test(ln.text)) {
      const start = i;
      while (i < lines.length && /^\s*>\s?/.test(lines[i].text)) i++;
      push("quote", start, i);
      continue;
    }
    if (/^(\s*)([-*+])\s+/.test(ln.text) || /^(\s*)(\d+)[.)]\s+/.test(ln.text)) {
      const start = i;
      const ordered = /^(\s*)(\d+)[.)]\s+/.test(ln.text);
      while (i < lines.length) {
        const l = lines[i].text;
        if (l.trim() === "") break;
        if (
          /^(\s*)([-*+])\s+/.test(l) ||
          /^(\s*)(\d+)[.)]\s+/.test(l) ||
          /^\s{2,}/.test(l)
        ) {
          i++;
          continue;
        }
        break;
      }
      push("list", start, i, { ordered });
      continue;
    }
    if (i + 1 < lines.length && /\|/.test(ln.text)) {
      const sep = lines[i + 1].text;
      if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(sep)) {
        const start = i;
        i += 2;
        while (i < lines.length && /\|/.test(lines[i].text) && lines[i].text.trim() !== "") i++;
        push("table", start, i);
        continue;
      }
    }
    if (/^\s*<(div|section|article|figure|aside|nav|header|footer|details|pre|svg|table)\b/i.test(ln.text)) {
      const tag = (ln.text.match(/<([a-z]+)/i)?.[1] ?? "div").toLowerCase();
      const start = i;
      const closeRe = new RegExp(`</${tag}\\s*>`, "i");
      if (closeRe.test(ln.text)) {
        i++;
      } else {
        i++;
        while (i < lines.length) {
          if (closeRe.test(lines[i].text)) {
            i++;
            break;
          }
          i++;
        }
      }
      push("html", start, i, { tag });
      continue;
    }
    const start = i;
    while (i < lines.length) {
      const l = lines[i].text;
      if (l.trim() === "") break;
      if (
        /^#{1,6}\s/.test(l) ||
        /^(\s*)(```|~~~)/.test(l) ||
        /^\s*(\*{3,}|-{3,}|_{3,})\s*$/.test(l) ||
        /^\s*>/.test(l) ||
        /^(\s*)([-*+])\s+/.test(l) ||
        /^(\s*)(\d+)[.)]\s+/.test(l)
      ) break;
      i++;
    }
    push("paragraph", start, i);
  }
  return blocks;
}
