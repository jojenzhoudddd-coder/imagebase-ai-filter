/**
 * DemoPreviewPanel — main content surface for a Demo artifact.
 *
 * Visual structure deliberately mirrors IdeaEditor / SvgCanvas:
 *   44px topbar (name left with inline-edit rename, status + text-buttons right)
 *   + body (iframe or empty/error state) + optional file list aside.
 *
 * Publish is called "workend" throughout the UI (product terminology). Same
 * string across zh + en per product decision — see i18n keys demo.*.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import InlineEdit from "../InlineEdit";
import { useTranslation } from "../../i18n/index";
import {
  fetchDemo,
  buildDemo,
  publishDemo,
  unpublishDemo,
  exportDemoZip,
  renameDemo,
  type DemoDetail,
} from "../../api";
import "./DemoPreviewPanel.css";

/* ─── Inline icons ─────────────────────────────────────────────────────────
 * 14px render size · 24×24 viewBox · solid-fill geometry with fill="currentColor"
 * ——— 与 UD 07 图标库 icon_*_outlined 系列的视觉语言严格一致（2px 描边粗细、
 * 圆角端点、实心 path 而非 stroke）：
 *   BuildIcon    ↔ icon_refresh_outlined（循环箭头，刷新/重新构建）
 *   PublishIcon  ↔ icon_ccm-outbox_outlined（发件箱向上箭头，发布/上传）
 *   UnpublishIcon↔ icon_tab-fix_outlined（收件箱向下箭头，收回/取消发布）
 *   ExportIcon   ↔ icon_base-agent-tool-download_outlined（下载/导出）
 * 和 sidebar 的 DEMO_ICON 同一套几何规则，所以顶栏按钮与左侧产物 icon 视觉
 * 一致。 */
const BuildIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M12 4C14.2091 4 16.2091 4.89543 17.6569 6.34315L19.4142 4.58579C19.7392 4.26082 20.2608 4.2072 20.6434 4.45492C21.026 4.70263 21.2179 5.16016 21.1236 5.61803L20.1236 10.618C20.0489 10.9916 19.7416 11.2989 19.368 11.3736L14.368 12.3736C13.9102 12.4679 13.4526 12.276 13.2049 11.8934C12.9572 11.5108 13.0108 10.9892 13.3358 10.6642L15.1568 8.8432C14.3472 8.32212 13.3916 8 12.3333 8C9.57188 8 7.33329 10.2386 7.33329 13H3.33329C3.33329 8.02944 7.36273 4 12.3333 4H12ZM20.6667 11C20.6667 15.9706 16.6372 20 11.6667 20H11.9999C9.79076 20 7.79076 19.1046 6.34298 17.6568L4.58566 19.4142C4.26069 19.7392 3.73905 19.7928 3.35648 19.5451C2.97391 19.2974 2.78196 18.8398 2.87633 18.382L3.87633 13.382C3.95099 13.0084 4.25831 12.7011 4.63189 12.6264L9.63189 11.6264C10.0898 11.5321 10.5473 11.724 10.795 12.1066C11.0427 12.4892 10.9891 13.0108 10.6641 13.3358L8.84313 15.1568C9.65272 15.6779 10.6083 16 11.6667 16C14.428 16 16.6666 13.7614 16.6666 11H20.6667Z" fill="currentColor"/>
  </svg>
);
const PublishIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M12 2.58579L12.7071 3.29289L16.7071 7.29289C17.0976 7.68342 17.0976 8.31658 16.7071 8.70711C16.3166 9.09763 15.6834 9.09763 15.2929 8.70711L13 6.41421V15C13 15.5523 12.5523 16 12 16C11.4477 16 11 15.5523 11 15V6.41421L8.70711 8.70711C8.31658 9.09763 7.68342 9.09763 7.29289 8.70711C6.90237 8.31658 6.90237 7.68342 7.29289 7.29289L11.2929 3.29289L12 2.58579Z" fill="currentColor"/>
    <path d="M4 13C4.55228 13 5 13.4477 5 14V19C5 19.5523 5.44772 20 6 20H18C18.5523 20 19 19.5523 19 19V14C19 13.4477 19.4477 13 20 13C20.5523 13 21 13.4477 21 14V19C21 20.6569 19.6569 22 18 22H6C4.34315 22 3 20.6569 3 19V14C3 13.4477 3.44772 13 4 13Z" fill="currentColor"/>
  </svg>
);
const UnpublishIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M12 16.4142L11.2929 15.7071L7.29289 11.7071C6.90237 11.3166 6.90237 10.6834 7.29289 10.2929C7.68342 9.90237 8.31658 9.90237 8.70711 10.2929L11 12.5858V4C11 3.44772 11.4477 3 12 3C12.5523 3 13 3.44772 13 4V12.5858L15.2929 10.2929C15.6834 9.90237 16.3166 9.90237 16.7071 10.2929C17.0976 10.6834 17.0976 11.3166 16.7071 11.7071L12.7071 15.7071L12 16.4142Z" fill="currentColor"/>
    <path d="M4 13C4.55228 13 5 13.4477 5 14V19C5 19.5523 5.44772 20 6 20H18C18.5523 20 19 19.5523 19 19V14C19 13.4477 19.4477 13 20 13C20.5523 13 21 13.4477 21 14V19C21 20.6569 19.6569 22 18 22H6C4.34315 22 3 20.6569 3 19V14C3 13.4477 3.44772 13 4 13Z" fill="currentColor"/>
  </svg>
);
const ExportIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M5 4C4.44772 4 4 4.44772 4 5V19C4 19.5523 4.44772 20 5 20H19C19.5523 20 20 19.5523 20 19V12C20 11.4477 20.4477 11 21 11C21.5523 11 22 11.4477 22 12V19C22 20.6569 20.6569 22 19 22H5C3.34315 22 2 20.6569 2 19V5C2 3.34315 3.34315 2 5 2H12C12.5523 2 13 2.44772 13 3C13 3.55228 12.5523 4 12 4H5Z" fill="currentColor"/>
    <path d="M15 3C15 2.44772 15.4477 2 16 2H21C21.5523 2 22 2.44772 22 3V8C22 8.55228 21.5523 9 21 9C20.4477 9 20 8.55228 20 8V5.41421L13.7071 11.7071C13.3166 12.0976 12.6834 12.0976 12.2929 11.7071C11.9024 11.3166 11.9024 10.6834 12.2929 10.2929L18.5858 4H16C15.4477 4 15 3.55228 15 3Z" fill="currentColor"/>
  </svg>
);
const FilesIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M4 4C4 2.89543 4.89543 2 6 2H13.5858C14.1162 2 14.6249 2.21071 15 2.58579L19.4142 7C19.7893 7.37507 20 7.88378 20 8.41421V20C20 21.1046 19.1046 22 18 22H6C4.89543 22 4 21.1046 4 20V4ZM13 4H6V20H18V9H14C13.4477 9 13 8.55228 13 8V4ZM15 4.41421L17.5858 7H15V4.41421Z" fill="currentColor"/>
    <path d="M8 12C8 11.4477 8.44772 11 9 11H15C15.5523 11 16 11.4477 16 12C16 12.5523 15.5523 13 15 13H9C8.44772 13 8 12.5523 8 12Z" fill="currentColor"/>
    <path d="M8 16C8 15.4477 8.44772 15 9 15H15C15.5523 15 16 15.4477 16 16C16 16.5523 15.5523 17 15 17H9C8.44772 17 8 16.5523 8 16Z" fill="currentColor"/>
  </svg>
);
const ChevronDownIcon = (
  <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M3.528 6.195a.667.667 0 01.944 0L8 9.724l3.528-3.529a.667.667 0 11.944.944l-4 4a.667.667 0 01-.944 0l-4-4a.667.667 0 010-.944z" fill="currentColor"/>
  </svg>
);

interface DemoPreviewPanelProps {
  demoId: string;
  workspaceId: string;
  onRename?: (name: string) => void;
}

