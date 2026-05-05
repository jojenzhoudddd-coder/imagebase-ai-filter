/**
 * AgentTabs — 7-tab horizontal bar for the agent block.
 * Reuses the existing i18n keys from chat.agent.menu.*.
 */

import type { AgentTabKey } from "../../canvas/types";
import { useTranslation } from "../../i18n";

const TABS: ReadonlyArray<{ key: AgentTabKey; i18nKey: string }> = [
  { key: "nature", i18nKey: "chat.agent.menu.nature" },
  { key: "models", i18nKey: "chat.agent.menu.models" },
  { key: "habits", i18nKey: "chat.agent.menu.habits" },
  { key: "skills", i18nKey: "chat.agent.menu.skills" },
  { key: "acknowledge", i18nKey: "chat.agent.menu.acknowledge" },
  { key: "integrations", i18nKey: "chat.agent.menu.integrations" },
  { key: "activities", i18nKey: "chat.agent.menu.activities" },
];

interface Props {
  activeTab: AgentTabKey;
  onTabChange: (tab: AgentTabKey) => void;
}

export default function AgentTabs({ activeTab, onTabChange }: Props) {
  const { t } = useTranslation();
  return (
    <div className="ab-tabs">
      {TABS.map((tab) => (
        <button
          key={tab.key}
          className={`ab-tab${tab.key === activeTab ? " active" : ""}`}
          onClick={() => onTabChange(tab.key)}
        >
          {t(tab.i18nKey)}
        </button>
      ))}
    </div>
  );
}
