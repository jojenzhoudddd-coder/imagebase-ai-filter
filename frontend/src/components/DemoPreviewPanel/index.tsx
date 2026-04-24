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

/* ─── Inline icons — 直接从 Figma UD 07 图标表情库导出 ───────────────────────
 * 取法：figma.importComponentByKeyAsync(<componentKey>) →
 *      .exportAsync({ format: "SVG_STRING" })
 * 把 fill="#2B2F36" 统一替换为 fill="currentColor"，其它 path 数据原样保留。
 *
 *   BuildIcon   ← icon_refresh_outlined                (f89f99cf…)
 *   PublishIcon ← icon_ccm-outbox_outlined             (cc385647…)
 *   UnpublishIcon← icon_tab-fix_outlined               (a0d2fcc1…)
 *   ExportIcon  ← icon_base-agent-tool-download_outlined (4fc5437c…)
 * FilesIcon 复用 ExportIcon 的下载箱风格（Source 面板本质是文件列表）。 */
const BuildIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M9.92945 4.2726C11.6305 3.8168 13.4344 3.93503 15.0615 4.60897C16.5052 5.20697 17.738 6.21286 18.6127 7.49746L15.5025 7.49746C14.9503 7.49746 14.5025 7.94518 14.5025 8.49746C14.5025 9.04975 14.9503 9.49746 15.5025 9.49746L20.999 9.49746C21.3393 9.49746 21.6409 9.32746 21.8216 9.06775C21.9341 8.90599 22 8.70943 22 8.49746V3C22 2.44772 21.5523 2 21 2C20.4477 2 20 2.44772 20 3V5.99999C18.9288 4.5717 17.4897 3.45 15.8268 2.76121C13.7931 1.91879 11.5381 1.771 9.41181 2.34075C7.28547 2.9105 5.40656 4.16595 4.06647 5.91239C2.72637 7.65883 2 9.79866 2 12C2 14.2013 2.72638 16.3412 4.06647 18.0876C5.40656 19.8341 7.28548 21.0895 9.41181 21.6593C11.5381 22.229 13.7931 22.0812 15.8268 21.2388C17.8606 20.3964 19.5596 18.9064 20.6603 17C20.9364 16.5217 20.7725 15.9101 20.2942 15.634C19.8159 15.3578 19.2043 15.5217 18.9282 16C18.0477 17.5251 16.6885 18.7171 15.0615 19.391C13.4344 20.065 11.6305 20.1832 9.92945 19.7274C8.22838 19.2716 6.72525 18.2673 5.65317 16.8701C4.5811 15.4729 4 13.7611 4 12C4 10.2389 4.5811 8.52707 5.65317 7.12991C6.72525 5.73276 8.22838 4.7284 9.92945 4.2726Z" fill="currentColor"/>
  </svg>
);
const PublishIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M12.8721 12.2267L12.909 5.01312L14.9698 7.07391C15.1521 7.25616 15.4476 7.25616 15.6298 7.07391L16.2898 6.41395C16.472 6.2317 16.472 5.93623 16.2898 5.75398L12.66 2.12417C12.2955 1.75968 11.7045 1.75968 11.34 2.12417L7.71022 5.75398C7.52797 5.93623 7.52797 6.2317 7.71022 6.41395L8.37018 7.07391C8.55243 7.25616 8.8479 7.25616 9.03015 7.07391L11.0919 5.01213L11.055 12.2296C11.056 12.4873 11.2657 12.6954 11.5235 12.6945L12.4072 12.6911C12.6634 12.6901 12.8709 12.4829 12.8721 12.2267Z" fill="currentColor"/>
    <path d="M17.3271 2.66561V4.67999H19.359V12.6911H16.3938C15.8783 12.6911 15.4605 13.109 15.4605 13.6244V15.3569H8.52974V13.6244C8.52974 13.109 8.11188 12.6911 7.59641 12.6911H4.66054V4.67999H6.66308V2.66561H3.59999C3.08452 2.66561 2.66666 3.08347 2.66666 3.59894V20.3394C2.66666 20.8549 3.08452 21.2727 3.59999 21.2727H20.4C20.9155 21.2727 21.3333 20.8549 21.3333 20.3394V3.59894C21.3333 3.08347 20.9155 2.66561 20.4 2.66561H17.3271ZM4.66052 19.4061V14.6689H6.66306V16.4014C6.66306 16.9169 7.08093 17.3348 7.59639 17.3348H16.3938C16.9093 17.3348 17.3271 16.9169 17.3271 16.4014V14.6689H19.359V19.4061H4.66052Z" fill="currentColor"/>
  </svg>
);
const UnpublishIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M3.0042 3.30915C3.05435 2.75915 3.54088 2.35394 4.09088 2.4041L4.09289 2.40428L4.0952 2.4045L4.10069 2.40503L4.11517 2.40652C4.12635 2.40772 4.1406 2.40932 4.1578 2.41143C4.19219 2.41564 4.23842 2.42185 4.2956 2.43078C4.40992 2.44861 4.56828 2.4773 4.76363 2.52246C5.1541 2.61273 5.69408 2.76925 6.32626 3.03757C7.59334 3.57537 9.22628 4.56072 10.7593 6.34927C11.9052 7.68616 12.6059 9.32582 13.0187 10.585C13.2277 11.2224 13.3688 11.7805 13.4581 12.1814C13.4765 12.264 13.4927 12.34 13.5069 12.4089L16.3137 12.0393C16.667 11.9928 16.9002 12.3967 16.6833 12.6794L13.3961 16.9634C13.2616 17.1387 13.0105 17.1717 12.8352 17.0372L8.55123 13.75C8.26851 13.5331 8.38921 13.0826 8.74252 13.0361L11.5179 12.6707L11.5059 12.6161C11.4279 12.2656 11.3032 11.772 11.1183 11.2082C10.7435 10.0651 10.1441 8.70472 9.24081 7.65086C7.93516 6.1276 6.56809 5.31291 5.54485 4.87861C5.03187 4.66088 4.60411 4.53833 4.31312 4.47106C4.16774 4.43745 4.05695 4.41774 3.9873 4.40687C3.95249 4.40144 3.92802 4.39823 3.91472 4.3966L3.90354 4.3953C3.35644 4.34231 2.95421 3.85725 3.0042 3.30915Z" fill="currentColor"/>
    <path d="M5 15.0005V20H19V15C19 14.4477 19.4477 14 20 14C20.5523 14 21 14.4477 21 15V20C21 21.1046 20.1046 22 19 22H5C3.89543 22 3 21.1046 3 20V15C3 14.4477 3.44772 14 4 14C4.55228 14 5 14.4482 5 15.0005Z" fill="currentColor"/>
  </svg>
);
const ExportIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M1 19.778V18.6667C1 18.1144 1.44772 17.6667 2 17.6667C2.55228 17.6667 3 18.1144 3 18.6667V19.778C3.00012 20.4529 3.54771 20.9997 4.22266 20.9997H19.7773C20.4523 20.9997 20.9999 20.4529 21 19.778V18.6667C21 18.1144 21.4477 17.6667 22 17.6667C22.5523 17.6667 23 18.1144 23 18.6667V19.778C22.9999 21.5575 21.5569 22.9997 19.7773 22.9997H4.22266C2.44314 22.9997 1.00012 21.5575 1 19.778Z" fill="currentColor"/>
    <path d="M12 2C12.5523 2.00001 13 2.44772 13 3V15.2373L15.8408 12.748C16.2562 12.384 16.8879 12.4255 17.252 12.8408C17.616 13.2561 17.5745 13.8879 17.1592 14.252L12.6592 18.1963C12.6473 18.2067 12.6344 18.2158 12.6221 18.2256C12.613 18.2328 12.604 18.2402 12.5948 18.2471C12.5823 18.2563 12.5694 18.2648 12.5567 18.2734C12.5113 18.304 12.464 18.3302 12.4151 18.3525C12.4052 18.357 12.3957 18.3621 12.3858 18.3662C12.3658 18.3745 12.3456 18.3817 12.3252 18.3887C12.3116 18.3933 12.2979 18.3973 12.2842 18.4014C12.2699 18.4056 12.2557 18.4095 12.2412 18.4131C12.2243 18.4173 12.2075 18.4215 12.1905 18.4248C12.1739 18.428 12.1574 18.4312 12.1407 18.4336C12.128 18.4354 12.1153 18.4362 12.1026 18.4375C12.0817 18.4396 12.061 18.4415 12.0401 18.4424C12.0267 18.4429 12.0134 18.4424 12 18.4424C11.9863 18.4424 11.9727 18.4429 11.959 18.4424C11.9381 18.4415 11.9173 18.4397 11.8965 18.4375C11.8838 18.4362 11.8711 18.4354 11.8584 18.4336C11.8427 18.4313 11.8272 18.4278 11.8116 18.4248C11.7926 18.4212 11.7737 18.4178 11.7549 18.4131C11.7424 18.4099 11.7302 18.406 11.7178 18.4023C11.7034 18.3981 11.6891 18.3936 11.6748 18.3887C11.6542 18.3816 11.6335 18.3747 11.6133 18.3662C11.6034 18.362 11.5938 18.357 11.584 18.3525C11.5351 18.3302 11.4878 18.304 11.4424 18.2734C11.4297 18.2648 11.4168 18.2563 11.4043 18.2471C11.395 18.2402 11.3861 18.2328 11.377 18.2256C11.3649 18.216 11.3526 18.2066 11.3408 18.1963L6.84085 14.252C6.42556 13.8879 6.38405 13.2561 6.74807 12.8408C7.11212 12.4255 7.7439 12.384 8.15921 12.748L11 15.2373V3C11 2.44772 11.4477 2 12 2Z" fill="currentColor"/>
  </svg>
);
/* SourceIcon ← icon_file-code_outlined (e26ccd92…) */
const SourceIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M3 3C3 1.89543 3.89543 1 5 1H14.6454C15.1913 1 15.7134 1.2231 16.0907 1.61755L20.4453 6.17007C20.8013 6.54227 21 7.03746 21 7.55251V22C21 23.1046 20.1046 24 19 24H5C3.89543 24 3 23.1046 3 22V3ZM5 3V22H19V7.55252L18.9498 7.5H15.5C14.9477 7.5 14.5 7.05228 14.5 6.5V3L5 3Z" fill="currentColor"/>
    <path d="M9.65365 11.0849C10.0608 11.4581 10.0883 12.0907 9.71508 12.4978L8.13449 14.2221L9.71508 15.9464C10.0883 16.3535 10.0608 16.986 9.65365 17.3592C9.24653 17.7324 8.61396 17.7049 8.24077 17.2978L6.04077 14.8978C5.69031 14.5155 5.69031 13.9287 6.04077 13.5464L8.24077 11.1464C8.61396 10.7392 9.24653 10.7117 9.65365 11.0849Z" fill="currentColor"/>
    <path d="M14.3463 11.0849C13.9392 11.4581 13.9117 12.0907 14.2849 12.4978L15.8654 14.2221L14.2849 15.9464C13.9117 16.3535 13.9392 16.986 14.3463 17.3592C14.7534 17.7324 15.386 17.7049 15.7592 17.2978L17.9592 14.8978C18.3096 14.5155 18.3096 13.9287 17.9592 13.5464L15.7592 11.1464C15.386 10.7392 14.7534 10.7117 14.3463 11.0849Z" fill="currentColor"/>
    <path d="M12.9311 8.70553C13.4757 8.79745 13.8426 9.31344 13.7507 9.85802L12.2214 18.919C12.1295 19.4636 11.6135 19.8305 11.0689 19.7386C10.5243 19.6467 10.1573 19.1307 10.2493 18.5861L11.7786 9.52516C11.8705 8.98058 12.3865 8.61362 12.9311 8.70553Z" fill="currentColor"/>
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
          {/* Order: rebuild → source → export → publish/unpublish */}
          <button
            className="demo-panel-topbar-btn"
            onClick={handleBuild}
            disabled={busy !== null}
          >
            {BuildIcon}
            {busy === "build" ? t("demo.building") : demo.lastBuildStatus === "success" ? t("demo.rebuild") : t("demo.build")}
          </button>
          {demo.files && demo.files.length > 0 && (
            <div className="demo-panel-files-wrap" ref={filesPopoverRef}>
              <button
                className="demo-panel-topbar-btn"
                onClick={() => setFilesOpen((v) => !v)}
                aria-expanded={filesOpen}
              >
                {SourceIcon}
                {t("demo.source")}
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
          <button className="demo-panel-topbar-btn" onClick={handleExport}>
            {ExportIcon}
            {t("demo.exportWorkend")}
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
