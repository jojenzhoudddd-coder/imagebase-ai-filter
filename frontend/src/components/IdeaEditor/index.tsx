import React, { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "../../i18n/index";
import { useToast } from "../Toast/index";
import InlineEdit from "../InlineEdit";
import SidebarExpandButton from "../SidebarExpandButton";
import BlockCloseButton from "../BlockCloseButton";
import { fetchIdea, saveIdeaContent, uploadIdeaAttachment, fetchIdeaBlocks, createIdeaBlock, patchIdeaBlock, deleteIdeaBlock, moveIdeaBlock } from "../../api";
import type { IdeaBlockBrief } from "../../api";
import { useIdeaSync } from "../../hooks/useIdeaSync";
import type {
  BlockUpdatePayload,
  BlockCreatePayload,
  BlockDeletePayload,
  BlockMovePayload,
} from "../../hooks/useIdeaSync";
import TiptapPreview from "./TiptapPreview";
import type { TiptapPreviewHandle } from "./TiptapPreview";
import CodeMirrorSource from "./CodeMirrorSource";
import type { CodeMirrorSourceHandle } from "./CodeMirrorSource";
import BlockItem from "./BlockItem";
import type { PatchBlockResponse } from "../../api";
import "./IdeaEditor.css";

interface Props {
  ideaId: string;
  ideaName: string;
  workspaceId: string;
  clientId: string;
  onRename: (name: string) => void;
  onNavigate: (target:
    | { type: "table"; id: string }
    | { type: "design"; id: string }
    | { type: "taste"; designId: string; tasteId: string }
    | { type: "idea"; id: string }
    | { type: "idea-section"; ideaId: string; headingSlug: string }
  ) => void;
}

const SOURCE_ICON = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
    <path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);
const PREVIEW_ICON = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
    <path d="M1.5 8s2.5-5 6.5-5 6.5 5 6.5 5-2.5 5-6.5 5-6.5-5-6.5-5z" stroke="currentColor" strokeWidth="1.3" fill="none"/>
    <circle cx="8" cy="8" r="2" fill="currentColor"/>
  </svg>
);
const AUTOSAVE_DEBOUNCE_MS = 600;
type SaveStatus = "idle" | "dirty" | "saving" | "saved" | "offline";

/** Normalize markdown for comparison: collapse blank lines, trim.
 *  Used to detect whether Tiptap's output differs from the original
 *  in a MEANINGFUL way (content change) vs just whitespace normalization. */
function normalizeMd(md: string): string {
  return md.replace(/\n{2,}/g, "\n\n").trim();
}

