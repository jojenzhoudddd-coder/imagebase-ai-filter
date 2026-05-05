/**
 * SkillsTab — displays all builtin + user skills as entity cards.
 * User skills have a toggle switch; builtin skills are always-on.
 * Design: .ec card with .switch pattern from standalone ref.
 */

import { useCallback, useEffect, useState } from "react";
import { type AgentSkillSummary, listAgentSkills, toggleAgentSkill, createConversation } from "../../api";
import { useAuth } from "../../auth/AuthContext";
import { useCanvas } from "../../contexts/canvasContext";
import type { SystemBlockState } from "../../canvas/types";
import { useTranslation } from "../../i18n";
import Tooltip from "../Tooltip";
import CardGrid from "./CardGrid";
import CardMoreMenu from "./CardMoreMenu";

interface Props {
  agentId: string;
  blockId: string;
}

const ADD_SKILL_PROMPT = `我想创建一个新的自定义技能（Skill）。请引导我完成配置：
1. 技能名称
2. 描述（这个技能做什么）
3. 触发词（哪些关键词会自动激活这个技能）
4. 执行逻辑（当技能被激活时，Agent 应该遵循的规则或工作流）

请一步步引导我。`;

function timeAgo(ts: string | null): string {
  if (!ts) return "—";
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function SkillsTab({ agentId, blockId }: Props) {
  const { t } = useTranslation();
  const { workspaceId } = useAuth();
  const { addBlock, patchBlockState } = useCanvas();
  const [skills, setSkills] = useState<AgentSkillSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listAgentSkills(agentId)
      .then((data) => setSkills(data.skills))
      .catch(() => setSkills([]))
      .finally(() => setLoading(false));
  }, [agentId]);

  const handleToggle = useCallback(async (skillId: string, enabled: boolean) => {
    setSkills((prev) =>
      prev.map((s) => (s.id === skillId ? { ...s, enabled } : s)),
    );
    try {
      await toggleAgentSkill(agentId, skillId, enabled);
    } catch {
      setSkills((prev) =>
        prev.map((s) => (s.id === skillId ? { ...s, enabled: !enabled } : s)),
      );
    }
  }, [agentId]);

  const handleDeleteSkill = useCallback(async (skillId: string) => {
    setSkills((prev) => prev.filter((s) => s.id !== skillId));
    // TODO: call backend delete API
  }, []);

  const handleAddSkill = async () => {
    if (!workspaceId) return;
    try {
      const conv = await createConversation(workspaceId, agentId || undefined);
      addBlock("chat", { conversationId: conv.id, prefillMessage: ADD_SKILL_PROMPT } as any);
    } catch {
      addBlock("chat");
    }
  };

  if (loading) return <div className="ab-loading">{t("agent.block.loading")}</div>;

  return (
    <div>
      <div className="ab-toolbar">
        <button className="ab-toolbar-btn" onClick={handleAddSkill}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M7 2v10M2 7h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          {t("agent.skills.addByChat")}
        </button>
      </div>
      {skills.length === 0 ? (
        <div className="ab-empty">{t("agent.block.noSkills")}</div>
      ) : (
      <CardGrid>
      {skills.map((s) => (
        <div key={s.id} className={`ab-card${!s.enabled ? " ab-card-disabled" : ""}`}>
          <div className="ab-card-head">
            <div className="ab-card-title-block">
              <div className="ab-card-title-row">
                <Tooltip title={s.displayName || s.name}><h4 className="ab-card-title">{s.displayName || s.name}</h4></Tooltip>
                <span className={`ab-card-state ${s.type === "builtin" ? "ab-card-state-primary" : "ab-card-state-muted"}`}>
                  {s.type === "builtin" ? t("agent.card.official") : t("agent.card.custom")}
                </span>
              </div>
              {s.description && <Tooltip title={s.description}><p className="ab-card-desc">{s.description}</p></Tooltip>}
            </div>
            <div className="ab-card-controls">
              <button
                className={`ab-switch${s.enabled ? " ab-switch-on" : ""}`}
                onClick={() => handleToggle(s.id, !s.enabled)}
                aria-label="Toggle"
              >
                <span className="ab-switch-knob" />
              </button>
              <CardMoreMenu
                onViewActivities={() => patchBlockState(blockId, { activeTab: "activities", activitiesSearch: s.id } as SystemBlockState)}
                label={t("agent.activities.viewActivities")}
                onDelete={s.type === "user" ? () => handleDeleteSkill(s.id) : undefined}
              />
            </div>
          </div>
          <dl className="ab-card-kv">
            <div className="ab-card-kv-row">
              <dt>ID</dt>
              <dd>{s.id}</dd>
            </div>
            {s.triggers.length > 0 && (
              <div className="ab-card-kv-row">
                <dt>{t("agent.card.triggers")}</dt>
                <Tooltip title={s.triggers.join(", ")}><dd>{s.triggers.slice(0, 4).join(", ")}{s.triggers.length > 4 ? ` +${s.triggers.length - 4}` : ""}</dd></Tooltip>
              </div>
            )}
            <div className="ab-card-kv-row">
              <dt>{t("agent.card.lastUsed")}</dt>
              <dd>{timeAgo(s.lastUsed)}</dd>
            </div>
          </dl>
        </div>
      ))}
    </CardGrid>
      )}
    </div>
  );
}
