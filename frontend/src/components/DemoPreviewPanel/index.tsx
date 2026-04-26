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
import SidebarExpandButton from "../SidebarExpandButton";
import BlockCloseButton from "../BlockCloseButton";
import ConfirmDialog from "../ConfirmDialog/index";
import { useTranslation } from "../../i18n/index";
import {
  CLIENT_ID,
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
/* PublishIcon ← icon_language_outlined (地球，公开/上线语义) */
const PublishIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M12 1C18.0751 1 23 5.92487 23 12C23 18.0751 18.0751 23 12 23C5.92487 23 1 18.0751 1 12C1 5.92487 5.92487 1 12 1ZM8.65909 3.6405C5.6385 4.84878 3.42561 7.64679 3.05493 11H7.019C7.0342 7.80001 8 5.00001 8.65909 3.6405ZM20.9451 11C20.5744 7.64679 18.3615 4.84878 15.3409 3.6405C16 5.00001 16.9658 8.20001 16.981 11H20.9451ZM12 3C10.5 3 9 7.5 9.02056 11H14.9794C15 7.5 13.5 3 12 3ZM15.3409 20.3595C18.3615 19.1512 20.5744 16.3532 20.9451 13L16.981 13C16.9658 16.2 16 19 15.3409 20.3595ZM3.05492 13C3.4256 16.3532 5.63849 19.1512 8.65909 20.3595C8 19 7.0342 15.8 7.019 13L3.05492 13ZM12 21C13.5 21 15 16.5 14.9794 13H9.02056C9 16.5 10.5 21 12 21Z" fill="currentColor"/>
  </svg>
);
/* UnpublishIcon ← icon_cancel-offline_outlined (断开/下线语义) */
const UnpublishIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M1 12.7495C1 10.4315 2.49436 8.48911 4.54044 7.78324L6.23024 9.47304L5.82657 9.52523C4.24586 9.72959 3 11.0861 3 12.7495C3 14.1014 3.82586 15.2611 5 15.751V17.8502C2.70397 17.2892 1 15.2183 1 12.7495Z" fill="currentColor"/>
    <path d="M11 18.5858L11 14.2428L13 16.2428V18.5858L14.1715 17.4143L15.5857 18.8285L12.7071 21.7071C12.3166 22.0976 11.6834 22.0976 11.2929 21.7071L7.29289 17.7071C6.90237 17.3166 6.90237 16.6834 7.29289 16.2929C7.68342 15.9024 8.31658 15.9024 8.70711 16.2929L11 18.5858Z" fill="currentColor"/>
    <path d="M15.6491 16.0633C15.6491 16.0633 15.6492 16.0633 15.6491 16.0633L16.9366 17.351C16.9366 17.3511 16.9367 17.351 16.9366 17.351L20.6777 21.0919C21.0682 21.4824 21.7014 21.4824 22.0919 21.0919C22.4824 20.7013 22.4824 20.0682 22.0919 19.6776L5.12132 2.70708C4.7308 2.31655 4.09763 2.31655 3.70711 2.70708C3.31658 3.0976 3.31658 3.73077 3.70711 4.12129L5.88282 6.29701C5.88281 6.29705 5.88284 6.29696 5.88282 6.29701L15.6491 16.0633Z" fill="currentColor"/>
    <path d="M23 12.7495C23 14.1377 22.4613 15.4001 21.5814 16.339L20.166 14.9235C20.6844 14.3475 21 13.5852 21 12.7495C21 11.0861 19.7541 9.72959 18.1734 9.52523L16.6726 9.33119L16.4513 7.83408C16.1309 5.66516 14.2581 4 12 4C11.2055 4 10.4586 4.20615 9.81035 4.56787L8.35791 3.11543C9.39686 2.41131 10.6504 2 12 2C15.2643 2 17.9666 4.40624 18.4299 7.54173C20.9844 7.872 23 10.0574 23 12.7495Z" fill="currentColor"/>
  </svg>
);
const ExportIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M1 19.778V18.6667C1 18.1144 1.44772 17.6667 2 17.6667C2.55228 17.6667 3 18.1144 3 18.6667V19.778C3.00012 20.4529 3.54771 20.9997 4.22266 20.9997H19.7773C20.4523 20.9997 20.9999 20.4529 21 19.778V18.6667C21 18.1144 21.4477 17.6667 22 17.6667C22.5523 17.6667 23 18.1144 23 18.6667V19.778C22.9999 21.5575 21.5569 22.9997 19.7773 22.9997H4.22266C2.44314 22.9997 1.00012 21.5575 1 19.778Z" fill="currentColor"/>
    <path d="M12 2C12.5523 2.00001 13 2.44772 13 3V15.2373L15.8408 12.748C16.2562 12.384 16.8879 12.4255 17.252 12.8408C17.616 13.2561 17.5745 13.8879 17.1592 14.252L12.6592 18.1963C12.6473 18.2067 12.6344 18.2158 12.6221 18.2256C12.613 18.2328 12.604 18.2402 12.5948 18.2471C12.5823 18.2563 12.5694 18.2648 12.5567 18.2734C12.5113 18.304 12.464 18.3302 12.4151 18.3525C12.4052 18.357 12.3957 18.3621 12.3858 18.3662C12.3658 18.3745 12.3456 18.3817 12.3252 18.3887C12.3116 18.3933 12.2979 18.3973 12.2842 18.4014C12.2699 18.4056 12.2557 18.4095 12.2412 18.4131C12.2243 18.4173 12.2075 18.4215 12.1905 18.4248C12.1739 18.428 12.1574 18.4312 12.1407 18.4336C12.128 18.4354 12.1153 18.4362 12.1026 18.4375C12.0817 18.4396 12.061 18.4415 12.0401 18.4424C12.0267 18.4429 12.0134 18.4424 12 18.4424C11.9863 18.4424 11.9727 18.4429 11.959 18.4424C11.9381 18.4415 11.9173 18.4397 11.8965 18.4375C11.8838 18.4362 11.8711 18.4354 11.8584 18.4336C11.8427 18.4313 11.8272 18.4278 11.8116 18.4248C11.7926 18.4212 11.7737 18.4178 11.7549 18.4131C11.7424 18.4099 11.7302 18.406 11.7178 18.4023C11.7034 18.3981 11.6891 18.3936 11.6748 18.3887C11.6542 18.3816 11.6335 18.3747 11.6133 18.3662C11.6034 18.362 11.5938 18.357 11.584 18.3525C11.5351 18.3302 11.4878 18.304 11.4424 18.2734C11.4297 18.2648 11.4168 18.2563 11.4043 18.2471C11.395 18.2402 11.3861 18.2328 11.377 18.2256C11.3649 18.216 11.3526 18.2066 11.3408 18.1963L6.84085 14.252C6.42556 13.8879 6.38405 13.2561 6.74807 12.8408C7.11212 12.4255 7.7439 12.384 8.15921 12.748L11 15.2373V3C11 2.44772 11.4477 2 12 2Z" fill="currentColor"/>
  </svg>
);
/* SourceIcon ← icon_code_outlined (纯 "<\/>"，源码语义) */
const SourceIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M13.3094 1.08202C12.7612 1.01471 12.2622 1.40453 12.1949 1.9527L9.75756 21.8036C9.69025 22.3518 10.0801 22.8507 10.6282 22.918C11.1764 22.9853 11.6753 22.5955 11.7426 22.0474L14.18 2.19643C14.2473 1.64827 13.8575 1.14933 13.3094 1.08202Z" fill="currentColor"/>
    <path d="M8.20711 5.29289C8.59763 5.68342 8.59763 6.31658 8.20711 6.70711L2.41421 12.5L8.20711 18.2929C8.59763 18.6834 8.59763 19.3166 8.20711 19.7071C7.81658 20.0976 7.18342 20.0976 6.79289 19.7071L0.292893 13.2071C-0.0976311 12.8166 -0.0976311 12.1834 0.292893 11.7929L6.79289 5.29289C7.18342 4.90237 7.81658 4.90237 8.20711 5.29289Z" fill="currentColor"/>
    <path d="M15.7929 5.29289C15.4024 5.68342 15.4024 6.31658 15.7929 6.70711L21.5858 12.5L15.7929 18.2929C15.4024 18.6834 15.4024 19.3166 15.7929 19.7071C16.1834 20.0976 16.8166 20.0976 17.2071 19.7071L23.7071 13.2071C24.0976 12.8166 24.0976 12.1834 23.7071 11.7929L17.2071 5.29289C16.8166 4.90237 16.1834 4.90237 15.7929 5.29289Z" fill="currentColor"/>
  </svg>
);
const ChevronDownIcon = (
  <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M3.528 6.195a.667.667 0 01.944 0L8 9.724l3.528-3.529a.667.667 0 11.944.944l-4 4a.667.667 0 01-.944 0l-4-4a.667.667 0 010-.944z" fill="currentColor"/>
  </svg>
);
/* CopyIcon ← icon_copy_outlined (0041f38a…)，用在公开 URL 行的复制按钮 */
const CopyIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M9 3C9 2.44772 9.44772 2 10 2H20C20.5523 2 21 2.44772 21 3V15C21 15.5523 20.5523 16 20 16C19.4477 16 19 15.5523 19 15V4H10C9.44771 4 9 3.55228 9 3Z" fill="currentColor"/>
    <path d="M5 6C3.89543 6 3 6.89543 3 8V20C3 21.1046 3.89543 22 5 22H15C16.1046 22 17 21.1046 17 20V8C17 6.89543 16.1046 6 15 6H5ZM5 8H15V20H5L5 8Z" fill="currentColor"/>
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
  // Three mutually-exclusive surfaces around the publish button:
  //   publishConfirm       — pre-publish confirmation popover (not yet published)
  //   publishedPopoverOpen — post-publish info popover (URL + copy + unpublish)
  //   unpublishConfirm     — modal "are you sure?" when user hits unpublish
  // After a successful publish we auto-open `publishedPopoverOpen` so it
  // doubles as the "publish success" acknowledgement (no separate success
  // modal). The horizontal URL bar that used to live between topbar and
  // iframe is also rolled into this popover.
  const [publishConfirm, setPublishConfirm] = useState(false);
  const [publishedPopoverOpen, setPublishedPopoverOpen] = useState(false);
  const [unpublishConfirm, setUnpublishConfirm] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const filesPopoverRef = useRef<HTMLDivElement | null>(null);
  const publishPopoverRef = useRef<HTMLDivElement | null>(null);

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

  // Publish-confirm + published-info both live as popovers anchored to the
  // same publish/published button wrap. Shared click-outside listener: any
  // click outside the wrap dismisses whichever popover is currently open.
  useEffect(() => {
    if (!publishConfirm && !publishedPopoverOpen) return;
    function onDocClick(e: MouseEvent) {
      const el = publishPopoverRef.current;
      if (el && !el.contains(e.target as Node)) {
        setPublishConfirm(false);
        setPublishedPopoverOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [publishConfirm, publishedPopoverOpen]);

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
    const es = new EventSource(
      `/api/sync/workspaces/${encodeURIComponent(workspaceId)}/events?clientId=${encodeURIComponent(CLIENT_ID)}`,
    );
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

  // Open the confirm dialog; actual call happens in the dialog's onConfirm.
  const handlePublish = useCallback(() => {
    if (!demo) return;
    setPublishConfirm(true);
  }, [demo]);

  const confirmPublish = useCallback(async () => {
    setPublishConfirm(false);
    setBusy("publish");
    try {
      await publishDemo(demoId);
      await load();
      // Publish success: open the Published popover so the user sees the
      // URL + can copy / unpublish in one place. The popover itself builds
      // the URL from window.location.origin (see publicUrl memo), so we
      // don't need to thread `r.url` / `r.slug` through — load() has already
      // updated demo.publishSlug which flows into publicUrl.
      setPublishedPopoverOpen(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [demoId, load]);

  const handleUnpublish = useCallback(() => {
    setUnpublishConfirm(true);
  }, []);

  const confirmUnpublish = useCallback(async () => {
    setUnpublishConfirm(false);
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

  /**
   * Build the publish-confirm body text from the Demo's declared capability
   * set. We render resource ids + per-resource capability lists so the user
   * knows what the public URL will grant before they commit. Falls back to
   * "(read)" when an entry has no explicit caps (implicit table read).
   */
  const publishConfirmMessage = useMemo(() => {
    if (!demo) return "";
    const lines: string[] = [t("demo.publishConfirmBody")];
    for (const tid of demo.dataTables ?? []) {
      const caps = demo.capabilities?.[tid] || [];
      lines.push(`  • ${tid}: ${caps.length ? caps.join(", ") : "(read)"}`);
    }
    for (const iid of demo.dataIdeas ?? []) {
      const caps = demo.capabilities?.[iid] || [];
      lines.push(`  • ${iid}: ${caps.length ? caps.join(", ") : "(read)"}`);
    }
    lines.push("", t("demo.publishConfirmFooter"));
    return lines.join("\n");
  }, [demo, t]);

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

  // "Has unpublished changes" — true when the Demo is published AND the
  // current source version is ahead of the snapshot taken at last publish.
  // Drives the green dot onboarding on the Published button + the blue
  // Republish CTA inside the popover. Null sourceVersionAtPublish (legacy
  // rows) is treated as "no drift detected yet" to avoid a false positive
  // on every pre-existing publish.
  const hasPendingChanges = useMemo(() => {
    if (!demo?.publishSlug) return false;
    if (demo.sourceVersionAtPublish == null) return false;
    return demo.version > demo.sourceVersionAtPublish;
  }, [demo?.publishSlug, demo?.sourceVersionAtPublish, demo?.version]);

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
        <SidebarExpandButton />
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
          {/* V2.9.3: build / rebuild 与后续操作之间加竖线 */}
          <span className="demo-panel-topbar-sep" aria-hidden="true" />
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
          {/* Publish / Published button — single relative wrap so both
             popovers (pre-publish confirm + post-publish info) anchor to
             the same top-right spot. */}
          <div className="demo-panel-publish-wrap" ref={publishPopoverRef}>
            {demo.publishSlug ? (
              // Status-style button showing "Published" + chevron. Click
              // toggles the info popover (URL / copy / unpublish / maybe
              // republish). A small green dot sits at the top-right of
              // the button when source files have been modified after the
              // last publish — onboarding the user to open the popover
              // and use the Republish CTA inside.
              <button
                className="demo-panel-topbar-btn demo-panel-published-btn"
                onClick={() => setPublishedPopoverOpen((v) => !v)}
                disabled={busy !== null}
                aria-expanded={publishedPopoverOpen}
                title={hasPendingChanges ? t("demo.pendingChanges") : undefined}
              >
                {PublishIcon}
                {t("demo.published")}
                {ChevronDownIcon}
                {hasPendingChanges && <span className="demo-panel-pending-dot" aria-hidden="true" />}
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
            {publishConfirm && (
              /* Pre-publish confirm popover — 4px below button, right-aligned.
               * Reuses ConfirmDialog's card visuals (title / message /
               * actions). */
              <div className="demo-panel-publish-popover">
                <div className="confirm-title">
                  {t("demo.publishConfirmTitle").replace("{{name}}", demo.name)}
                </div>
                <div className="confirm-message">{publishConfirmMessage}</div>
                <div className="confirm-actions">
                  <button
                    className="confirm-btn confirm-btn-cancel"
                    onClick={() => setPublishConfirm(false)}
                  >
                    {t("confirm.cancel")}
                  </button>
                  <button
                    className="confirm-btn confirm-btn-ok"
                    onClick={confirmPublish}
                  >
                    {t("demo.publishAsWorkend")}
                  </button>
                </div>
              </div>
            )}
            {publishedPopoverOpen && publicUrl && (
              /* Post-publish info popover. Replaces both the old horizontal
               * public-url bar below the topbar AND the separate success
               * dialog. Contains: "Published as workend:" label + the URL
               * + copy icon + unpublish button. */
              <div className="demo-panel-publish-popover demo-panel-published-popover">
                <div className="confirm-title">{t("demo.publishedAsWorkend")}</div>
                <div className="demo-panel-published-url-row">
                  <a
                    className="demo-panel-published-url"
                    href={publicUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {publicUrl}
                  </a>
                  <button
                    className="demo-panel-copy-btn"
                    onClick={() => { navigator.clipboard?.writeText(publicUrl); }}
                    title={t("demo.copyUrl")}
                    aria-label={t("demo.copyUrl")}
                  >
                    {CopyIcon}
                  </button>
                </div>
                {/* Pending-changes notice + Republish CTA. Only shown when
                 * the source version has drifted past the version at last
                 * publish. Republish re-runs the publish flow (backend
                 * copies current dist/ → published/<N+1>/, keeps the same
                 * slug). The URL stays the same so the user never has to
                 * re-share. */}
                {hasPendingChanges && (
                  <div className="demo-panel-pending-notice">
                    <span className="demo-panel-pending-dot demo-panel-pending-dot-inline" />
                    {t("demo.pendingChanges")}
                  </div>
                )}
                <div className="confirm-actions">
                  <button
                    className="confirm-btn confirm-btn-cancel"
                    onClick={() => {
                      setPublishedPopoverOpen(false);
                      handleUnpublish();
                    }}
                    disabled={busy !== null}
                  >
                    {UnpublishIcon}
                    {busy === "unpublish" ? t("demo.unpublishing") : t("demo.unpublish")}
                  </button>
                  {hasPendingChanges && (
                    <button
                      className="confirm-btn confirm-btn-ok"
                      onClick={confirmPublish}
                      disabled={busy !== null || demo.lastBuildStatus !== "success"}
                      title={demo.lastBuildStatus !== "success" ? t("demo.buildFirst") : undefined}
                    >
                      {PublishIcon}
                      {busy === "publish" ? t("demo.publishing") : t("demo.republish")}
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
          <BlockCloseButton />
        </div>
      </div>

      {/* Public URL bar removed — info rolled into the "Published" popover
         anchored to the publish button in the topbar. */}

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

      {/* ─── Publish confirm — rendered as an anchored popover inside the
             topbar (see the .demo-panel-publish-wrap above). Not a modal. ─── */}

      {/* ─── Unpublish confirm ─── */}
      <ConfirmDialog
        open={unpublishConfirm}
        variant="danger"
        title={t("demo.unpublish")}
        message={t("demo.unpublishConfirm")}
        confirmLabel={t("demo.unpublish")}
        cancelLabel={t("confirm.cancel")}
        onConfirm={confirmUnpublish}
        onCancel={() => setUnpublishConfirm(false)}
      />

      {/* publish-success popover lives inline in the topbar above (anchored
          to the publish/unpublish button wrap), not as a modal. */}
    </div>
  );
}
