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
 * 14×14 · currentColor · aligned visually with the text buttons (4px gap).
 * Reused in build / publish / unpublish / export buttons so each action
 * gets a visual anchor. Matches the sidebar-icon convention (solid-fill
 * path + currentColor) instead of stroke icons. */
const BuildIcon = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M11.78 1.47a.75.75 0 011.06 0l1.69 1.69a.75.75 0 010 1.06l-1.06 1.06-2.75-2.75 1.06-1.06zM10.66 2.59l-7.6 7.6a.75.75 0 00-.2.36l-.84 3.36a.5.5 0 00.61.61l3.36-.84a.75.75 0 00.36-.2l7.6-7.6-3.29-3.29zM3.54 11.72l.74-2.96 5.6-5.6 2.22 2.22-5.6 5.6-2.96.74z" fill="currentColor"/>
  </svg>
);
const PublishIcon = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M8 1.5a.75.75 0 01.53.22l3.5 3.5a.75.75 0 11-1.06 1.06L8.75 4.06V10a.75.75 0 01-1.5 0V4.06L5.03 6.28a.75.75 0 11-1.06-1.06l3.5-3.5A.75.75 0 018 1.5zM3 9.75a.75.75 0 00-1.5 0v3.75A1.75 1.75 0 003.25 15.25h9.5A1.75 1.75 0 0014.5 13.5V9.75a.75.75 0 00-1.5 0v3.75a.25.25 0 01-.25.25h-9.5a.25.25 0 01-.25-.25V9.75z" fill="currentColor"/>
  </svg>
);
const UnpublishIcon = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M8 14.5a.75.75 0 01-.53-.22l-3.5-3.5a.75.75 0 111.06-1.06l2.22 2.22V6a.75.75 0 011.5 0v5.94l2.22-2.22a.75.75 0 111.06 1.06l-3.5 3.5a.75.75 0 01-.53.22zM3 6.25a.75.75 0 01-1.5 0V2.5A1.75 1.75 0 013.25.75h9.5A1.75 1.75 0 0114.5 2.5v3.75a.75.75 0 01-1.5 0V2.5a.25.25 0 00-.25-.25h-9.5A.25.25 0 003 2.5v3.75z" fill="currentColor"/>
  </svg>
);
const ExportIcon = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M2.75 2A1.75 1.75 0 001 3.75v8.5c0 .966.784 1.75 1.75 1.75h10.5A1.75 1.75 0 0015 12.25v-8.5A1.75 1.75 0 0013.25 2H2.75zm-.25 1.75a.25.25 0 01.25-.25h10.5a.25.25 0 01.25.25V5.5h-11V3.75zm0 3.25h11v5.25a.25.25 0 01-.25.25H2.75a.25.25 0 01-.25-.25V7z" fill="currentColor"/>
    <path d="M8 8.25a.75.75 0 01.75.75v2.19l.72-.72a.75.75 0 111.06 1.06l-2 2a.75.75 0 01-1.06 0l-2-2a.75.75 0 111.06-1.06l.72.72V9A.75.75 0 018 8.25z" fill="currentColor"/>
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
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

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

      {demo.files && demo.files.length > 0 && (
        <aside className="demo-panel-files">
          <h4>{t("demo.filesHeader")} · {demo.files.length}</h4>
          <ul>
            {demo.files.map((f) => (
              <li key={f.path}>
                <span className="demo-panel-file-path">{f.path}</span>
                <span className="demo-panel-file-size">
                  {f.size < 1024 ? `${f.size} B` : `${(f.size / 1024).toFixed(1)} KB`}
                </span>
              </li>
            ))}
          </ul>
        </aside>
      )}
    </div>
  );
}
