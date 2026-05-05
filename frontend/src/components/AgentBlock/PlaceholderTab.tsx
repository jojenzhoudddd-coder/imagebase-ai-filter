/**
 * PlaceholderTab — empty state for acknowledge / habits / integrations tabs.
 */

import { useTranslation } from "../../i18n";

export default function PlaceholderTab() {
  const { t } = useTranslation();
  return (
    <div className="ab-placeholder">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <path d="M12 6v6l4 2" />
      </svg>
      <span>{t("agent.block.comingSoon")}</span>
    </div>
  );
}
