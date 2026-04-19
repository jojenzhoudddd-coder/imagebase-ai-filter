import { useState, useEffect } from "react";
import { useTranslation } from "../i18n/index";
import { fetchDesign } from "../api";
import type { DesignDetail } from "../api";
import InlineEdit from "./InlineEdit";
import "./DesignPanel.css";

interface Props {
  designId: string;
  designName: string;
  onRename: (name: string) => void;
}

const EXTERNAL_LINK_ICON = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
    <path d="M6.667 3.333H4A1.333 1.333 0 002.667 4.667v7.333A1.333 1.333 0 004 13.333h7.333A1.333 1.333 0 0012.667 12V9.333" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
    <path d="M9.333 2.667h4v4M13.333 2.667L7.333 8.667" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

export default function DesignPanel({ designId, designName, onRename }: Props) {
  const { t } = useTranslation();
  const [design, setDesign] = useState<DesignDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [isEditing, setIsEditing] = useState(false);

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

  if (loading) {
    return (
      <div className="design-panel design-panel-loading">
        <p>{t("design.loading")}</p>
      </div>
    );
  }

  if (error || !design) {
    return (
      <div className="design-panel design-panel-error">
        <p>{t("design.notFound")}</p>
        <button onClick={() => { setLoading(true); setError(false); fetchDesign(designId).then(setDesign).catch(() => setError(true)).finally(() => setLoading(false)); }}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="design-panel">
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
        <button
          className="design-panel-edit-btn"
          onClick={() => window.open(design.figmaUrl, "_blank")}
        >
          {t("design.goToEdit")}
          {EXTERNAL_LINK_ICON}
        </button>
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
