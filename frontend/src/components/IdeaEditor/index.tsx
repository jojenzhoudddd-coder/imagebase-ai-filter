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
import BlockLayoutRenderer from "./BlockLayoutRenderer";
import type { LayoutDropTarget } from "./BlockLayoutRenderer";
import {
  collectLeafIds,
  removeFromLayout,
  insertIntoLayout,
  moveBlockInLayout,
  updateRatioAtPath,
  migrateColumnPropsToLayout,
} from "./blockLayoutUtils";
import type { BlockLayoutNode } from "../../types";
import type { PatchBlockResponse } from "../../api";
import { saveIdeaLayout } from "../../api";
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
  const [layout, setLayout] = useState<BlockLayoutNode | null>(null);
  const [layoutDropTarget, setLayoutDropTarget] = useState<LayoutDropTarget | null>(null);
  const [resizingLayoutPath, setResizingLayoutPath] = useState<string | null>(null);

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
    setLayout(null);
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
        const loadedBlocks = blocksRes?.blocks ?? [];
        if (loadedBlocks.length > 0) {
          setBlocks(loadedBlocks);
        }
        // Load layout from idea or migrate from old column props
        if (idea.layout) {
          setLayout(idea.layout as BlockLayoutNode);
        } else if (loadedBlocks.length > 0) {
          // Check if blocks have old column props → migrate
          const hasColumnGroups = loadedBlocks.some(
            (b: IdeaBlockBrief) => !!(b.props as any)?.columnGroupId,
          );
          if (hasColumnGroups) {
            const migrated = migrateColumnPropsToLayout(loadedBlocks);
            if (migrated) {
              setLayout(migrated);
              // Persist the migrated layout
              void saveIdeaLayout(ideaId, migrated);
            }
          }
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
    // Remove block from layout tree if present
    setLayout((prev) => {
      if (!prev) return prev;
      const newLayout = removeFromLayout(prev, _blockId);
      if (newLayout !== prev) {
        void saveIdeaLayout(ideaId, newLayout);
      }
      return newLayout;
    });
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
    | { type: "column-right"; targetBlockId: string }
    | { type: "layout-split"; targetBlockId: string; side: "top" | "right" | "bottom" | "left" };

  const [dragBlockId, setDragBlockId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [ghostState, setGhostState] = useState<{ mouseX: number; mouseY: number; offsetX: number; offsetY: number; width: number; height: number } | null>(null);
  const dragStartPos = useRef<{ x: number; y: number } | null>(null);
  const dragOffsetRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const dragActive = useRef(false);

  // Column resize state
  const [resizingGroup, setResizingGroup] = useState<string | null>(null);
  const resizeStartX = useRef(0);
  const resizeStartRatio = useRef(0.5);
  const resizeContainerRect = useRef<DOMRect | null>(null);

  /** Helper: get columnIndex from props (backward compat with "left"/"right") */
  const getColumnIndex = (props: any): number => {
    if (typeof props?.columnIndex === "number") return props.columnIndex;
    if (props?.columnPosition === "left") return 0;
    if (props?.columnPosition === "right") return 1;
    return 0;
  };
  const getColumnWidth = (props: any): number => {
    return props?.columnWidth ?? props?.columnRatio ?? 0.5;
  };

  /** Group blocks by columnGroupId for rendering — supports N columns */
  const blockLayout = useMemo(() => {
    type ColumnGroup = { type: "column"; groupId: string; columns: IdeaBlockBrief[]; widths: number[] };
    const layout: Array<{ type: "single"; block: IdeaBlockBrief } | ColumnGroup> = [];
    const visited = new Set<string>();
    const groupMap = new Map<string, IdeaBlockBrief[]>();

    // Collect groups
    for (const b of blocks) {
      const groupId = (b.props as any)?.columnGroupId as string | undefined;
      if (groupId) {
        if (!groupMap.has(groupId)) groupMap.set(groupId, []);
        groupMap.get(groupId)!.push(b);
      }
    }

    for (let i = 0; i < blocks.length; i++) {
      if (visited.has(blocks[i].id)) continue;
      const b = blocks[i];
      const groupId = (b.props as any)?.columnGroupId as string | undefined;
      if (groupId && groupMap.has(groupId)) {
        const members = groupMap.get(groupId)!;
        if (members.length >= 2) {
          members.forEach(m => visited.add(m.id));
          // Sort by columnIndex
          members.sort((a, b) => getColumnIndex(a.props) - getColumnIndex(b.props));
          const widths = members.map(m => getColumnWidth(m.props));
          layout.push({ type: "column", groupId, columns: members, widths });
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
    dragActive.current = false;
    const dragId = blockId;
    const startX = 0, startY = 0;
    let initX = 0, initY = 0, initCaptured = false;
    const MIN_DRAG_DISTANCE = 5;
    const handler = (e: PointerEvent) => {
      if (!initCaptured) { initX = e.clientX; initY = e.clientY; initCaptured = true; }
      // Don't activate until mouse has moved at least MIN_DRAG_DISTANCE
      if (!dragActive.current) {
        const dx = e.clientX - initX;
        const dy = e.clientY - initY;
        if (Math.abs(dx) < MIN_DRAG_DISTANCE && Math.abs(dy) < MIN_DRAG_DISTANCE) return;
        dragActive.current = true;
        setDragBlockId(dragId);
        const contentEl = blockListRef.current?.querySelector(`[data-block-content="${dragId}"]`);
        if (contentEl) {
          const r = contentEl.getBoundingClientRect();
          dragOffsetRef.current = { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height };
        } else {
          dragOffsetRef.current = { x: 20, y: 12, w: 200, h: 40 };
        }
      }
      const off = dragOffsetRef.current!;
      setGhostState({ mouseX: e.clientX, mouseY: e.clientY, offsetX: off.x, offsetY: off.y, width: off.w, height: off.h });
      // Calculate drop target
      const container = blockListRef.current;
      if (!container) return;
      // Use content areas (not outer wrappers with handle) for hit testing
      const blockEls = container.querySelectorAll<HTMLElement>("[data-block-content]");
      let foundTarget: DropTarget | null = null;
      for (let i = 0; i < blockEls.length; i++) {
        const el = blockEls[i];
        const elBlockId = el.getAttribute("data-block-content");
        if (elBlockId === blockId) continue;
        const rect = el.getBoundingClientRect();
        if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
          const relX = e.clientX - rect.left;
          const relY = e.clientY - rect.top;
          const width = rect.width;
          const height = rect.height;
          // 20% edge zones for layout splits (top/bottom/left/right)
          const xFrac = relX / width;
          const yFrac = relY / height;
          if (yFrac < 0.2) {
            foundTarget = { type: "layout-split", targetBlockId: elBlockId!, side: "top" };
          } else if (yFrac > 0.8) {
            foundTarget = { type: "layout-split", targetBlockId: elBlockId!, side: "bottom" };
          } else if (xFrac < 0.2) {
            foundTarget = { type: "layout-split", targetBlockId: elBlockId!, side: "left" };
          } else if (xFrac > 0.8) {
            foundTarget = { type: "layout-split", targetBlockId: elBlockId!, side: "right" };
          }
          // Center 60% → reorder (not split)
          if (!foundTarget) {
            const idx = blocks.findIndex(b => b.id === elBlockId);
            if (idx >= 0) {
              foundTarget = { type: "reorder", insertIdx: yFrac < 0.5 ? idx : idx + 1 };
            }
          }
          break;
        }
      }
      // If no block was hit (cursor in gap between blocks, or above/below all)
      if (!foundTarget && blockEls.length > 0) {
        // Check gaps between consecutive blocks
        for (let i = 0; i < blockEls.length; i++) {
          const r = blockEls[i].getBoundingClientRect();
          if (e.clientY < r.top) {
            // Cursor above this block → insert before it
            const bId = blockEls[i].getAttribute("data-block-content");
            const idx = blocks.findIndex(b => b.id === bId);
            if (idx >= 0) foundTarget = { type: "reorder", insertIdx: idx };
            break;
          }
        }
        if (!foundTarget) {
          const lastRect = blockEls[blockEls.length - 1].getBoundingClientRect();
          if (e.clientY > lastRect.bottom) {
            foundTarget = { type: "reorder", insertIdx: blocks.length };
          }
        }
      }
      lastDropTarget = foundTarget;
      setDropTarget(foundTarget);
    };
    let lastDropTarget: DropTarget | null = null;
    const upHandler = () => {
      document.removeEventListener("pointermove", handler);
      document.removeEventListener("pointerup", upHandler);
      document.removeEventListener("keydown", escHandler);
      if (!dragActive.current) {
        setDragBlockId(null);
        setDropTarget(null);
        setGhostState(null);
      } else {
        // Commit drop using the closure-captured dropTarget (not stale ref)
        const finalTarget = lastDropTarget;
        const finalBlockId = dragId;
        setGhostState(null);
        setDragBlockId(null);
        setDropTarget(null);
        dragActive.current = false;
        if (finalTarget) {
          commitDrop(finalBlockId, finalTarget);
        }
      }
    };
    const escHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        document.removeEventListener("pointermove", handler);
        document.removeEventListener("pointerup", upHandler);
        document.removeEventListener("keydown", escHandler);
        setDragBlockId(null);
        setDropTarget(null);
        setGhostState(null);
        dragActive.current = false;
      }
    };
    document.addEventListener("pointermove", handler);
    document.addEventListener("pointerup", upHandler);
    document.addEventListener("keydown", escHandler);
  }, [mode, streaming, blocks]);

  // ── Layout tree persistence (debounced) ──
  const layoutSaveTimerRef = useRef<number | null>(null);
  const persistLayout = useCallback((newLayout: BlockLayoutNode | null) => {
    setLayout(newLayout);
    if (layoutSaveTimerRef.current) window.clearTimeout(layoutSaveTimerRef.current);
    layoutSaveTimerRef.current = window.setTimeout(() => {
      layoutSaveTimerRef.current = null;
      void saveIdeaLayout(ideaId, newLayout);
    }, 800);
  }, [ideaId]);

  // Commit a drop operation directly (called from upHandler closure)
  const commitDrop = useCallback((blockId: string, target: DropTarget) => {
        if (target.type === "reorder") {
          // If the block is in the layout tree, remove it from there first
          setLayout((prev) => {
            if (!prev) return prev;
            const newLayout = removeFromLayout(prev, blockId);
            if (newLayout !== prev) {
              void saveIdeaLayout(ideaId, newLayout);
            }
            return newLayout;
          });
          const draggedBlock = blocks.find(b => b.id === blockId);
          const groupId = (draggedBlock?.props as any)?.columnGroupId;
          void (async () => {
            // Remove from column group if the dragged block is in one
            if (groupId) {
              const remaining = blocks.filter(b => b.id !== blockId && (b.props as any)?.columnGroupId === groupId);
              // Clear dragged block's column props
              await patchIdeaBlock(ideaId, blockId, { props: { columnGroupId: null, columnIndex: null, columnWidth: null, columnPosition: null, columnRatio: null } });
              if (remaining.length <= 1) {
                // Only 1 left → dissolve group
                for (const m of remaining) {
                  await patchIdeaBlock(ideaId, m.id, { props: { columnGroupId: null, columnIndex: null, columnWidth: null, columnPosition: null, columnRatio: null } });
                }
              } else {
                // Re-index and redistribute widths among remaining
                remaining.sort((a, b) => getColumnIndex(a.props) - getColumnIndex(b.props));
                const equalWidth = 1 / remaining.length;
                for (let i = 0; i < remaining.length; i++) {
                  await patchIdeaBlock(ideaId, remaining[i].id, { props: { ...remaining[i].props, columnIndex: i, columnWidth: equalWidth } });
                }
              }
            }
            // Adjust insertIdx for the "remove then insert" semantics:
            // if the dragged block is before the target, removing it shifts target down by 1
            const dragIdx = blocks.findIndex(b => b.id === blockId);
            let adjustedIdx = target.insertIdx;
            if (dragIdx >= 0 && dragIdx < target.insertIdx) adjustedIdx--;
            await moveIdeaBlock(ideaId, blockId, adjustedIdx);
            const bRes = await fetchIdeaBlocks(ideaId);
            setBlocks(bRes.blocks);
            contentRef.current = bRes.blocks.map((b: IdeaBlockBrief) => b.content).join("");
            setContent(contentRef.current);
            versionRef.current = bRes.version;
          })();
        } else if (target.type === "column-left" || target.type === "column-right") {
          const targetBlockId = target.targetBlockId;
          const targetBlock = blocks.find(b => b.id === targetBlockId);
          const draggedBlock = blocks.find(b => b.id === blockId);
          if (!targetBlock || !draggedBlock) return;

          const targetGroupId = (targetBlock.props as any)?.columnGroupId as string | undefined;
          const draggedGroupId = (draggedBlock.props as any)?.columnGroupId as string | undefined;

          void (async () => {
            // Break dragged block's existing column if needed
            if (draggedGroupId && draggedGroupId !== targetGroupId) {
              const oldMembers = blocks.filter(b => b.id !== blockId && (b.props as any)?.columnGroupId === draggedGroupId);
              if (oldMembers.length === 1) {
                // Only 1 left → dissolve group
                await patchIdeaBlock(ideaId, oldMembers[0].id, { props: { columnGroupId: null, columnIndex: null, columnWidth: null, columnPosition: null, columnRatio: null } });
              } else {
                // Redistribute widths among remaining
                const removedWidth = getColumnWidth(draggedBlock.props);
                const remaining = oldMembers.length;
                for (const m of oldMembers) {
                  const oldW = getColumnWidth(m.props);
                  const newIdx = getColumnIndex(m.props);
                  await patchIdeaBlock(ideaId, m.id, { props: { ...m.props, columnWidth: oldW + removedWidth / remaining, columnIndex: newIdx } });
                }
              }
            }

            if (targetGroupId) {
              // Add to existing group
              const members = blocks.filter(b => (b.props as any)?.columnGroupId === targetGroupId);
              const targetIdx = getColumnIndex(targetBlock.props);
              const insertIdx = target.type === "column-left" ? targetIdx : targetIdx + 1;
              // Shift existing members' indices
              const newWidth = 1 / (members.length + 1);
              for (const m of members) {
                let idx = getColumnIndex(m.props);
                if (idx >= insertIdx) idx++;
                await patchIdeaBlock(ideaId, m.id, { props: { ...m.props, columnGroupId: targetGroupId, columnIndex: idx, columnWidth: newWidth } });
              }
              await patchIdeaBlock(ideaId, blockId, { props: { columnGroupId: targetGroupId, columnIndex: insertIdx, columnWidth: newWidth, columnPosition: null, columnRatio: null } });
            } else {
              // Create new 2-column group
              const newGroupId = `col_${Date.now()}`;
              const leftId = target.type === "column-left" ? blockId : targetBlockId;
              const rightId = target.type === "column-left" ? targetBlockId : blockId;
              await patchIdeaBlock(ideaId, leftId, { props: { columnGroupId: newGroupId, columnIndex: 0, columnWidth: 0.5 } });
              await patchIdeaBlock(ideaId, rightId, { props: { columnGroupId: newGroupId, columnIndex: 1, columnWidth: 0.5 } });
            }

            // Move dragged block adjacent to target in document order
            const targetDocIdx = blocks.findIndex(b => b.id === targetBlockId);
            const dragDocIdx = blocks.findIndex(b => b.id === blockId);
            if (Math.abs(dragDocIdx - targetDocIdx) > 1) {
              const newIdx = target.type === "column-right" ? targetDocIdx + 1 : targetDocIdx;
              await moveIdeaBlock(ideaId, blockId, newIdx);
            }

            const bRes = await fetchIdeaBlocks(ideaId);
            setBlocks(bRes.blocks);
            contentRef.current = bRes.blocks.map((b: IdeaBlockBrief) => b.content).join("");
            setContent(contentRef.current);
            versionRef.current = bRes.version;
          })();
        } else if (target.type === "layout-split") {
          // Layout tree split: insert source block at target's side
          const directionMap = { top: "top", bottom: "bottom", left: "left", right: "right" } as const;
          const direction = directionMap[target.side];
          const targetBlockId = target.targetBlockId;

          // If layout exists, move within it; otherwise create a new layout
          if (layout) {
            const newLayout = moveBlockInLayout(layout, blockId, targetBlockId, direction);
            if (newLayout && newLayout !== layout) {
              persistLayout(newLayout);
            } else {
              // Source wasn't in tree — insert it
              const withInsert = insertIntoLayout(layout, targetBlockId, blockId, direction);
              persistLayout(withInsert);
            }
          } else {
            // No layout yet — create one with these two blocks
            const newLayout = insertIntoLayout(
              { kind: "leaf", blockId: targetBlockId },
              targetBlockId,
              blockId,
              direction,
            );
            persistLayout(newLayout);
          }
        }
  }, [blocks, ideaId, layout, persistLayout]);

  // Column resize handler — key format: "groupId:dividerIndex"
  const handleColumnResizeStart = useCallback((resizeKey: string, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const [groupId, divIdxStr] = resizeKey.split(":");
    const divIdx = parseInt(divIdxStr, 10);
    setResizingGroup(resizeKey);
    resizeStartX.current = e.clientX;

    // Find the two adjacent columns
    const members = blocks.filter(b => (b.props as any)?.columnGroupId === groupId);
    members.sort((a, b) => getColumnIndex(a.props) - getColumnIndex(b.props));
    const leftCol = members[divIdx];
    const rightCol = members[divIdx + 1];
    if (!leftCol || !rightCol) return;

    const leftW = getColumnWidth(leftCol.props);
    const rightW = getColumnWidth(rightCol.props);
    const totalW = leftW + rightW;
    resizeStartRatio.current = leftW / totalW;

    const container = blockListRef.current;
    if (container) {
      resizeContainerRect.current = container.getBoundingClientRect();
    }
    let lastX = e.clientX;
    let lastRatio = resizeStartRatio.current;
    const moveHandler = (ev: PointerEvent) => {
      lastX = ev.clientX;
      const containerWidth = resizeContainerRect.current?.width ?? 600;
      const dx = ev.clientX - resizeStartX.current;
      const deltaRatio = dx / (containerWidth - 12); // subtract divider width
      const newLocalRatio = Math.max(0.15, Math.min(0.85, resizeStartRatio.current + deltaRatio));
      lastRatio = newLocalRatio;
      // Update only the two adjacent columns' widths
      const newLeftW = totalW * newLocalRatio;
      const newRightW = totalW * (1 - newLocalRatio);
      setBlocks(prev => prev.map(b => {
        if (b.id === leftCol.id) return { ...b, props: { ...b.props, columnWidth: newLeftW } };
        if (b.id === rightCol.id) return { ...b, props: { ...b.props, columnWidth: newRightW } };
        return b;
      }));
    };
    const upHandler = () => {
      document.removeEventListener("pointermove", moveHandler);
      document.removeEventListener("pointerup", upHandler);
      setResizingGroup(null);
      const finalLeftW = totalW * lastRatio;
      const finalRightW = totalW * (1 - lastRatio);
      void patchIdeaBlock(ideaId, leftCol.id, { props: { ...leftCol.props, columnWidth: finalLeftW } });
      void patchIdeaBlock(ideaId, rightCol.id, { props: { ...rightCol.props, columnWidth: finalRightW } });
    };
    document.addEventListener("pointermove", moveHandler);
    document.addEventListener("pointerup", upHandler, { once: true });
  }, [blocks, ideaId]);

  // ── Layout tree resize handler ──
  const handleLayoutResizeStart = useCallback((path: ("first" | "second")[], e: React.PointerEvent) => {
    if (!layout || layout.kind !== "split") return;
    e.preventDefault();
    e.stopPropagation();
    const pathStr = path.join(".");
    setResizingLayoutPath(pathStr);

    // Navigate to the split node at the given path
    let splitNode: BlockLayoutNode = layout;
    for (const step of path) {
      if (splitNode.kind !== "split") return;
      splitNode = step === "first" ? splitNode.first : splitNode.second;
    }
    if (splitNode.kind !== "split") return;

    const splitOrientation = splitNode.orientation;
    const isH = splitOrientation === "h";
    const startX = e.clientX;
    const startY = e.clientY;
    const startRatio = splitNode.ratio;

    const container = blockListRef.current;
    const containerRect = container?.getBoundingClientRect();
    const containerSize = isH
      ? (containerRect?.width ?? 600)
      : (containerRect?.height ?? 400);

    let lastRatio = startRatio;

    const moveHandler = (ev: PointerEvent) => {
      const delta = isH ? ev.clientX - startX : ev.clientY - startY;
      const deltaRatio = delta / (containerSize - 12);
      lastRatio = Math.max(0.15, Math.min(0.85, startRatio + deltaRatio));
      setLayout((prev) => prev ? updateRatioAtPath(prev, path, lastRatio) : prev);
    };

    const upHandler = () => {
      document.removeEventListener("pointermove", moveHandler);
      document.removeEventListener("pointerup", upHandler);
      setResizingLayoutPath(null);
      // Persist
      setLayout((prev) => {
        if (prev) {
          const final = updateRatioAtPath(prev, path, lastRatio);
          void saveIdeaLayout(ideaId, final);
          return final;
        }
        return prev;
      });
    };

    document.addEventListener("pointermove", moveHandler);
    document.addEventListener("pointerup", upHandler, { once: true });
  }, [layout, ideaId]);

  // ── Layout-aware focus navigation ──
  const handleLayoutFocusPrev = useCallback((blockId: string) => {
    if (!layout) return;
    const leafIds = collectLeafIds(layout);
    const idx = leafIds.indexOf(blockId);
    if (idx > 0) {
      setFocusBlockId(leafIds[idx - 1]);
      setFocusTrigger((n) => n + 1);
    }
  }, [layout]);

  const handleLayoutFocusNext = useCallback((blockId: string) => {
    if (!layout) return;
    const leafIds = collectLeafIds(layout);
    const idx = leafIds.indexOf(blockId);
    if (idx >= 0 && idx < leafIds.length - 1) {
      setFocusBlockId(leafIds[idx + 1]);
      setFocusTrigger((n) => n + 1);
    }
  }, [layout]);

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
    // Save scroll state: first visible block + its offset from viewport top
    let visibleBlockId: string | null = null;
    let blockOffsetFromViewTop = 0;
    const container = blockListRef.current;
    const scrollParent = bodyRef.current;
    if (container && scrollParent) {
      const blockEls = container.querySelectorAll<HTMLElement>("[data-block-id]");
      const viewTop = scrollParent.getBoundingClientRect().top;
      for (const el of blockEls) {
        const rect = el.getBoundingClientRect();
        if (rect.bottom > viewTop) {
          visibleBlockId = el.getAttribute("data-block-id");
          blockOffsetFromViewTop = rect.top - viewTop;
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
      // Restore scroll: position the same block at the same offset from viewport top
      if (visibleBlockId) {
        setTimeout(() => {
          const c = blockListRef.current;
          const sp = bodyRef.current;
          if (!c || !sp) return;
          const blockEl = c.querySelector(`[data-block-id="${visibleBlockId}"]`);
          if (!blockEl) return;
          const newRect = blockEl.getBoundingClientRect();
          const viewTop = sp.getBoundingClientRect().top;
          const currentOffset = newRect.top - viewTop;
          sp.scrollTop += currentOffset - blockOffsetFromViewTop;
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
              // Render using layout tree or column groups in preview mode
              if (mode === "preview") {
                // ── Layout tree rendering ──
                if (layout) {
                  const treeBlockIds = new Set(collectLeafIds(layout));
                  const remainingBlocks = blocks.filter((b) => !treeBlockIds.has(b.id));

                  // Convert drag drop target to layout drop target format
                  const activeLayoutDrop: LayoutDropTarget | null =
                    dropTarget?.type === "layout-split"
                      ? { type: "layout-side", targetBlockId: dropTarget.targetBlockId, side: dropTarget.side }
                      : null;

                  return (
                    <>
                      <BlockLayoutRenderer
                        node={layout}
                        blocks={blocks}
                        ideaId={ideaId}
                        streaming={streaming}
                        autoEditBlockId={autoEditBlockId}
                        focusBlockId={focusBlockId}
                        focusTrigger={focusTrigger}
                        focusCursorPos={focusCursorPos}
                        pendingRemoteBlocks={pendingRemoteBlockRef.current}
                        dragBlockId={dragBlockId}
                        dropTarget={activeLayoutDrop}
                        onSaved={handleBlockSaved}
                        onDeleted={handleBlockDeleted}
                        onCreatedAfter={handleBlockCreatedAfter}
                        onConflict={handleBlockConflict}
                        onFocusChange={handleBlockFocusChange}
                        onEditBlocked={() => toast.info(t("idea.editLocked"))}
                        onSplit={handleSplit}
                        onMergeIntoPrev={handleMergeIntoPrev}
                        onDragStart={handleBlockDragStart}
                        onFocusPrev={handleLayoutFocusPrev}
                        onFocusNext={handleLayoutFocusNext}
                        onResizeStart={handleLayoutResizeStart}
                        resizingPath={resizingLayoutPath}
                      />
                      {/* Blocks not in the layout tree render vertically below */}
                      {remainingBlocks.map((block) => {
                        const idx = blocks.findIndex((b) => b.id === block.id);
                        const showReorderLine = dropTarget?.type === "reorder" && dropTarget.insertIdx === idx && dragBlockId;
                        return (
                          <React.Fragment key={block.id}>
                            {showReorderLine && (
                              <div style={{ height: 2, background: "var(--primary, #1456F0)", borderRadius: 1, margin: "2px 0", pointerEvents: "none" }} />
                            )}
                            <div style={{ position: "relative" }}>
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
                                dragInProgress={!!dragBlockId}
                                onFocusPrev={() => {
                                  if (idx > 0) {
                                    setFocusBlockId(blocks[idx - 1].id);
                                    setFocusTrigger((n) => n + 1);
                                  }
                                }}
                                onFocusNext={() => {
                                  if (idx < blocks.length - 1) {
                                    setFocusBlockId(blocks[idx + 1].id);
                                    setFocusTrigger((n) => n + 1);
                                  }
                                }}
                              />
                            </div>
                          </React.Fragment>
                        );
                      })}
                    </>
                  );
                }

                // ── Fallback: old column-group rendering (no layout tree) ──
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
                          {/* Drop indicators for layout-split */}
                          {dropTarget?.type === "layout-split" && dropTarget.targetBlockId === block.id && dropTarget.side === "left" && (
                            <div style={{ position: "absolute", left: -6, top: 0, bottom: 0, width: 2, background: "var(--primary, #1456F0)", borderRadius: 1, zIndex: 10, pointerEvents: "none" }} />
                          )}
                          {dropTarget?.type === "layout-split" && dropTarget.targetBlockId === block.id && dropTarget.side === "right" && (
                            <div style={{ position: "absolute", right: -6, top: 0, bottom: 0, width: 2, background: "var(--primary, #1456F0)", borderRadius: 1, zIndex: 10, pointerEvents: "none" }} />
                          )}
                          {dropTarget?.type === "layout-split" && dropTarget.targetBlockId === block.id && dropTarget.side === "top" && (
                            <div style={{ position: "absolute", top: -1, left: 0, right: 0, height: 2, background: "var(--primary, #1456F0)", borderRadius: 1, zIndex: 10, pointerEvents: "none" }} />
                          )}
                          {dropTarget?.type === "layout-split" && dropTarget.targetBlockId === block.id && dropTarget.side === "bottom" && (
                            <div style={{ position: "absolute", bottom: -1, left: 0, right: 0, height: 2, background: "var(--primary, #1456F0)", borderRadius: 1, zIndex: 10, pointerEvents: "none" }} />
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
                            dragInProgress={!!dragBlockId}
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
                    // N-column group (legacy)
                    const { groupId, columns, widths } = item;
                    const firstColIdx = blocks.findIndex(b => b.id === columns[0].id);
                    const lastColIdx = blocks.findIndex(b => b.id === columns[columns.length - 1].id);
                    blockIdx += columns.length;
                    const showLineAbove = dropTarget?.type === "reorder" && dropTarget.insertIdx === firstColIdx && dragBlockId;
                    const showLineBelow = dropTarget?.type === "reorder" && dropTarget.insertIdx === lastColIdx + 1 && dragBlockId && layoutIdx === blockLayout.length - 1;
                    const gridCols = widths.map(w => `${w}fr`).join(" 12px ");
                    return (
                      <React.Fragment key={groupId}>
                      {showLineAbove && (
                        <div style={{ height: 2, background: "var(--primary, #1456F0)", borderRadius: 1, margin: "2px 0", pointerEvents: "none" }} />
                      )}
                      <div style={{ display: "grid", gridTemplateColumns: gridCols, gap: 0, alignItems: "start" }}>
                        {columns.map((col, colIdx) => {
                          const bIdx = blocks.findIndex(b => b.id === col.id);
                          const isFirst = colIdx === 0;
                          return (
                            <React.Fragment key={col.id}>
                              {!isFirst && (
                                <div
                                  style={{
                                    width: 24, marginLeft: -6, marginRight: -6,
                                    cursor: "col-resize", alignSelf: "stretch",
                                    display: "flex", alignItems: "center", justifyContent: "center",
                                    position: "relative", zIndex: 5, background: "transparent",
                                  }}
                                  onPointerEnter={(e) => {
                                    const bar = e.currentTarget.querySelector("[data-resize-bar]") as HTMLElement;
                                    if (bar) bar.style.opacity = "1";
                                  }}
                                  onPointerLeave={(e) => {
                                    if (resizingGroup !== `${groupId}:${colIdx - 1}`) {
                                      const bar = e.currentTarget.querySelector("[data-resize-bar]") as HTMLElement;
                                      if (bar) bar.style.opacity = "0";
                                    }
                                  }}
                                  onPointerDown={(e) => handleColumnResizeStart(`${groupId}:${colIdx - 1}`, e)}
                                >
                                  <div data-resize-bar="" style={{
                                    width: 2, borderRadius: 2, position: "absolute",
                                    top: 0, bottom: 0, left: 11,
                                    opacity: resizingGroup === `${groupId}:${colIdx - 1}` ? 1 : 0,
                                    background: "var(--primary)", transition: "opacity 0.15s", pointerEvents: "none",
                                  }} />
                                </div>
                              )}
                              <div style={{ position: "relative", minWidth: 0 }}>
                                <BlockItem
                                  block={col}
                                  ideaId={ideaId}
                                  readOnly={streaming}
                                  sourceMode={false}
                                  autoFocus={autoEditBlockId === col.id}
                                  focusTrigger={focusBlockId === col.id ? focusTrigger : 0}
                                  focusCursorPos={focusBlockId === col.id ? focusCursorPos : null}
                                  remoteUpdatePending={pendingRemoteBlockRef.current.has(col.id)}
                                  onSaved={handleBlockSaved}
                                  onDeleted={handleBlockDeleted}
                                  onCreatedAfter={handleBlockCreatedAfter}
                                  onConflict={handleBlockConflict}
                                  onFocusChange={handleBlockFocusChange}
                                  editLocked={!!focusBlockId && focusBlockId !== col.id}
                                  onEditBlocked={() => toast.info(t("idea.editLocked"))}
                                  onSplit={handleSplit}
                                  onMergeIntoPrev={handleMergeIntoPrev}
                                  onDragStart={handleBlockDragStart}
                                  isDragging={dragBlockId === col.id}
                                  dragInProgress={!!dragBlockId}
                                  onFocusPrev={() => {
                                    if (colIdx > 0) setFocusBlockId(columns[colIdx - 1].id);
                                    else if (bIdx > 0) setFocusBlockId(blocks[bIdx - 1].id);
                                  }}
                                  onFocusNext={() => {
                                    if (colIdx < columns.length - 1) setFocusBlockId(columns[colIdx + 1].id);
                                    else if (bIdx < blocks.length - 1) setFocusBlockId(blocks[bIdx + 1].id);
                                  }}
                                />
                              </div>
                            </React.Fragment>
                          );
                        })}
                      </div>
                      {showLineBelow && (
                        <div style={{ height: 2, background: "var(--primary, #1456F0)", borderRadius: 1, margin: "2px 0", pointerEvents: "none" }} />
                      )}
                      </React.Fragment>
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
          {dragBlockId && ghostState && createPortal(
            <div style={{
              position: "fixed",
              top: ghostState.mouseY - ghostState.offsetY,
              left: ghostState.mouseX - ghostState.offsetX,
              width: ghostState.width,
              height: ghostState.height,
              border: "1px dashed var(--primary, #4080FF)",
              borderRadius: 6,
              background: "rgba(20, 86, 240, 0.06)",
              pointerEvents: "none",
              zIndex: 99999,
            }} />,
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