export default function DemoPreviewPanel({ demoId, workspaceId, onRename }: DemoPreviewPanelProps) {
  const { t } = useTranslation();
  const [demo, setDemo] = useState<DemoDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"build" | "publish" | "unpublish" | null>(null);
  const [previewKey, setPreviewKey] = useState(0);
  const [isEditingName, setIsEditingName] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const filesPopoverRef = useRef<HTMLDivElement | null>(null);

  // Close files popover on click outside (standard popover pattern used
  // elsewhere in the app, e.g. DropdownMenu). Scoped to document so we
  // catch clicks that missed the button but hit the iframe wrapper.
  useEffect(() => {
    if (!filesOpen) return;
    function onDocClick(e: MouseEvent) {
      const el = filesPopoverRef.current;
      if (el && !el.contains(e.target as Node)) setFilesOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [filesOpen]);

  const load = useCallback(async () => {
    try {
      const d = await fetchDemo(demoId, true);
      setDemo(d);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [demoId]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  // SSE: refresh on build/publish and reload iframe after successful build.
  useEffect(() => {
    const es = new EventSource(`/api/sync/workspaces/${encodeURIComponent(workspaceId)}/events`);
    const refetch = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        if (data?.payload?.demoId === demoId) {
          load();
          if (data.type === "demo:build-status" && data.payload.status === "success") {
            setPreviewKey((k) => k + 1);
          }
        }
      } catch { /* ignore */ }
    };
    es.addEventListener("workspace-change", refetch as any);
    return () => { es.close(); };
  }, [demoId, workspaceId, load]);

  // Rename — persists + propagates to sidebar via workspace SSE (demo:rename).
  const handleRename = useCallback(
    async (newName: string) => {
      setIsEditingName(false);
      if (!demo || !newName || newName === demo.name) return;
      try {
        await renameDemo(demo.id, newName);
        setDemo({ ...demo, name: newName });
        onRename?.(newName);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [demo, onRename],
  );

  const handleBuild = useCallback(async () => {
    setBusy("build");
    try {
      const r = await buildDemo(demoId);
      if (!r.ok) setError(r.error || "Build failed");
      await load();
      if (r.ok) setPreviewKey((k) => k + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [demoId, load]);

  const handlePublish = useCallback(async () => {
    if (!demo) return;
    const lines: string[] = [
      t("demo.publishConfirmTitle").replace("{{name}}", demo.name),
      "",
      t("demo.publishConfirmBody"),
    ];
    for (const tid of demo.dataTables ?? []) {
      const caps = demo.capabilities?.[tid] || [];
      lines.push(`  • ${tid}: ${caps.length ? caps.join(", ") : "(read)"}`);
    }
    for (const iid of demo.dataIdeas ?? []) {
      const caps = demo.capabilities?.[iid] || [];
      lines.push(`  • ${iid}: ${caps.length ? caps.join(", ") : "(read)"}`);
    }
    lines.push("", t("demo.publishConfirmFooter"));
    if (!window.confirm(lines.join("\n"))) return;
    setBusy("publish");
    try {
      const r = await publishDemo(demoId);
      await load();
      if (r.url) window.prompt(t("demo.publishSuccessPrompt"), r.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [demoId, demo, load, t]);

  const handleUnpublish = useCallback(async () => {
    if (!window.confirm(t("demo.unpublishConfirm"))) return;
    setBusy("unpublish");
    try {
      await unpublishDemo(demoId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [demoId, load, t]);

  const handleExport = useCallback(async () => {
    try {
      const url = await exportDemoZip(demoId);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${demo?.name || demoId}.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [demoId, demo]);

  const publicUrl = useMemo(() => {
    if (!demo?.publishSlug) return null;
    return `${window.location.origin}/share/${demo.publishSlug}`;
  }, [demo?.publishSlug]);

  const statusLabel = useMemo(() => {
    if (!demo?.lastBuildStatus) return null;
    switch (demo.lastBuildStatus) {
      case "success": return t("demo.status.success");
      case "error":   return t("demo.status.error");
      case "building": return t("demo.building");
      case "idle":     return t("demo.status.idle");
    }
    return null;
  }, [demo?.lastBuildStatus, t]);

  if (loading) {
    return <div className="demo-panel-loading">{t("demo.loading")}</div>;
  }
  if (error && !demo) {
    return <div className="demo-panel-error">{t("demo.loadFailed")}: {error}</div>;
  }
  if (!demo) return null;

  return (
    <div className="demo-panel">
      {/* ─── Top Bar (mirrors IdeaEditor / SvgCanvas) ─── */}
      <div className="demo-panel-topbar">
        <span className="demo-panel-topbar-name">
          <InlineEdit
            value={demo.name}
            isEditing={isEditingName}
            onStartEdit={() => setIsEditingName(true)}
            onSave={handleRename}
            onCancelEdit={() => setIsEditingName(false)}
          />
        </span>
        <div className="demo-panel-topbar-actions">
          {statusLabel && (
            <span
              className={`demo-panel-status demo-panel-status-${demo.lastBuildStatus}`}
              title={demo.lastBuildError || undefined}
            >
              {statusLabel}
            </span>
          )}
          <button
            className="demo-panel-topbar-btn"
            onClick={handleBuild}
            disabled={busy !== null}
          >
            {BuildIcon}
            {busy === "build" ? t("demo.building") : demo.lastBuildStatus === "success" ? t("demo.rebuild") : t("demo.build")}
          </button>
          {demo.publishSlug ? (
            <button
              className="demo-panel-topbar-btn"
              onClick={handleUnpublish}
              disabled={busy !== null}
            >
              {UnpublishIcon}
              {busy === "unpublish" ? t("demo.unpublishing") : t("demo.unpublish")}
            </button>
          ) : (
            <button
              className="demo-panel-topbar-btn demo-panel-topbar-btn-primary"
              onClick={handlePublish}
              disabled={busy !== null || demo.lastBuildStatus !== "success"}
              title={demo.lastBuildStatus !== "success" ? t("demo.buildFirst") : undefined}
            >
              {PublishIcon}
              {busy === "publish" ? t("demo.publishing") : t("demo.publishAsWorkend")}
            </button>
          )}
          <button className="demo-panel-topbar-btn" onClick={handleExport}>
            {ExportIcon}
            {t("demo.exportWorkend")}
          </button>
          {demo.files && demo.files.length > 0 && (
            <div className="demo-panel-files-wrap" ref={filesPopoverRef}>
              <button
                className="demo-panel-topbar-btn"
                onClick={() => setFilesOpen((v) => !v)}
                aria-expanded={filesOpen}
              >
                {FilesIcon}
                {t("demo.filesHeader")} · {demo.files.length}
                {ChevronDownIcon}
              </button>
              {filesOpen && (
                <div className="demo-panel-files-popover">
                  <ul>
                    {demo.files.map((f) => (
                      <li key={f.path}>
                        <span className="demo-panel-file-path" title={f.path}>{f.path}</span>
                        <span className="demo-panel-file-size">
                          {f.size < 1024 ? `${f.size} B` : `${(f.size / 1024).toFixed(1)} KB`}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {publicUrl && (
        <div className="demo-panel-public-url">
          <span className="demo-panel-public-url-label">{t("demo.publicUrlLabel")}</span>
          <a href={publicUrl} target="_blank" rel="noreferrer">
            {publicUrl}
          </a>
          <button
            className="demo-panel-copy-btn"
            onClick={() => { navigator.clipboard?.writeText(publicUrl); }}
          >
            {t("demo.copyUrl")}
          </button>
        </div>
      )}

      {error && (
        <div className="demo-panel-error-banner" onClick={() => setError(null)}>
          {error}
          <span className="demo-panel-error-close">×</span>
        </div>
      )}

      <div className="demo-panel-body">
        {demo.lastBuildStatus === "success" ? (
          <iframe
            key={previewKey}
            ref={iframeRef}
            className="demo-panel-iframe"
            src={`/api/demos/${encodeURIComponent(demo.id)}/preview/`}
            sandbox="allow-scripts allow-forms allow-popups"
            title={`Demo preview: ${demo.name}`}
          />
        ) : demo.lastBuildStatus === "error" ? (
          <div className="demo-panel-build-failed">
            <h3>{t("demo.buildFailed")}</h3>
            <pre className="demo-panel-build-error">{demo.lastBuildError}</pre>
            <p className="demo-panel-hint">{t("demo.buildFailedHint")}</p>
          </div>
        ) : (
          <div className="demo-panel-empty">
            <h3>{t("demo.noPreview")}</h3>
            <p>{t("demo.noPreviewHint")}</p>
          </div>
        )}
      </div>

    </div>
  );
}
