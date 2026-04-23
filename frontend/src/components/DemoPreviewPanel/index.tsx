/**
 * DemoPreviewPanel — main content surface for a Demo artifact.
 *
 * Layout:
 *   Toolbar: [name] [build status] [Build] [Publish / Unpublish] [⋮]
 *   Body:    <iframe src="/api/demos/:id/preview/" sandbox="allow-scripts">
 *
 * Minimal V1 scope — no file tree editor, no log viewer, no capability UI.
 * The Agent drives state via chat tools; this panel just reflects and lets
 * user manually Build / Publish / Export.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchDemo,
  buildDemo,
  publishDemo,
  unpublishDemo,
  exportDemoZip,
  type DemoDetail,
} from "../../api";
import "./DemoPreviewPanel.css";

interface DemoPreviewPanelProps {
  demoId: string;
  workspaceId: string;
}

export default function DemoPreviewPanel({ demoId, workspaceId }: DemoPreviewPanelProps) {
  const [demo, setDemo] = useState<DemoDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"build" | "publish" | "unpublish" | null>(null);
  const [previewKey, setPreviewKey] = useState(0); // bump to force iframe reload
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

  // Subscribe to workspace SSE for this demo's build/publish events so the
  // panel updates live when the Agent triggers them via chat.
  useEffect(() => {
    const es = new EventSource(`/api/sync/workspace/${encodeURIComponent(workspaceId)}/events`);
    const refetch = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        if (data?.payload?.demoId === demoId) {
          load();
          if (data.type === "demo:build-status" && data.payload.status === "success") {
            setPreviewKey((k) => k + 1); // reload iframe after successful build
          }
        }
      } catch { /* ignore */ }
    };
    es.addEventListener("demo:build-status", refetch as any);
    es.addEventListener("demo:publish", refetch as any);
    es.addEventListener("demo:unpublish", refetch as any);
    es.addEventListener("demo:file-update", refetch as any);
    es.addEventListener("demo:rename", refetch as any);
    return () => { es.close(); };
  }, [demoId, workspaceId, load]);

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
    const confirmed = window.confirm(
      [
        `发布 Demo "${demo?.name}"？`,
        "",
        "访问公开 URL 的任何人（无需登录）将能：",
        ...(demo?.dataTables?.length
          ? demo.dataTables.map((t) => {
              const caps = demo.capabilities?.[t] || [];
              return `  • 表 ${t}：${caps.length ? caps.join(", ") : "（隐式读）"}`;
            })
          : []),
        ...(demo?.dataIdeas?.length
          ? demo.dataIdeas.map((i) => {
              const caps = demo.capabilities?.[i] || [];
              return `  • 文档 ${i}：${caps.length ? caps.join(", ") : "（隐式读）"}`;
            })
          : []),
        "",
        "⚠️ 该 URL 不需登录即可访问。",
        "⚠️ 访问者无法修改表结构或其他资源。",
      ].join("\n"),
    );
    if (!confirmed) return;
    setBusy("publish");
    try {
      const r = await publishDemo(demoId);
      await load();
      if (r.url) {
        window.prompt("已发布。公开 URL（复制分享）：", r.url);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [demoId, demo, load]);

  const handleUnpublish = useCallback(async () => {
    const ok = window.confirm("取消发布 Demo？公开 URL 立即失效（再次发布会生成新 slug）。");
    if (!ok) return;
    setBusy("unpublish");
    try {
      await unpublishDemo(demoId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [demoId, load]);

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

  if (loading) {
    return <div className="demo-panel-loading">加载 Demo...</div>;
  }
  if (error && !demo) {
    return <div className="demo-panel-error">加载失败：{error}</div>;
  }
  if (!demo) return null;

  return (
    <div className="demo-panel">
      <header className="demo-panel-toolbar">
        <div className="demo-panel-toolbar-left">
          <span className="demo-panel-title">{demo.name}</span>
          <span className={`demo-panel-badge demo-panel-badge-${demo.template}`}>
            {demo.template}
          </span>
          {demo.lastBuildStatus && (
            <span
              className={`demo-panel-build-status demo-panel-build-${demo.lastBuildStatus}`}
              title={demo.lastBuildError || ""}
            >
              {demo.lastBuildStatus === "success" && "✓ 已构建"}
              {demo.lastBuildStatus === "error" && "✗ 构建失败"}
              {demo.lastBuildStatus === "building" && "… 构建中"}
              {demo.lastBuildStatus === "idle" && "未构建"}
            </span>
          )}
        </div>
        <div className="demo-panel-toolbar-right">
          <button
            className="demo-panel-btn"
            onClick={handleBuild}
            disabled={busy !== null}
            title="重新编译（esbuild）"
          >
            {busy === "build" ? "构建中..." : "构建"}
          </button>
          {demo.publishSlug ? (
            <button
              className="demo-panel-btn demo-panel-btn-unpublish"
              onClick={handleUnpublish}
              disabled={busy !== null}
            >
              {busy === "unpublish" ? "…" : "取消发布"}
            </button>
          ) : (
            <button
              className="demo-panel-btn demo-panel-btn-publish"
              onClick={handlePublish}
              disabled={busy !== null || demo.lastBuildStatus !== "success"}
              title={demo.lastBuildStatus !== "success" ? "先完成构建再发布" : ""}
            >
              {busy === "publish" ? "发布中..." : "发布"}
            </button>
          )}
          <button className="demo-panel-btn" onClick={handleExport}>
            导出 zip
          </button>
        </div>
      </header>

      {publicUrl && (
        <div className="demo-panel-public-url">
          <span className="demo-panel-public-url-label">已发布：</span>
          <a href={publicUrl} target="_blank" rel="noreferrer">
            {publicUrl}
          </a>
          <button
            className="demo-panel-copy-btn"
            onClick={() => {
              navigator.clipboard?.writeText(publicUrl);
            }}
          >
            复制
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
            <h3>构建失败</h3>
            <pre className="demo-panel-build-error">{demo.lastBuildError}</pre>
            <p className="demo-panel-hint">修改源码后点"构建"重试。</p>
          </div>
        ) : (
          <div className="demo-panel-empty">
            <h3>还没有预览</h3>
            <p>让 Agent 生成代码后会自动构建，或点上方"构建"按钮手动触发。</p>
          </div>
        )}
      </div>

      {demo.files && demo.files.length > 0 && (
        <aside className="demo-panel-files">
          <h4>源文件 · {demo.files.length}</h4>
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
