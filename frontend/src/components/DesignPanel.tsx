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

  const embedUrl = design
    ? `https://embed.figma.com/design/${design.figmaFileKey}/${encodeURIComponent(designName)}?embed-host=${location.hostname}${design.figmaNodeId ? `&node-id=${design.figmaNodeId}` : ""}`
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
            className="design-panel-icon-btn"
            onClick={handleCopyLink}
            title={t("design.copyLink")}
            aria-label={t("design.copyLink")}
          >
            {COPY_LINK_ICON}
          </button>
          <button
            className="design-panel-edit-btn"
            onClick={() => window.open(design.figmaUrl, "_blank")}
          >
            {t("design.goToEdit")}
            {EXTERNAL_LINK_ICON}
          </button>
        </div>
      </div>
      <iframe
        className="design-panel-iframe"
        src={embedUrl}
        sandbox="allow-scripts allow-same-origin allow-popups"
        allowFullScreen
      />
    </div>
  );
}
