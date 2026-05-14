import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "../../i18n/index";
import { useToast } from "../Toast/index";
import InlineEdit from "../InlineEdit";
import SidebarExpandButton from "../SidebarExpandButton";
import BlockCloseButton from "../BlockCloseButton";
import { fetchIdea, saveIdeaContent, uploadIdeaAttachment } from "../../api";
import { useIdeaSync } from "../../hooks/useIdeaSync";
import TiptapPreview from "./TiptapPreview";
import type { TiptapPreviewHandle } from "./TiptapPreview";
import CodeMirrorSource from "./CodeMirrorSource";
import type { CodeMirrorSourceHandle } from "./CodeMirrorSource";
import { splitMarkdownBlocks } from "./mdBlockSplitter";
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
const UPLOAD_ICON = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
    <path d="M12 4v12m0-12 4 4m-4-4-4 4M4 18v1a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
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
  const [editingBlock, setEditingBlock] = useState<{
    startLine: number;
    endLine: number;  // inclusive
    raw: string;
    domNode: HTMLElement;
    isMultiLine: boolean;
  } | null>(null);

  const cmRef = useRef<CodeMirrorSourceHandle>(null);
  const previewRef = useRef<TiptapPreviewHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const editTextareaRef = useRef<HTMLTextAreaElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef(content);
  useEffect(() => { contentRef.current = content; }, [content]);

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

  // ── Load idea ──
  useEffect(() => {
    let alive = true;
    setLoaded(false);
    setContent("");
    setSaveStatus("idle");
    versionRef.current = 0;
    fetchIdea(ideaId)
      .then((idea) => {
        if (!alive) return;
        setContent(idea.content || "");
        versionRef.current = idea.version ?? 0;
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
    }, []),
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

  const handleUploadClick = useCallback(() => { fileInputRef.current?.click(); }, []);
  const handleFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    void uploadAndInsert(files);
    e.target.value = "";
  }, [uploadAndInsert]);

  const handleImageUpload = useCallback(async (file: File) => {
    const att = await uploadIdeaAttachment(ideaId, file);
    return { url: att.url, mime: att.mime, originalName: att.originalName };
  }, [ideaId]);

  // ── Inline block editing ──

  /** Find the markdown block that best matches the clicked ProseMirror node.
   *  Primary: index-based (same position). Fallback: content-based (text match). */
  const findBlockForNode = useCallback((nodeIndex: number, domNode: HTMLElement) => {
    const blocks = splitMarkdownBlocks(contentRef.current);
    if (blocks.length === 0) return null;
    // Try index match first
    if (nodeIndex < blocks.length) {
      const candidate = blocks[nodeIndex];
      // Sanity check: does the text roughly match?
      const domText = (domNode.textContent ?? "").trim();
      const blockText = candidate.raw.replace(/^[#>|\-*+\d.`~\s]+/gm, "").trim();
      if (domText && blockText && (domText.includes(blockText.slice(0, 30)) || blockText.includes(domText.slice(0, 30)))) {
        return candidate;
      }
      // Index matched but content doesn't — fall through to content search
    }
    // Content-based fallback: find block whose stripped text best matches DOM text
    const domText = (domNode.textContent ?? "").trim().slice(0, 60);
    if (!domText) return blocks[nodeIndex] ?? null; // last resort
    for (const b of blocks) {
      const stripped = b.raw.replace(/^[#>|\-*+\d.`~\s]+/gm, "").trim();
      if (stripped.includes(domText.slice(0, 30)) || domText.includes(stripped.slice(0, 30))) {
        return b;
      }
    }
    return nodeIndex < blocks.length ? blocks[nodeIndex] : null;
  }, []);

  const handleBlockClick = useCallback((nodeIndex: number, domNode: HTMLElement) => {
    if (streaming || editingBlock) return;
    const block = findBlockForNode(nodeIndex, domNode);
    if (!block) return;
    const firstLine = block.raw.trimStart();
    const multiLineContent = block.endLine > block.startLine;
    const isMultiLine = multiLineContent
      || /^(`{3,}|~{3,})/.test(firstLine)
      || /^\|/.test(firstLine)
      || /^>/.test(firstLine)
      || /^(\d+\.\s|[-*+]\s)/.test(firstLine);
    setEditingBlock({ startLine: block.startLine, endLine: block.endLine, raw: block.raw, domNode, isMultiLine });
  }, [streaming, editingBlock, findBlockForNode]);

  // Use ref for commit so click-outside handler doesn't get stale closures
  const commitRef = useRef<() => void>(() => {});
  commitRef.current = () => {
    if (!editingBlock) return;
    const textarea = editTextareaRef.current;
    if (!textarea) { setEditingBlock(null); return; }
    const newRaw = textarea.value;
    if (newRaw === editingBlock.raw) { setEditingBlock(null); return; }
    const lines = contentRef.current.split("\n");
    const before = lines.slice(0, editingBlock.startLine);
    const after = lines.slice(editingBlock.endLine + 1);
    const newContent = [...before, ...newRaw.split("\n"), ...after].join("\n");
    setContent(newContent);
    setEditingBlock(null);
    scheduleSave();
    requestAnimationFrame(() => { previewRef.current?.reload(); });
  };

  const handleEditTextareaInput = useCallback(() => {
    const ta = editTextareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = ta.scrollHeight + "px";
  }, []);

  const handleEditKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setEditingBlock(null);
      return;
    }
    if (!editingBlock) return;
    if (editingBlock.isMultiLine) {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        commitRef.current();
      }
    } else {
      if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        commitRef.current();
      }
    }
  }, [editingBlock]);

  // Click outside to commit — use pointerdown for reliability + capture phase
  useEffect(() => {
    if (!editingBlock) return;
    const handler = (e: PointerEvent) => {
      const ta = editTextareaRef.current;
      if (ta && !ta.contains(e.target as Node)) {
        commitRef.current();
      }
    };
    // requestAnimationFrame to skip the same click that opened the editor
    const raf = requestAnimationFrame(() => {
      document.addEventListener("pointerdown", handler, true);
    });
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("pointerdown", handler, true);
    };
  }, [editingBlock]);

  // Auto-focus and auto-grow on mount
  useEffect(() => {
    if (!editingBlock) return;
    const ta = editTextareaRef.current;
    if (!ta) return;
    ta.focus();
    ta.style.height = "auto";
    ta.style.height = ta.scrollHeight + "px";
    ta.selectionStart = ta.selectionEnd = ta.value.length;
  }, [editingBlock]);

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
    setMode((m) => {
      if (m === "source") {
        caretOffsetRef.current = cmRef.current?.getCaret() ?? 0;
      } else {
        // preview → source: sync any changes made in preview (e.g. image drop)
        caretOffsetRef.current = previewRef.current?.getCaretSourceOffset() ?? 0;
        if (previewRef.current?.isDirty()) {
          const tiptapMd = previewRef.current.getMarkdown();
          // Update contentRef so source mode sees the latest
          contentRef.current = tiptapMd;
          previewRef.current.clearDirty();
        }
        // Always sync content state from contentRef. This covers two cases:
        // 1. Tiptap was dirty (image drop) → contentRef just updated above
        // 2. Autosave already ran → contentRef was updated by flushSave
        //    but content state was stale
        setContent(contentRef.current);
      }
      return m === "source" ? "preview" : "source";
    });
  }, []);

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
            className={`idea-editor-topbar-btn${streaming ? " disabled" : ""}`}
            onClick={handleUploadClick} disabled={streaming}
            title={t("idea.uploadAttachment")}
          >
            {UPLOAD_ICON}{t("idea.uploadAttachment")}
          </button>
          <input ref={fileInputRef} type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,image/avif,image/svg+xml,application/pdf,video/mp4,video/webm"
            multiple style={{ display: "none" }} onChange={handleFileInputChange}
          />
          <button
            className={`idea-editor-topbar-btn${editingBlock ? " disabled" : ""}`}
            onClick={toggleMode} disabled={!!editingBlock}
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
        ) : mode === "source" ? (
          <CodeMirrorSource
            ref={cmRef} value={content} readOnly={streaming} streaming={streaming}
            placeholder={t("idea.empty")} onChange={handleSourceChange}
            onPasteFiles={handleSourcePasteFiles} onDropFiles={handleSourceDropFiles}
          />
        ) : (
          <TiptapPreview
            ref={previewRef} source={content}
            onDirty={handlePreviewDirty} placeholder={t("idea.previewEmpty")}
            onUploadFile={handleImageUpload} onMentionClick={() => {}}
            onBlockClick={handleBlockClick}
          />
        )}
        {editingBlock && mode === "preview" && (() => {
          const bodyEl = bodyRef.current;
          const node = editingBlock.domNode;
          if (!bodyEl || !node) return null;
          const nodeRect = node.getBoundingClientRect();
          const bodyRect = bodyEl.getBoundingClientRect();
          const style: CSSProperties = {
            top: nodeRect.top - bodyRect.top + bodyEl.scrollTop,
            left: nodeRect.left - bodyRect.left + bodyEl.scrollLeft,
            width: nodeRect.width,
            minHeight: nodeRect.height,
          };
          return (
            <textarea
              ref={editTextareaRef}
              className="idea-block-edit-overlay"
              defaultValue={editingBlock.raw}
              style={style}
              onInput={handleEditTextareaInput}
              onKeyDown={handleEditKeyDown}
            />
          );
        })()}
      </div>
    </div>
  );
}