export default function IdeaEditor({ ideaId, ideaName, workspaceId, clientId, onRename }: Props) {
  const { t } = useTranslation();
  const toast = useToast();

  const [content, setContent] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [isEditingName, setIsEditingName] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [streaming, setStreaming] = useState(false);
  const [mode, setMode] = useState<"source" | "preview">("preview");
  const [blocks, setBlocks] = useState<IdeaBlockBrief[]>([]);
  const [focusBlockId, setFocusBlockId] = useState<string | null>(null);
  const [autoEditBlockId, setAutoEditBlockId] = useState<string | null>(null);
  const [focusTrigger, setFocusTrigger] = useState(0);
  const [focusCursorPos, setFocusCursorPos] = useState<number | null>(null);

  const cmRef = useRef<CodeMirrorSourceHandle>(null);
  const previewRef = useRef<TiptapPreviewHandle>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const blockListRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef(content);
  useEffect(() => { contentRef.current = content; }, [content]);

  // PR-C: track focused block + pending remote updates for conflict resolution
  const focusBlockIdRef = useRef<string | null>(null);
  useEffect(() => { focusBlockIdRef.current = focusBlockId; }, [focusBlockId]);
  const pendingRemoteBlockRef = useRef<Set<string>>(new Set());

  // Unified direct DOM focus: runs after React commits new blocks to DOM
  useEffect(() => {
    if (!focusBlockId || focusTrigger === 0) return;
    const container = blockListRef.current;
    if (!container) return;
    // Find the textarea inside the block with matching data-block-id
    const blockEl = container.querySelector(`[data-block-id="${focusBlockId}"] textarea`) as HTMLTextAreaElement
      ?? container.querySelector(`[data-block-id="${focusBlockId}"]`) as HTMLTextAreaElement;
    if (!blockEl || blockEl.tagName !== "TEXTAREA") return;
    blockEl.focus();
    const pos = focusCursorPos != null ? Math.min(focusCursorPos, blockEl.value.length) : 0;
    blockEl.selectionStart = blockEl.selectionEnd = pos;
  }, [focusBlockId, focusTrigger, focusCursorPos]);

  const mergingRef = useRef(false);
  const versionRef = useRef(0);
  const dirtyRef = useRef(false);
  const saveTimerRef = useRef<number | null>(null);
  const modeRef = useRef(mode);
  useEffect(() => { modeRef.current = mode; }, [mode]);

  const streamSessionIdRef = useRef<string | null>(null);
  const streamBaseRef = useRef("");
  const streamStartOffsetRef = useRef(0);
  const streamBufferRef = useRef("");

  /** Read the "best" current content for saving.
   *  In preview mode, if the user made real content changes (not just
   *  whitespace normalization by Tiptap), use Tiptap's version.
   *  Otherwise keep the original markdown (preserves blank lines). */
  const getCurrentContent = useCallback(() => {
    if (modeRef.current === "preview" && previewRef.current?.isDirty()) {
      const tiptapMd = previewRef.current.getMarkdown();
      // Compare normalized: if the only difference is blank lines / whitespace,
      // the user didn't make a real edit → keep original.
      if (normalizeMd(tiptapMd) === normalizeMd(contentRef.current)) {
        return contentRef.current; // preserve blank lines
      }
      return tiptapMd; // real content change
    }
    return contentRef.current;
  }, []);

  // ── Load idea + blocks ──
  useEffect(() => {
    let alive = true;
    setLoaded(false);
    setContent("");
    setBlocks([]);
    setSaveStatus("idle");
    versionRef.current = 0;
    Promise.all([
      fetchIdea(ideaId),
      fetchIdeaBlocks(ideaId).catch(() => null),
    ])
      .then(([idea, blocksRes]) => {
        if (!alive) return;
        setContent(idea.content || "");
        versionRef.current = idea.version ?? 0;
        if (blocksRes?.blocks) {
          setBlocks(blocksRes.blocks);
        }
        if (!idea.content) setMode("source");
        setLoaded(true);
      })
      .catch((err) => {
        if (!alive) return;
        console.warn("[IdeaEditor] load failed:", err);
        setLoaded(true);
      });
    return () => { alive = false; };
  }, [ideaId]);

  // ── Autosave ──
  const flushSave = useCallback(async () => {
    const text = getCurrentContent();
    setSaveStatus("saving");
    try {
      const res = await saveIdeaContent(ideaId, text, versionRef.current);
      if ("conflict" in res && res.conflict) {
        versionRef.current = res.latest.version;
        setContent(res.latest.content);
        dirtyRef.current = false;
        setSaveStatus("saved");
        toast.info(t("toast.ideaConflict"));
      } else if ("ok" in res) {
        versionRef.current = res.version;
        dirtyRef.current = false;
        previewRef.current?.clearDirty();
        setSaveStatus("saved");
        // Sync BOTH contentRef and content state with what was actually
        // saved. contentRef keeps the ref fresh for save callbacks;
        // setContent keeps the React state (and TiptapPreview's `source`
        // prop) in sync so that component remounts, layout changes, or
        // SSE sync effects don't revert to stale content that's missing
        // images dropped in preview mode.
        contentRef.current = text;
        setContent(text);
      }
    } catch {
      setSaveStatus("offline");
    }
  }, [ideaId, toast, t, getCurrentContent]);

  const scheduleSave = useCallback(() => {
    if (streamSessionIdRef.current) return;
    dirtyRef.current = true;
    setSaveStatus("dirty");
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      void flushSave();
    }, AUTOSAVE_DEBOUNCE_MS);
  }, [flushSave]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      if (dirtyRef.current) {
        // In preview mode, try to get the latest markdown from Tiptap
        // (includes image drops etc). Fall back to contentRef if the
        // editor was already destroyed during unmount.
        let text = contentRef.current;
        try {
          if (modeRef.current === "preview" && previewRef.current?.isDirty()) {
            text = previewRef.current.getMarkdown() || text;
          }
        } catch { /* editor destroyed — use contentRef */ }
        void saveIdeaContent(ideaId, text, versionRef.current).catch(() => {});
        dirtyRef.current = false;
      }
    };
  }, [ideaId]);

  // ── SSE sync ──
  useIdeaSync(ideaId, clientId, {
    onContentChange: useCallback((remoteContent: string, remoteVersion: number) => {
      if (dirtyRef.current) return;
      if (mergingRef.current) return; // suppress during merge/split operations
      setContent(remoteContent);
      versionRef.current = remoteVersion;
    }, []),
    onRename: useCallback(() => {}, []),
    onStreamBegin: useCallback((p: { sessionId: string; startOffset: number }) => {
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      dirtyRef.current = false;
      streamSessionIdRef.current = p.sessionId;
      streamBaseRef.current = contentRef.current;
      streamStartOffsetRef.current = Math.min(p.startOffset, contentRef.current.length);
      streamBufferRef.current = "";
      setStreaming(true);
      setSaveStatus("saved");
    }, []),
    onStreamDelta: useCallback((p: { sessionId: string; delta: string }) => {
      if (streamSessionIdRef.current !== p.sessionId) return;
      streamBufferRef.current += p.delta;
      const base = streamBaseRef.current;
      const off = streamStartOffsetRef.current;
      setContent(base.slice(0, off) + streamBufferRef.current + base.slice(off));
    }, []),
    onStreamFinalize: useCallback((p: { sessionId: string; discarded: boolean; finalContent: string; newVersion: number }) => {
      if (streamSessionIdRef.current !== p.sessionId) return;
      setContent(p.finalContent);
      versionRef.current = p.newVersion;
      streamSessionIdRef.current = null;
      streamBaseRef.current = "";
      streamBufferRef.current = "";
      streamStartOffsetRef.current = 0;
      setStreaming(false);
      dirtyRef.current = false;
      setSaveStatus("saved");
      // Force TiptapPreview to apply the final content even if the editor
      // is focused. Without this, the useEffect sync in TiptapPreview skips
      // the update when editor.isFocused is true, leaving stale/partial
      // content (e.g. truncated vega-lite JSON from mid-stream).
      requestAnimationFrame(() => {
        previewRef.current?.reload();
      });
      // After stream finalize, refetch blocks for preview mode
      fetchIdeaBlocks(ideaId).then((res) => {
        setBlocks(res.blocks);
      }).catch(() => {});
    }, [ideaId]),
    // ── Block-level SSE events (PR-B + PR-C) ──
    onBlockUpdate: useCallback((p: BlockUpdatePayload) => {
      if (mergingRef.current) return; // suppress during merge/split
      if (focusBlockIdRef.current === p.blockId) {
        pendingRemoteBlockRef.current.add(p.blockId);
        // Still update version so next save uses correct baseVersion
        versionRef.current = p.ideaVersion;
        return;
      }
      setBlocks((prev) => {
        const next = prev.map((b) =>
          b.id === p.blockId
            ? { ...b, content: p.content, type: p.type, props: p.props }
            : b,
        );
        contentRef.current = next.map((b) => b.content).join("");
        setContent(contentRef.current);
        versionRef.current = p.ideaVersion;
        return next;
      });
    }, []),
    onBlockCreate: useCallback((p: BlockCreatePayload) => {
      setBlocks((prev) => {
        const newBlock: IdeaBlockBrief = {
          id: p.block.id,
          order: p.block.order,
          type: p.block.type,
          content: p.block.content,
          props: p.block.props as Record<string, unknown>,
        };
        if (p.afterBlockId === null) {
          // afterBlockId null means prepend (insert at beginning)
          const next = [newBlock, ...prev];
          contentRef.current = next.map((b) => b.content).join("");
          setContent(contentRef.current);
          versionRef.current = p.ideaVersion;
          return next;
        }
        const idx = prev.findIndex((b) => b.id === p.afterBlockId);
        const next = [...prev];
        if (idx === -1) {
          next.push(newBlock);
        } else {
          next.splice(idx + 1, 0, newBlock);
        }
        contentRef.current = next.map((b) => b.content).join("");
        setContent(contentRef.current);
        versionRef.current = p.ideaVersion;
        return next;
      });
    }, []),
    onBlockDelete: useCallback((p: BlockDeletePayload) => {
      if (mergingRef.current) return; // suppress during merge/split
      if (focusBlockIdRef.current === p.blockId) {
        setFocusBlockId(null);
        toast.info(t("toast.ideaConflict"));
      }
      pendingRemoteBlockRef.current.delete(p.blockId);
      setBlocks((prev) => {
        const next = prev.filter((b) => b.id !== p.blockId);
        contentRef.current = next.map((b) => b.content).join("");
        setContent(contentRef.current);
        versionRef.current = p.ideaVersion;
        return next;
      });
    }, [toast, t]),
    onBlockMove: useCallback((p: BlockMovePayload) => {
      setBlocks((prev) => {
        const next = prev.map((b) =>
          b.id === p.blockId ? { ...b, order: p.newOrder } : b,
        );
        next.sort((a, b) => a.order - b.order);
        contentRef.current = next.map((b) => b.content).join("");
        setContent(contentRef.current);
        versionRef.current = p.ideaVersion;
        return next;
      });
    }, []),
    // PR-C: on SSE reconnect, re-fetch blocks and content to catch up
    onReconnect: useCallback(() => {
      Promise.all([
        fetchIdea(ideaId),
        fetchIdeaBlocks(ideaId).catch(() => null),
      ]).then(([idea, blocksRes]) => {
        setContent(idea.content || "");
        contentRef.current = idea.content || "";
        versionRef.current = idea.version ?? 0;
        if (blocksRes?.blocks) {
          setBlocks(blocksRes.blocks);
        }
      }).catch((err) => {
        console.warn("[IdeaEditor] reconnect re-fetch failed:", err);
      });
    }, [ideaId]),
  });

  // ── Source mode change ──
  const handleSourceChange = useCallback((text: string, _caret: number) => {
    if (text === contentRef.current) return;
    setContent(text);
    scheduleSave();
  }, [scheduleSave]);

  // ── Preview mode dirty signal ──
  // Eagerly sync contentRef with Tiptap's current markdown so that if the
  // component unmounts before the autosave debounce fires, the cleanup
  // effect uses the latest content (including dropped images) instead of
  // stale contentRef that predates the edit.
  const handlePreviewDirty = useCallback(() => {
    try {
      const md = previewRef.current?.getMarkdown();
      if (md) contentRef.current = md;
    } catch { /* editor not ready */ }
    scheduleSave();
  }, [scheduleSave]);

  // ── File upload ──
  const uploadAndInsert = useCallback(async (files: File[]) => {
    for (const file of files) {
      try {
        const att = await uploadIdeaAttachment(ideaId, file);
        const alt = (att.originalName || "image").replace(/[\[\]]/g, "");
        const isImage = att.mime.startsWith("image/");
        const md = isImage ? `![${alt}](${att.url})` : `[${alt}](${att.url})`;
        if (modeRef.current === "source" && cmRef.current) {
          cmRef.current.insertAtCaret(md + "\n");
          const view = cmRef.current.getView();
          if (view) {
            const next = view.state.doc.toString();
            setContent(next);
            scheduleSave();
          }
        } else {
          const cur = contentRef.current;
          const next = cur + (cur.endsWith("\n") ? "" : "\n") + md + "\n";
          setContent(next);
          scheduleSave();
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        toast.error(t("idea.uploadFailed") + `: ${msg}`);
      }
    }
  }, [ideaId, scheduleSave, toast, t]);

  const handleSourcePasteFiles = useCallback((files: File[]) => {
    if (streamSessionIdRef.current) return;
    void uploadAndInsert(files);
  }, [uploadAndInsert]);

  const handleSourceDropFiles = useCallback((files: File[]) => {
    if (streamSessionIdRef.current) return;
    void uploadAndInsert(files);
  }, [uploadAndInsert]);

  const handleImageUpload = useCallback(async (file: File) => {
    const att = await uploadIdeaAttachment(ideaId, file);
    return { url: att.url, mime: att.mime, originalName: att.originalName };
  }, [ideaId]);

  // ── Block edit callbacks (PR-B + PR-C) ──

  // PR-C: track block focus for conflict resolution
  const handleBlockFocusChange = useCallback((blockId: string, focused: boolean) => {
    if (focused) {
      setFocusBlockId(blockId);
    } else {
      setFocusBlockId((prev) => (prev === blockId ? null : prev));
      // When user exits edit mode on a block with pending remote updates,
      // reload blocks from server to apply the remote version
      if (pendingRemoteBlockRef.current.has(blockId)) {
        pendingRemoteBlockRef.current.delete(blockId);
        fetchIdeaBlocks(ideaId).then((bRes) => {
          setBlocks(bRes.blocks);
          const newContent = bRes.blocks.map((b: IdeaBlockBrief) => b.content).join("");
          contentRef.current = newContent;
          setContent(newContent);
          versionRef.current = bRes.version;
        }).catch(() => {});
      }
    }
  }, [ideaId]);

  const handleBlockSaved = useCallback((res: PatchBlockResponse) => {
    // Update contentRef and content state from the server response
    contentRef.current = res.content;
    setContent(res.content);
    versionRef.current = res.version;
    // Clear any pending remote flag for this block since we just saved
    pendingRemoteBlockRef.current.clear();
    // Refetch blocks to stay in sync
    fetchIdeaBlocks(ideaId).then((bRes) => {
      setBlocks(bRes.blocks);
    }).catch(() => {});
  }, [ideaId]);

  const handleBlockDeleted = useCallback((_blockId: string) => {
    // Refetch blocks and content after delete
    fetchIdeaBlocks(ideaId).then((bRes) => {
      setBlocks(bRes.blocks);
      const newContent = bRes.blocks.map((b: IdeaBlockBrief) => b.content).join("");
      contentRef.current = newContent;
      setContent(newContent);
      versionRef.current = bRes.version;
    }).catch(() => {});
  }, [ideaId]);

  const handleBlockCreatedAfter = useCallback((newBlock: { id: string; order: number; type: string; content: string; props: Record<string, unknown>; version: number }) => {
    // Add the new block to state and focus it
    setBlocks((prev) => {
      const inserted: IdeaBlockBrief = {
        id: newBlock.id,
        order: newBlock.order,
        type: newBlock.type,
        content: newBlock.content,
        props: newBlock.props,
      };
      const next = [...prev, inserted];
      next.sort((a, b) => a.order - b.order);
      return next;
    });
    setAutoEditBlockId(newBlock.id);
    setFocusBlockId(newBlock.id);
    setFocusTrigger(n => n + 1);
    // Refetch to sync content
    fetchIdeaBlocks(ideaId).then((bRes) => {
      setBlocks(bRes.blocks);
      const newContent = bRes.blocks.map((b: IdeaBlockBrief) => b.content).join("");
      contentRef.current = newContent;
      setContent(newContent);
      versionRef.current = bRes.version;
    }).catch(() => {});
  }, [ideaId]);

  const handleBlockConflict = useCallback(() => {
    toast.info(t("toast.ideaConflict"));
    // Reload blocks from server on conflict
    fetchIdeaBlocks(ideaId).then((bRes) => {
      setBlocks(bRes.blocks);
      const newContent = bRes.blocks.map((b: IdeaBlockBrief) => b.content).join("");
      contentRef.current = newContent;
      setContent(newContent);
      versionRef.current = bRes.version;
    }).catch(() => {});
  }, [ideaId, toast, t]);

  // ── Source mode: split and merge blocks ──

  const handleSplit = useCallback(async (blockId: string, contentBefore: string, contentAfter: string) => {
    mergingRef.current = true;
    const before = contentBefore.replace(/\n+$/, "") + "\n";
    const after = (contentAfter.replace(/^\n+/, "").replace(/\n+$/, "") || "") + "\n";
    // Temp ID for optimistic new block
    const tempId = `temp_${Date.now()}`;

    // Optimistic local update
    setBlocks(prev => {
      const idx = prev.findIndex(b => b.id === blockId);
      if (idx < 0) return prev;
      const updated = { ...prev[idx], content: before };
      const newBlock: IdeaBlockBrief = {
        id: tempId, order: updated.order + 0.5, type: "paragraph",
        content: after, props: {},
      };
      const next = [...prev];
      next[idx] = updated;
      next.splice(idx + 1, 0, newBlock);
      contentRef.current = next.map(b => b.content).join("");
      setContent(contentRef.current);
      return next;
    });
    setFocusBlockId(tempId);
    setFocusCursorPos(0);
    setFocusTrigger(n => n + 1);

    // API calls in background
    try {
      await patchIdeaBlock(ideaId, blockId, { content: before });
      const res = await createIdeaBlock(ideaId, { type: "paragraph", content: after, afterBlockId: blockId });
      // Replace temp ID with real ID and sync
      const bRes = await fetchIdeaBlocks(ideaId);
      setBlocks(bRes.blocks);
      contentRef.current = bRes.blocks.map((b: IdeaBlockBrief) => b.content).join("");
      setContent(contentRef.current);
      versionRef.current = bRes.version;
      // Update focus to real block ID
      setFocusBlockId(res.block.id);
      setFocusTrigger(n => n + 1);
    } catch (err) {
      console.error("[IdeaEditor] split failed:", err);
      const bRes = await fetchIdeaBlocks(ideaId).catch(() => null);
      if (bRes) {
        setBlocks(bRes.blocks);
        contentRef.current = bRes.blocks.map((b: IdeaBlockBrief) => b.content).join("");
        setContent(contentRef.current);
        versionRef.current = bRes.version;
      }
    } finally {
      setTimeout(() => { mergingRef.current = false; }, 200);
    }
  }, [ideaId]);

  const handleMergeIntoPrev = useCallback(async (blockId: string, contentToAppend: string) => {
    if (mergingRef.current) return;
    const idx = blocks.findIndex(b => b.id === blockId);
    if (idx <= 0) return;
    const prevBlock = blocks[idx - 1];
    const prevText = prevBlock.content.replace(/\n+$/, "");
    const appendText = contentToAppend.replace(/\n+$/, "");
    const cursorPos = prevText.length;
    const mergedContent = prevText + appendText + "\n";
    mergingRef.current = true;

    // Optimistic local update FIRST — remove deleted block, update prev block content
    setBlocks(prev => {
      const next = prev
        .filter(b => b.id !== blockId)
        .map(b => b.id === prevBlock.id ? { ...b, content: mergedContent } : b);
      contentRef.current = next.map(b => b.content).join("");
      setContent(contentRef.current);
      return next;
    });
    setFocusBlockId(prevBlock.id);
    focusBlockIdRef.current = prevBlock.id;
    setFocusCursorPos(cursorPos);
    setFocusTrigger(n => n + 1);

    // API calls in background
    try {
      await patchIdeaBlock(ideaId, prevBlock.id, { content: mergedContent });
      await deleteIdeaBlock(ideaId, blockId).catch(() => {}); // 404 OK — may already be gone
      // Sync version from server
      const bRes = await fetchIdeaBlocks(ideaId);
      versionRef.current = bRes.version;
    } catch (err) {
      console.error("[IdeaEditor] merge failed:", err);
      // Rollback: refetch
      const bRes = await fetchIdeaBlocks(ideaId).catch(() => null);
      if (bRes) {
        setBlocks(bRes.blocks);
        contentRef.current = bRes.blocks.map((b: IdeaBlockBrief) => b.content).join("");
        setContent(contentRef.current);
        versionRef.current = bRes.version;
      }
    } finally {
      setTimeout(() => { mergingRef.current = false; }, 200);
    }
  }, [ideaId, blocks]);

  // ── Block drag reorder + column layout ──
  type DropTarget =
    | { type: "reorder"; insertIdx: number }
    | { type: "column-left"; targetBlockId: string }
    | { type: "column-right"; targetBlockId: string };

  const [dragBlockId, setDragBlockId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [ghostPos, setGhostPos] = useState<{ x: number; y: number } | null>(null);
  const dragStartPos = useRef<{ x: number; y: number } | null>(null);
  const dragGhostRef = useRef<HTMLDivElement | null>(null);
  const dragActive = useRef(false);

  // Column resize state
  const [resizingGroup, setResizingGroup] = useState<string | null>(null);
  const resizeStartX = useRef(0);
  const resizeStartRatio = useRef(0.5);
  const resizeContainerRect = useRef<DOMRect | null>(null);

  /** Group blocks by columnGroupId for rendering */
  const blockLayout = useMemo(() => {
    const layout: Array<{ type: "single"; block: IdeaBlockBrief } | { type: "column"; groupId: string; left: IdeaBlockBrief; right: IdeaBlockBrief; ratio: number }> = [];
    const visited = new Set<string>();
    for (let i = 0; i < blocks.length; i++) {
      if (visited.has(blocks[i].id)) continue;
      const b = blocks[i];
      const groupId = (b.props as any)?.columnGroupId as string | undefined;
      if (groupId) {
        // Find the partner
        const partner = blocks.find((ob, j) => j !== i && !visited.has(ob.id) && (ob.props as any)?.columnGroupId === groupId);
        if (partner) {
          visited.add(b.id);
          visited.add(partner.id);
          const bPos = (b.props as any)?.columnPosition;
          const partnerPos = (partner.props as any)?.columnPosition;
          const left = bPos === "left" ? b : partnerPos === "left" ? partner : b;
          const right = left === b ? partner : b;
          const ratio = (left.props as any)?.columnRatio ?? 0.5;
          layout.push({ type: "column", groupId, left, right, ratio });
          continue;
        }
      }
      visited.add(b.id);
      layout.push({ type: "single", block: b });
    }
    return layout;
  }, [blocks]);

  const handleBlockDragStart = useCallback((blockId: string) => {
    if (mode === "source" || streaming) return;
    console.log("[drag] START blockId:", blockId);
    setDragBlockId(blockId);
    dragActive.current = false;
    const handler = (e: PointerEvent) => {
      if (!dragActive.current) {
        dragActive.current = true;
        dragStartPos.current = { x: e.clientX, y: e.clientY };
        console.log("[drag] ACTIVE");
      }
      setGhostPos({ x: e.clientX, y: e.clientY });
      // Calculate drop target
      const container = blockListRef.current;
      if (!container) return;
      const blockEls = container.querySelectorAll<HTMLElement>("[data-block-id]");
      let foundTarget: DropTarget | null = null;
      for (let i = 0; i < blockEls.length; i++) {
        const el = blockEls[i];
        const elBlockId = el.getAttribute("data-block-id");
        if (elBlockId === blockId) continue;
        const rect = el.getBoundingClientRect();
        if (e.clientY >= rect.top && e.clientY <= rect.bottom) {
          const relX = e.clientX - rect.left;
          const width = rect.width;
          if (relX < width * 0.2) {
            // Left edge → column-left
            foundTarget = { type: "column-left", targetBlockId: elBlockId! };
          } else if (relX > width * 0.8) {
            // Right edge → column-right
            foundTarget = { type: "column-right", targetBlockId: elBlockId! };
          } else {
            // Middle → reorder
            const midY = rect.top + rect.height / 2;
            const idx = blocks.findIndex(b => b.id === elBlockId);
            if (idx >= 0) {
              foundTarget = { type: "reorder", insertIdx: e.clientY < midY ? idx : idx + 1 };
            }
          }
          break;
        }
      }
      // If no block hit, check if below all blocks
      if (!foundTarget && blockEls.length > 0) {
        const lastRect = blockEls[blockEls.length - 1].getBoundingClientRect();
        if (e.clientY > lastRect.bottom) {
          foundTarget = { type: "reorder", insertIdx: blocks.length };
        }
        const firstRect = blockEls[0].getBoundingClientRect();
        if (e.clientY < firstRect.top) {
          foundTarget = { type: "reorder", insertIdx: 0 };
        }
      }
      if (foundTarget) console.log("[drag] dropTarget:", foundTarget);
      setDropTarget(foundTarget);
    };
    const upHandler = () => {
      document.removeEventListener("pointermove", handler);
      document.removeEventListener("pointerup", upHandler);
      document.removeEventListener("keydown", escHandler);
      if (dragActive.current && dropTarget) {
        // Will be handled by the effect below
      }
      // Commit happens via the dragBlockId + dropTarget effect
      // Just mark inactive; the state update will trigger commit
      if (!dragActive.current) {
        // No real drag happened — just deselect
        setDragBlockId(null);
        setDropTarget(null);
        setGhostPos(null);
      } else {
        // Drop will be handled in effect
        setGhostPos(null);
        dragActive.current = false;
      }
    };
    const escHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        document.removeEventListener("pointermove", handler);
        document.removeEventListener("pointerup", upHandler);
        document.removeEventListener("keydown", escHandler);
        setDragBlockId(null);
        setDropTarget(null);
        setGhostPos(null);
        dragActive.current = false;
      }
    };
    document.addEventListener("pointermove", handler);
    document.addEventListener("pointerup", upHandler);
    document.addEventListener("keydown", escHandler);
  }, [mode, streaming, blocks]);

  // Handle drop commit
  const dropTargetRef = useRef<DropTarget | null>(null);
  useEffect(() => { dropTargetRef.current = dropTarget; }, [dropTarget]);

  // Commit on pointerup (ghostPos becomes null while dragBlockId is set)
  useEffect(() => {
    if (dragBlockId && ghostPos === null && dragActive.current === false) {
      const target = dropTargetRef.current;
      if (target && dragBlockId) {
        const blockId = dragBlockId;
        setDragBlockId(null);
        setDropTarget(null);

        if (target.type === "reorder") {
          // Remove column props if dragged block was in a column
          const draggedBlock = blocks.find(b => b.id === blockId);
          const groupId = (draggedBlock?.props as any)?.columnGroupId;
          if (groupId) {
            // Break column: remove group props from both blocks
            const partner = blocks.find(b => b.id !== blockId && (b.props as any)?.columnGroupId === groupId);
            void (async () => {
              await patchIdeaBlock(ideaId, blockId, { props: { columnGroupId: null, columnPosition: null, columnRatio: null } });
              if (partner) {
                await patchIdeaBlock(ideaId, partner.id, { props: { columnGroupId: null, columnPosition: null, columnRatio: null } });
              }
              await moveIdeaBlock(ideaId, blockId, target.insertIdx);
              const bRes = await fetchIdeaBlocks(ideaId);
              setBlocks(bRes.blocks);
              contentRef.current = bRes.blocks.map((b: IdeaBlockBrief) => b.content).join("");
              setContent(contentRef.current);
              versionRef.current = bRes.version;
            })();
          } else {
            void (async () => {
              await moveIdeaBlock(ideaId, blockId, target.insertIdx);
              const bRes = await fetchIdeaBlocks(ideaId);
              setBlocks(bRes.blocks);
              contentRef.current = bRes.blocks.map((b: IdeaBlockBrief) => b.content).join("");
              setContent(contentRef.current);
              versionRef.current = bRes.version;
            })();
          }
        } else if (target.type === "column-left" || target.type === "column-right") {
          const targetBlockId = target.targetBlockId;
          const targetBlock = blocks.find(b => b.id === targetBlockId);
          const draggedBlock = blocks.find(b => b.id === blockId);
          if (!targetBlock || !draggedBlock) return;

          // Check if target is already in a column (max 2 columns)
          const targetGroupId = (targetBlock.props as any)?.columnGroupId;
          if (targetGroupId) {
            // Target already in a column, can't add more
            return;
          }

          // Break dragged block's existing column if any
          const draggedGroupId = (draggedBlock.props as any)?.columnGroupId;

          const newGroupId = `col_${Date.now()}`;
          const leftId = target.type === "column-left" ? blockId : targetBlockId;
          const rightId = target.type === "column-left" ? targetBlockId : blockId;

          void (async () => {
            // If dragged block was in a column, break it first
            if (draggedGroupId) {
              const partner = blocks.find(b => b.id !== blockId && (b.props as any)?.columnGroupId === draggedGroupId);
              if (partner) {
                await patchIdeaBlock(ideaId, partner.id, { props: { columnGroupId: null, columnPosition: null, columnRatio: null } });
              }
            }
            await patchIdeaBlock(ideaId, leftId, { props: { columnGroupId: newGroupId, columnPosition: "left", columnRatio: 0.5 } });
            await patchIdeaBlock(ideaId, rightId, { props: { columnGroupId: newGroupId, columnPosition: "right", columnRatio: 0.5 } });
            // Move dragged block adjacent to target
            const targetIdx = blocks.findIndex(b => b.id === targetBlockId);
            const dragIdx = blocks.findIndex(b => b.id === blockId);
            if (dragIdx !== targetIdx + 1 && dragIdx !== targetIdx - 1) {
              // Move next to the target
              const newIdx = target.type === "column-right" ? targetIdx + 1 : targetIdx;
              await moveIdeaBlock(ideaId, blockId, newIdx);
            }
            const bRes = await fetchIdeaBlocks(ideaId);
            setBlocks(bRes.blocks);
            contentRef.current = bRes.blocks.map((b: IdeaBlockBrief) => b.content).join("");
            setContent(contentRef.current);
            versionRef.current = bRes.version;
          })();
        }
      } else {
        setDragBlockId(null);
        setDropTarget(null);
      }
    }
  }, [dragBlockId, ghostPos, blocks, ideaId]);

  // Column resize handler
  const handleColumnResizeStart = useCallback((groupId: string, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setResizingGroup(groupId);
    resizeStartX.current = e.clientX;
    // Find current ratio
    const groupBlock = blocks.find(b => (b.props as any)?.columnGroupId === groupId && (b.props as any)?.columnPosition === "left");
    resizeStartRatio.current = (groupBlock?.props as any)?.columnRatio ?? 0.5;
    // Get container rect
    const container = blockListRef.current;
    if (container) {
      resizeContainerRect.current = container.getBoundingClientRect();
    }
    const moveHandler = (ev: PointerEvent) => {
      const containerWidth = resizeContainerRect.current?.width ?? 600;
      const dx = ev.clientX - resizeStartX.current;
      const deltaRatio = dx / (containerWidth - 6); // subtract divider width
      let newRatio = resizeStartRatio.current + deltaRatio;
      newRatio = Math.max(0.2, Math.min(0.8, newRatio));
      // Optimistic local update
      setBlocks(prev => prev.map(b => {
        if ((b.props as any)?.columnGroupId !== groupId) return b;
        const pos = (b.props as any)?.columnPosition;
        if (pos === "left") return { ...b, props: { ...b.props, columnRatio: newRatio } };
        if (pos === "right") return { ...b, props: { ...b.props, columnRatio: 1 - newRatio } };
        return b;
      }));
    };
    const upHandler = () => {
      document.removeEventListener("pointermove", moveHandler);
      document.removeEventListener("pointerup", upHandler);
      setResizingGroup(null);
      // Persist final ratio
      const leftBlock = blocks.find(b => (b.props as any)?.columnGroupId === groupId && (b.props as any)?.columnPosition === "left");
      const rightBlock = blocks.find(b => (b.props as any)?.columnGroupId === groupId && (b.props as any)?.columnPosition === "right");
      // Read current ratio from state
      // We need to get the latest ratio from the DOM or recalculate
      const containerWidth = resizeContainerRect.current?.width ?? 600;
      const dx = (document as any).__lastResizeX - resizeStartX.current;
      const deltaRatio = dx / (containerWidth - 6);
      let finalRatio = resizeStartRatio.current + deltaRatio;
      finalRatio = Math.max(0.2, Math.min(0.8, finalRatio));
      if (leftBlock) void patchIdeaBlock(ideaId, leftBlock.id, { props: { columnGroupId: groupId, columnPosition: "left", columnRatio: finalRatio } });
      if (rightBlock) void patchIdeaBlock(ideaId, rightBlock.id, { props: { columnGroupId: groupId, columnPosition: "right", columnRatio: 1 - finalRatio } });
    };
    // Track last X for upHandler
    const trackMove = (ev: PointerEvent) => { (document as any).__lastResizeX = ev.clientX; };
    (document as any).__lastResizeX = e.clientX;
    document.addEventListener("pointermove", moveHandler);
    document.addEventListener("pointermove", trackMove);
    document.addEventListener("pointerup", () => {
      document.removeEventListener("pointermove", trackMove);
      upHandler();
    }, { once: true });
  }, [blocks, ideaId]);

  // ── Drag-drop for images (both modes) ──
  const [dragInsertIdx, setDragInsertIdx] = useState<number | null>(null);
  // (sourceDragLine removed — source mode now uses same block list as preview)

  const isImageFile = useCallback((file: File) => {
    return /^image\/(png|jpeg|jpg|gif|svg\+xml|webp)$/.test(file.type);
  }, []);

  const getDragInsertIndex = useCallback((clientY: number): number => {
    const container = blockListRef.current;
    if (!container || blocks.length === 0) return 0;
    const children = container.querySelectorAll<HTMLElement>("[data-block-id]");
    for (let i = 0; i < children.length; i++) {
      const rect = children[i].getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      if (clientY < midY) return i;
    }
    return blocks.length;
  }, [blocks.length]);

  const handleBlockListDragOver = useCallback((e: React.DragEvent) => {
    if (streaming || !e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setDragInsertIdx(getDragInsertIndex(e.clientY));
  }, [streaming, getDragInsertIndex]);

  const handleBlockListDragLeave = useCallback((e: React.DragEvent) => {
    // Only clear if actually leaving the container (not entering a child)
    if (blockListRef.current && !blockListRef.current.contains(e.relatedTarget as Node)) {
      setDragInsertIdx(null);
    }
  }, []);

  const handleBlockListDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    const insertIdx = dragInsertIdx;
    setDragInsertIdx(null);
    if (insertIdx === null || streaming) return;

    const files = Array.from(e.dataTransfer.files).filter(isImageFile);
    if (files.length === 0) return;

    for (const file of files) {
      try {
        const att = await uploadIdeaAttachment(ideaId, file);
        const alt = (att.originalName || "image").replace(/[\[\]]/g, "");
        const mdContent = `![${alt}](${att.url})\n`;
        const afterBlockId = insertIdx > 0 ? blocks[insertIdx - 1]?.id ?? null : null;
        const res = await createIdeaBlock(ideaId, {
          type: "paragraph",
          content: mdContent,
          afterBlockId,
        });
        // Update local state with the new block
        setBlocks((prev) => {
          const newBlock: IdeaBlockBrief = {
            id: res.block.id,
            order: res.block.order,
            type: res.block.type,
            content: res.block.content,
            props: (res.block.props ?? {}) as Record<string, unknown>,
          };
          const next = [...prev];
          next.splice(insertIdx, 0, newBlock);
          return next;
        });
        // Sync content
        const bRes = await fetchIdeaBlocks(ideaId);
        setBlocks(bRes.blocks);
        const newContent = bRes.blocks.map((b: IdeaBlockBrief) => b.content).join("");
        contentRef.current = newContent;
        setContent(newContent);
        versionRef.current = bRes.version;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        toast.error(t("idea.uploadFailed") + `: ${msg}`);
      }
    }
  }, [dragInsertIdx, streaming, isImageFile, ideaId, blocks, toast, t]);

  // ── Source mode drag-drop with block-level anchor ──

  // Source mode drag removed — source mode now uses same block list + drag-drop as preview

  // ── Status label ──
  const statusLabel = (() => {
    if (!loaded) return t("idea.loading");
    if (streaming) return t("idea.streaming");
    if (saveStatus === "saving") return t("idea.saving");
    if (saveStatus === "saved") return t("idea.saved");
    if (saveStatus === "dirty") return t("idea.unsaved");
    if (saveStatus === "offline") return t("idea.offline");
    return "";
  })();

  // ── Mode toggle with cursor preservation ──
  const caretOffsetRef = useRef(0);
  const toggleMode = useCallback(() => {
    // Find the first visible block in the current viewport to restore scroll position
    let visibleBlockId: string | null = null;
    const container = blockListRef.current;
    if (container) {
      const blockEls = container.querySelectorAll<HTMLElement>("[data-block-id]");
      const scrollParent = bodyRef.current;
      const viewTop = scrollParent?.getBoundingClientRect().top ?? 0;
      for (const el of blockEls) {
        const rect = el.getBoundingClientRect();
        if (rect.bottom > viewTop) {
          visibleBlockId = el.getAttribute("data-block-id");
          break;
        }
      }
    }

    setMode((m) => {
      if (m === "source") {
        fetchIdeaBlocks(ideaId).then((res) => {
          setBlocks(res.blocks);
        }).catch(() => {});
      } else {
        setContent(contentRef.current);
      }
      // Scroll to the same block after mode switch
      if (visibleBlockId) {
        setTimeout(() => {
          const c = blockListRef.current;
          if (!c) return;
          const blockEl = c.querySelector(`[data-block-id="${visibleBlockId}"]`);
          if (!blockEl) return;
          blockEl.scrollIntoView({ block: "start", behavior: "instant" });
        }, 100);
      }
      return m === "source" ? "preview" : "source";
    });
  }, [ideaId]);

  useEffect(() => {
    const offset = caretOffsetRef.current;
    requestAnimationFrame(() => {
      if (mode === "preview") {
        previewRef.current?.setCaretFromSourceOffset(offset);
      } else {
        cmRef.current?.setCaret(offset, true);
      }
    });
  }, [mode]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "/") {
        e.preventDefault();
        toggleMode();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [toggleMode]);

  return (
    <div className="idea-editor-panel">
      <div className="idea-editor-topbar">
        <SidebarExpandButton />
        <span className="idea-editor-topbar-name">
          <InlineEdit
            value={ideaName}
            isEditing={isEditingName}
            onStartEdit={() => setIsEditingName(true)}
            onSave={(name) => { setIsEditingName(false); onRename(name); }}
            onCancelEdit={() => setIsEditingName(false)}
          />
        </span>
        <div className="idea-editor-topbar-actions">
          {statusLabel && <span className="idea-editor-status">{statusLabel}</span>}
          {statusLabel && <span className="idea-editor-topbar-sep" aria-hidden="true" />}
          <button
            className="idea-editor-topbar-btn"
            onClick={toggleMode}
            title={t("idea.toggleHint")}
          >
            {mode === "source" ? PREVIEW_ICON : SOURCE_ICON}
            {mode === "source" ? t("idea.preview") : t("idea.source")}
          </button>
          <BlockCloseButton />
        </div>
      </div>

      <div className="idea-editor-body" ref={bodyRef} style={{ position: "relative" }}>
        {!loaded ? (
          <div className="idea-editor-loading">{t("idea.loading")}</div>
        ) : blocks.length > 0 ? (
          <>
          <div
            ref={blockListRef}
            style={{ padding: "60px 60px 80px 60px", position: "relative", display: "flex", flexDirection: "column", gap: 12 }}
            onDragOver={handleBlockListDragOver}
            onDragLeave={handleBlockListDragLeave}
            onDrop={handleBlockListDrop}
          >
            {(() => {
              // Render using blockLayout for column support in preview mode
              if (mode === "preview") {
                let blockIdx = 0;
                return blockLayout.map((item, layoutIdx) => {
                  if (item.type === "single") {
                    const block = item.block;
                    const idx = blocks.findIndex(b => b.id === block.id);
                    blockIdx++;
                    const showReorderLine = dropTarget?.type === "reorder" && dropTarget.insertIdx === idx && dragBlockId;
                    const showReorderLineAfter = dropTarget?.type === "reorder" && dropTarget.insertIdx === idx + 1 && dragBlockId && layoutIdx === blockLayout.length - 1;
                    return (
                      <React.Fragment key={block.id}>
                        {showReorderLine && (
                          <div style={{ height: 2, background: "var(--primary, #1456F0)", borderRadius: 1, margin: "2px 0", pointerEvents: "none" }} />
                        )}
                        {dragInsertIdx === idx && !dragBlockId && (
                          <div style={{ height: 2, background: "var(--primary, #1456F0)", borderRadius: 1, margin: "2px 0", pointerEvents: "none" }} />
                        )}
                        <div style={{ position: "relative" }}>
                          {/* Vertical anchor lines for column drop */}
                          {dropTarget?.type === "column-left" && dropTarget.targetBlockId === block.id && (
                            <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 2, background: "var(--primary, #1456F0)", borderRadius: 1, zIndex: 10, pointerEvents: "none" }} />
                          )}
                          {dropTarget?.type === "column-right" && dropTarget.targetBlockId === block.id && (
                            <div style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: 2, background: "var(--primary, #1456F0)", borderRadius: 1, zIndex: 10, pointerEvents: "none" }} />
                          )}
                          <BlockItem
                            block={block}
                            ideaId={ideaId}
                            readOnly={streaming}
                            sourceMode={false}
                            autoFocus={autoEditBlockId === block.id}
                            focusTrigger={focusBlockId === block.id ? focusTrigger : 0}
                            focusCursorPos={focusBlockId === block.id ? focusCursorPos : null}
                            remoteUpdatePending={pendingRemoteBlockRef.current.has(block.id)}
                            onSaved={handleBlockSaved}
                            onDeleted={handleBlockDeleted}
                            onCreatedAfter={handleBlockCreatedAfter}
                            onConflict={handleBlockConflict}
                            onFocusChange={handleBlockFocusChange}
                            editLocked={!!focusBlockId && focusBlockId !== block.id}
                            onEditBlocked={() => toast.info(t("idea.editLocked"))}
                            onSplit={handleSplit}
                            onMergeIntoPrev={handleMergeIntoPrev}
                            onDragStart={handleBlockDragStart}
                            isDragging={dragBlockId === block.id}
                            onFocusPrev={() => {
                              if (idx > 0) {
                                const container = blockListRef.current;
                                if (container) {
                                  const allTas = container.querySelectorAll('textarea');
                                  const prevTa = allTas[idx - 1];
                                  if (prevTa) { prevTa.focus(); prevTa.selectionStart = prevTa.selectionEnd = prevTa.value.length; }
                                }
                                setFocusBlockId(blocks[idx - 1].id);
                              }
                            }}
                            onFocusNext={() => {
                              if (idx < blocks.length - 1) {
                                const container = blockListRef.current;
                                if (container) {
                                  const allTas = container.querySelectorAll('textarea');
                                  const nextTa = allTas[idx + 1];
                                  if (nextTa) { nextTa.focus(); nextTa.selectionStart = nextTa.selectionEnd = 0; }
                                }
                                setFocusBlockId(blocks[idx + 1].id);
                              }
                            }}
                          />
                        </div>
                        {showReorderLineAfter && (
                          <div style={{ height: 2, background: "var(--primary, #1456F0)", borderRadius: 1, margin: "2px 0", pointerEvents: "none" }} />
                        )}
                      </React.Fragment>
                    );
                  } else {
                    // Column group
                    const { groupId, left, right, ratio } = item;
                    const leftIdx = blocks.findIndex(b => b.id === left.id);
                    const rightIdx = blocks.findIndex(b => b.id === right.id);
                    blockIdx += 2;
                    return (
                      <div key={groupId} style={{ display: "grid", gridTemplateColumns: `${ratio}fr 6px ${1 - ratio}fr`, gap: 0, alignItems: "start" }}>
                        <div style={{ position: "relative" }}>
                          {dropTarget?.type === "column-left" && dropTarget.targetBlockId === left.id && (
                            <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 2, background: "var(--primary, #1456F0)", borderRadius: 1, zIndex: 10, pointerEvents: "none" }} />
                          )}
                          <BlockItem
                            block={left}
                            ideaId={ideaId}
                            readOnly={streaming}
                            sourceMode={false}
                            autoFocus={autoEditBlockId === left.id}
                            focusTrigger={focusBlockId === left.id ? focusTrigger : 0}
                            focusCursorPos={focusBlockId === left.id ? focusCursorPos : null}
                            remoteUpdatePending={pendingRemoteBlockRef.current.has(left.id)}
                            onSaved={handleBlockSaved}
                            onDeleted={handleBlockDeleted}
                            onCreatedAfter={handleBlockCreatedAfter}
                            onConflict={handleBlockConflict}
                            onFocusChange={handleBlockFocusChange}
                            editLocked={!!focusBlockId && focusBlockId !== left.id}
                            onEditBlocked={() => toast.info(t("idea.editLocked"))}
                            onSplit={handleSplit}
                            onMergeIntoPrev={handleMergeIntoPrev}
                            onDragStart={handleBlockDragStart}
                            isDragging={dragBlockId === left.id}
                            onFocusPrev={() => {
                              if (leftIdx > 0) {
                                setFocusBlockId(blocks[leftIdx - 1].id);
                              }
                            }}
                            onFocusNext={() => {
                              setFocusBlockId(right.id);
                            }}
                          />
                        </div>
                        {/* Column resize handle */}
                        <div
                          style={{
                            width: 6,
                            cursor: "col-resize",
                            background: resizingGroup === groupId ? "var(--primary, #1456F0)" : "transparent",
                            borderRadius: 3,
                            alignSelf: "stretch",
                            transition: "background 0.12s",
                            minHeight: 24,
                          }}
                          onPointerEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--border-default, #e0e0e0)"; }}
                          onPointerLeave={(e) => { if (resizingGroup !== groupId) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
                          onPointerDown={(e) => handleColumnResizeStart(groupId, e)}
                        />
                        <div style={{ position: "relative" }}>
                          {dropTarget?.type === "column-right" && dropTarget.targetBlockId === right.id && (
                            <div style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: 2, background: "var(--primary, #1456F0)", borderRadius: 1, zIndex: 10, pointerEvents: "none" }} />
                          )}
                          <BlockItem
                            block={right}
                            ideaId={ideaId}
                            readOnly={streaming}
                            sourceMode={false}
                            autoFocus={autoEditBlockId === right.id}
                            focusTrigger={focusBlockId === right.id ? focusTrigger : 0}
                            focusCursorPos={focusBlockId === right.id ? focusCursorPos : null}
                            remoteUpdatePending={pendingRemoteBlockRef.current.has(right.id)}
                            onSaved={handleBlockSaved}
                            onDeleted={handleBlockDeleted}
                            onCreatedAfter={handleBlockCreatedAfter}
                            onConflict={handleBlockConflict}
                            onFocusChange={handleBlockFocusChange}
                            editLocked={!!focusBlockId && focusBlockId !== right.id}
                            onEditBlocked={() => toast.info(t("idea.editLocked"))}
                            onSplit={handleSplit}
                            onMergeIntoPrev={handleMergeIntoPrev}
                            onDragStart={handleBlockDragStart}
                            isDragging={dragBlockId === right.id}
                            onFocusPrev={() => {
                              setFocusBlockId(left.id);
                            }}
                            onFocusNext={() => {
                              if (rightIdx < blocks.length - 1) {
                                setFocusBlockId(blocks[rightIdx + 1].id);
                              }
                            }}
                          />
                        </div>
                      </div>
                    );
                  }
                });
              }

              // Source mode: flat list (no column support)
              return blocks.map((block, idx) => (
                <React.Fragment key={block.id}>
                  {dragInsertIdx === idx && (
                    <div style={{ height: 2, background: "var(--primary, #1456F0)", borderRadius: 1, margin: "2px 0", pointerEvents: "none" }} />
                  )}
                  <BlockItem
                    block={block}
                    ideaId={ideaId}
                    readOnly={streaming}
                    sourceMode={true}
                    autoFocus={autoEditBlockId === block.id}
                    focusTrigger={focusBlockId === block.id ? focusTrigger : 0}
                    focusCursorPos={focusBlockId === block.id ? focusCursorPos : null}
                    remoteUpdatePending={pendingRemoteBlockRef.current.has(block.id)}
                    onSaved={handleBlockSaved}
                    onDeleted={handleBlockDeleted}
                    onCreatedAfter={handleBlockCreatedAfter}
                    onConflict={handleBlockConflict}
                    onFocusChange={handleBlockFocusChange}
                    editLocked={false}
                    onEditBlocked={() => toast.info(t("idea.editLocked"))}
                    onSplit={handleSplit}
                    onMergeIntoPrev={handleMergeIntoPrev}
                    onFocusPrev={() => {
                      if (idx > 0) {
                        const container = blockListRef.current;
                        if (container) {
                          const allTas = container.querySelectorAll('textarea');
                          const prevTa = allTas[idx - 1];
                          if (prevTa) { prevTa.focus(); prevTa.selectionStart = prevTa.selectionEnd = prevTa.value.length; }
                        }
                        setFocusBlockId(blocks[idx - 1].id);
                      }
                    }}
                    onFocusNext={() => {
                      if (idx < blocks.length - 1) {
                        const container = blockListRef.current;
                        if (container) {
                          const allTas = container.querySelectorAll('textarea');
                          const nextTa = allTas[idx + 1];
                          if (nextTa) { nextTa.focus(); nextTa.selectionStart = nextTa.selectionEnd = 0; }
                        }
                        setFocusBlockId(blocks[idx + 1].id);
                      }
                    }}
                  />
                </React.Fragment>
              ));
            })()}
            {dragInsertIdx === blocks.length && !dragBlockId && (
              <div style={{ height: 2, background: "var(--primary, #1456F0)", borderRadius: 1, margin: "2px 0", pointerEvents: "none" }} />
            )}
            {dropTarget?.type === "reorder" && dropTarget.insertIdx === blocks.length && dragBlockId && (
              <div style={{ height: 2, background: "var(--primary, #1456F0)", borderRadius: 1, margin: "2px 0", pointerEvents: "none" }} />
            )}
          </div>
          {/* Drag ghost */}
          {dragBlockId && ghostPos && createPortal(
            <div style={{
              position: "fixed",
              left: ghostPos.x - 40,
              top: ghostPos.y - 16,
              width: 200,
              maxHeight: 80,
              overflow: "hidden",
              padding: "8px 12px",
              background: "var(--surface-1, #fff)",
              border: "1px solid var(--border-default, #e0e0e0)",
              borderRadius: 8,
              boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
              opacity: 0.85,
              pointerEvents: "none",
              zIndex: 99999,
              fontSize: 13,
              lineHeight: 1.4,
              color: "var(--text-primary)",
            }}>
              {(() => {
                const db = blocks.find(b => b.id === dragBlockId);
                return db ? db.content.slice(0, 80) + (db.content.length > 80 ? "..." : "") : "";
              })()}
            </div>,
            document.body,
          )}
          </>
        ) : (
          <TiptapPreview
            ref={previewRef} source={content}
            onDirty={handlePreviewDirty} placeholder={t("idea.previewEmpty")}
            onUploadFile={handleImageUpload} onMentionClick={() => {}}
          />
        )}
      </div>
    </div>
  );
}
