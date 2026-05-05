/**
 * HabitsTab — displays agent's scheduled habits (cron jobs).
 * System habits have a "system" badge; user habits have "custom".
 * All habits have an enabled toggle.
 */

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../auth/AuthContext";
import { useCanvas } from "../../contexts/canvasContext";
import type { SystemBlockState } from "../../canvas/types";
import { createConversation, listHabits, toggleHabit, type HabitSummary } from "../../api";
import { useTranslation } from "../../i18n";
import Tooltip from "../Tooltip";
import CardGrid from "./CardGrid";
import CardMoreMenu from "./CardMoreMenu";

interface Props {
  agentId: string;
  blockId: string;
}

const ADD_HABIT_PROMPT = `我想添加一个新的定时习惯（Habit）。请引导我完成配置：
1. 习惯名称（如"每周总结"）
2. 执行频率（如每天/每周几/每月几号，几点执行）
3. 具体要做的事情（Agent 执行时的指令）
4. 需要激活的技能（可选）

请一步步引导我。`;

function cronToHuman(schedule: string): string {
  if (schedule === "0 2 * * *") return "每天 02:00";
  if (schedule === "0 3 * * *") return "每天 03:00";
  if (schedule === "0 8 * * *") return "每天 08:00";
  if (schedule.startsWith("@daily")) return "每天";
  if (schedule.startsWith("@hourly")) return "每小时";
  if (schedule.startsWith("@weekly")) return "每周";
  return schedule;
}

function timeAgo(ts: string | null | undefined): string {
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

export default function HabitsTab({ agentId, blockId }: Props) {
  const { t } = useTranslation();
  const { workspaceId } = useAuth();
  const { addBlock, patchBlockState } = useCanvas();
  const [habits, setHabits] = useState<HabitSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listHabits(agentId)
      .then((data) => setHabits(data.habits))
      .catch(() => setHabits([]))
      .finally(() => setLoading(false));
  }, [agentId]);

  const handleToggle = useCallback(async (jobId: string, enabled: boolean) => {
    setHabits((prev) =>
      prev.map((h) => (h.id === jobId ? { ...h, enabled } : h)),
    );
    try {
      await toggleHabit(agentId, jobId, enabled);
    } catch {
      setHabits((prev) =>
        prev.map((h) => (h.id === jobId ? { ...h, enabled: !enabled } : h)),
      );
    }
  }, [agentId]);

  const handleDeleteHabit = useCallback(async (jobId: string) => {
    setHabits((prev) => prev.filter((h) => h.id !== jobId));
    // TODO: call backend delete API (removeCronJob)
  }, []);

  const handleAddHabit = async () => {
    if (!workspaceId) return;
    try {
      const conv = await createConversation(workspaceId, agentId || undefined);
      addBlock("chat", { conversationId: conv.id, prefillMessage: ADD_HABIT_PROMPT } as any);
    } catch {
      addBlock("chat");
    }
  };

  if (loading) return <div className="ab-loading">{t("agent.block.loading")}</div>;

  return (
    <div>
      <div className="ab-toolbar">
        <button className="ab-toolbar-btn" onClick={handleAddHabit}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M7 2v10M2 7h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          {t("agent.habits.addByChat")}
        </button>
      </div>

      {habits.length === 0 ? (
        <div className="ab-empty">{t("agent.block.noHabits")}</div>
      ) : (
        <CardGrid>
          {habits.map((h) => (
            <div key={h.id} className="ab-card">
              <div className="ab-card-head">
                <div className="ab-card-title-block">
                  <div className="ab-card-title-row">
                    <Tooltip title={h.displayName || h.prompt}>
                      <h4 className="ab-card-title">{h.displayName || h.prompt}</h4>
                    </Tooltip>
                    <span className={`ab-card-state ${h.type === "system" ? "ab-card-state-primary" : "ab-card-state-muted"}`}>
                      {h.type === "system" ? t("agent.card.official") : t("agent.card.custom")}
                    </span>
                  </div>
                  {h.description && (
                    <Tooltip title={h.description}>
                      <p className="ab-card-desc">{h.description}</p>
                    </Tooltip>
                  )}
                </div>
                <div className="ab-card-controls">
                  <button
                    className={`ab-switch${h.enabled ? " ab-switch-on" : ""}`}
                    onClick={() => handleToggle(h.id, !h.enabled)}
                    aria-label="Toggle"
                  >
                    <span className="ab-switch-knob" />
                  </button>
                  <CardMoreMenu
                    onViewActivities={() => patchBlockState(blockId, { activeTab: "activities", activitiesSearch: h.id } as SystemBlockState)}
                    label={t("agent.activities.viewActivities")}
                    onDelete={h.type !== "system" ? () => handleDeleteHabit(h.id) : undefined}
                  />
                </div>
              </div>
              <dl className="ab-card-kv">
                <div className="ab-card-kv-row">
                  <dt>{t("agent.habits.schedule")}</dt>
                  <dd>{cronToHuman(h.schedule)}</dd>
                </div>
                <div className="ab-card-kv-row">
                  <dt>{t("agent.card.lastUsed")}</dt>
                  <dd>{timeAgo(h.lastFiredAt)}</dd>
                </div>
              </dl>
            </div>
          ))}
        </CardGrid>
      )}
    </div>
  );
}
