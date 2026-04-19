import { useState, useEffect } from "react";
import { useTranslation } from "../i18n/index";
import { fetchDesign } from "../api";
import type { DesignDetail } from "../api";
import InlineEdit from "./InlineEdit";
import { useToast } from "./Toast/index";
import "./DesignPanel.css";

interface Props {
  designId: string;
  designName: string;
  onRename: (name: string) => void;
  /** When true the panel root is rendered with display:none so the iframe
   * stays mounted and preserves its Figma canvas state (zoom/pan/loaded
   * assets) across switches. The parent keeps a pool of panels and simply
   * toggles visibility instead of unmounting. */
  hidden?: boolean;
}

const EXTERNAL_LINK_ICON = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
    <path d="M6.667 3.333H4A1.333 1.333 0 002.667 4.667v7.333A1.333 1.333 0 004 13.333h7.333A1.333 1.333 0 0012.667 12V9.333" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
    <path d="M9.333 2.667h4v4M13.333 2.667L7.333 8.667" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

// Chain-link icon (fallback — to be replaced with canonical Figma library icon
// once the Figma MCP is reachable again).
const COPY_LINK_ICON = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <path d="M7 9a3 3 0 004.24 0l2.12-2.12a3 3 0 10-4.24-4.24L8 3.76" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M9 7a3 3 0 00-4.24 0L2.64 9.12a3 3 0 104.24 4.24L8 12.24" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

export default function DesignPanel({ designId, designName, onRename, hidden = false }: Props) {
  const { t } = useTranslation();
  const toast = useToast();
  const [design, setDesign] = useState<DesignDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  /* Whether the Figma embed iframe has signalled that it finished first-load.
   * Starts false; flipped true by iframe.onload OR by Figma's INITIAL_LOAD
   * postMessage (whichever arrives first). Flipped back to false when Figma
   * emits a NEW_STATE with isLoading=true (page switch inside the embed). */
  const [iframeLoaded, setIframeLoaded] = useState(false);

  const handleCopyLink = async () => {
    if (!design) return;
    try {
      await navigator.clipboard.writeText(design.figmaUrl);
      toast.success(t("design.linkCopied"));
    } catch {
      toast.error(t("design.linkCopyFailed"));
    }
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    fetchDesign(designId)
      .then(d => { if (!cancelled) { setDesign(d); setLoading(false); } })
      .catch(() => { if (!cancelled) { setError(true); setLoading(false); } });
    return () => { cancelled = true; };
  }, [designId]);

  /* Listen for messages coming from the Figma embed. Figma posts INITIAL_LOAD
   * when its canvas is interactive and NEW_STATE with `isLoading` flag while
   * switching pages inside a file. We flip the loading overlay accordingly so
   * the UX during an intra-file page switch matches the first-load UX. */
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (!e.origin.includes("figma.com")) return;
      const data = typeof e.data === "string"
        ? (() => { try { return JSON.parse(e.data); } catch { return null; } })()
        : e.data;
      if (!data || typeof data !== "object") return;
      if (data.type === "INITIAL_LOAD") {
        setIframeLoaded(true);
      } else if (data.type === "NEW_STATE" && data.data && typeof data.data.isLoading === "boolean") {
        setIframeLoaded(!data.data.isLoading);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  // Figma embed URL.
  //   footer=false  — hides the bottom "Figma • Edited X ago" strip
  //   hide-ui=1     — collapses the top title bar so the canvas fills the frame
  //   (both params are officially supported; see Figma embed docs)
  const embedUrl = design
    ? `https://embed.figma.com/design/${design.figmaFileKey}/${encodeURIComponent(designName)}?embed-host=${location.hostname}&footer=false${design.figmaNodeId ? `&node-id=${design.figmaNodeId}` : ""}`
    : "";

  const hideStyle = hidden ? { display: "none" as const } : undefined;

  if (loading) {
    return (
      <div className="design-panel design-panel-loading" style={hideStyle}>
        <p>{t("design.loading")}</p>
      </div>
    );
  }

  if (error || !design) {
    return (
      <div className="design-panel design-panel-error" style={hideStyle}>
        <p>{t("design.notFound")}</p>
        <button onClick={() => { setLoading(true); setError(false); fetchDesign(designId).then(setDesign).catch(() => setError(true)).finally(() => setLoading(false)); }}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="design-panel" style={hideStyle}>
      <div className="design-panel-topbar">
        <span className="design-panel-name">
          <InlineEdit
            value={designName}
            isEditing={isEditing}
            onStartEdit={() => setIsEditing(true)}
            onSave={(name) => { setIsEditing(false); onRename(name); }}
            onCancelEdit={() => setIsEditing(false)}
            className="design-panel-name-edit"
          />
        </span>
        <div className="design-panel-actions">
          <button
            className="design-panel-edit-btn"
            onClick={() => window.open(design.figmaUrl, "_blank")}
          >
            {t("design.goToEdit")}
            {EXTERNAL_LINK_ICON}
          </button>
          <button
            className="design-panel-icon-btn"
            onClick={handleCopyLink}
            title={t("design.copyLink")}
            aria-label={t("design.copyLink")}
          >
            {COPY_LINK_ICON}
          </button>
        </div>
      </div>
      {/* No `sandbox` attribute: Figma's embed needs the full default set of
       * iframe capabilities (pointer-lock-style gesture capture, clipboard for
       * copy, fullscreen) to drive the canvas. With a restricted sandbox the
       * two-finger trackpad pan doesn't work because Figma's JS can't capture
       * the wheel/pointer stream properly. Figma's own embed docs don't ask
       * for any sandbox; they host the iframe on their own `embed.figma.com`
       * origin which is already cross-origin and therefore isolated. */}
      <div className="design-panel-iframe-wrap">
        {/* Indeterminate progress bar: visible while the Figma embed hasn't
         * finished its first load, or while Figma reports it's transitioning
         * to another page. Sits above the iframe (z-index) so the user gets
         * immediate feedback without tearing down the iframe — which would
         * defeat the caching pool. */}
        {!iframeLoaded && <div className="design-panel-progress" aria-hidden="true" />}
        <iframe
          className="design-panel-iframe"
          src={embedUrl}
          allow="clipboard-read; clipboard-write; fullscreen"
          allowFullScreen
          onLoad={() => setIframeLoaded(true)}
        />
      </div>
    </div>
  );
}
