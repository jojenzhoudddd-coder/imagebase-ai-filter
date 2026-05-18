/**
 * SkillsTab — displays all builtin + user skills as entity cards.
 * User skills have a toggle switch; builtin skills are always-on.
 * Design: .ec card with .switch pattern from standalone ref.
 */

import { useCallback, useEffect, useState } from "react";
import { type AgentSkillSummary, listAgentSkills, toggleAgentSkill, deleteUserSkill, createConversation } from "../../api";
import { useAuth } from "../../auth/AuthContext";
import { useCanvas } from "../../contexts/canvasContext";
import { useWorkspace } from "../../contexts/workspaceContext";
import type { SystemBlockState } from "../../canvas/types";
import { useTranslation } from "../../i18n";
import { useToast } from "../Toast/index";
import Tooltip from "../Tooltip";
import CardGrid from "./CardGrid";
import CardMoreMenu from "./CardMoreMenu";
import { useAgentHomeRefresh } from "./agentHomeEvents";

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

function formatLastUsed(ts: string | null, timezone: string): string {
  if (!ts) return "—";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(ts));
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

function useSkillI18n() {
  const { t } = useTranslation();
  return {
    name: (s: AgentSkillSummary) => {
      const key = `skill.${s.id}.name` as any;
      const translated = t(key);
      return translated !== key ? translated : (s.displayName || s.name);
    },
    desc: (s: AgentSkillSummary) => {
      const key = `skill.${s.id}.desc` as any;
      const translated = t(key);
      return translated !== key ? translated : s.description;
    },
    triggers: (s: AgentSkillSummary) => {
      const key = `skill.${s.id}.triggers` as any;
      const translated = t(key);
      if (s.type === "builtin" && translated !== key) return translated;
      const visible = s.triggers.slice(0, 4).join(", ");
      return `${visible}${s.triggers.length > 4 ? ` +${s.triggers.length - 4}` : ""}`;
    },
    triggerTitle: (s: AgentSkillSummary) => {
      const key = `skill.${s.id}.triggers` as any;
      const translated = t(key);
      if (s.type === "builtin" && translated !== key) return translated;
      return s.triggers.join(", ");
    },
  };
}

export default function SkillsTab({ agentId, blockId }: Props) {
  const { t } = useTranslation();
  const { name: localName, desc: localDesc, triggers: localTriggers, triggerTitle: localTriggerTitle } = useSkillI18n();
  const { preferences } = useAuth();
  const { workspaceId } = useWorkspace();
  const timezone = preferences.timezone ?? "Asia/Shanghai";
  const { addBlock, patchBlockState } = useCanvas();
  const toast = useToast();
  const [skills, setSkills] = useState<AgentSkillSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const loadSkills = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    try {
      const data = await listAgentSkills(agentId, workspaceId);
      setSkills(data.skills);
    } catch {
      setSkills([]);
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [agentId, workspaceId]);

  useEffect(() => {
    void loadSkills(true);
  }, [loadSkills]);

  const refreshSkills = useCallback(() => {
    void loadSkills(false);
  }, [loadSkills]);

  useAgentHomeRefresh(agentId, refreshSkills);

  const handleToggle = useCallback(async (skillId: string, enabled: boolean) => {
    setSkills((prev) =>
      prev.map((s) => (s.id === skillId ? { ...s, enabled } : s)),
    );
    try {
      await toggleAgentSkill(agentId, skillId, enabled, workspaceId);
      toast.success(enabled ? t("agent.toast.skillEnabled") : t("agent.toast.skillDisabled"));
    } catch {
      setSkills((prev) =>
        prev.map((s) => (s.id === skillId ? { ...s, enabled: !enabled } : s)),
      );
      toast.error(t("agent.toast.toggleFailed"));
    }
  }, [agentId, workspaceId, toast, t]);

  const handleDeleteSkill = useCallback(async (skillId: string) => {
    const prev = skills;
    setSkills((s) => s.filter((x) => x.id !== skillId));
    try {
      await deleteUserSkill(agentId, skillId, workspaceId);
      toast.success(t("agent.toast.skillDeleted"));
    } catch {
      setSkills(prev);
      toast.error(t("agent.toast.deleteFailed"));
    }
  }, [agentId, skills, workspaceId, toast, t]);

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
        <div key={s.id} className="ab-card">
          <div className="ab-card-head">
            <div className="ab-card-title-block">
              <div className="ab-card-title-row">
                <Tooltip title={localName(s)}><h4 className="ab-card-title">{localName(s)}</h4></Tooltip>
                <span className={`ab-card-state ${s.type === "builtin" ? "ab-card-state-primary" : "ab-card-state-muted"}`}>
                  {s.type === "builtin" ? t("agent.card.official") : t("agent.card.custom")}
                </span>
              </div>
              {localDesc(s) && <Tooltip title={localDesc(s)}><p className="ab-card-desc">{localDesc(s)}</p></Tooltip>}
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
                <Tooltip title={localTriggerTitle(s)}><dd>{localTriggers(s)}</dd></Tooltip>
              </div>
            )}
            <div className="ab-card-kv-row">
              <dt>{t("agent.card.lastUsed")}</dt>
              <dd>{formatLastUsed(s.lastUsed, timezone)}</dd>
            </div>
          </dl>
        </div>
      ))}
    </CardGrid>
      )}
    </div>
  );
}
