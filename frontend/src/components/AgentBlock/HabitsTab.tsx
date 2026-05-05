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
import { useToast } from "../Toast/index";
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
  // Aliases
  if (schedule.startsWith("@daily")) return "每天 00:00";
  if (schedule.startsWith("@hourly")) return "每小时";
  if (schedule.startsWith("@weekly")) return "每周一 00:00";
  if (schedule.startsWith("@monthly")) return "每月 1 日 00:00";
  if (schedule.startsWith("@yearly")) return "每年 1 月 1 日 00:00";

  // Parse 5-field: minute hour dom month dow
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return schedule;
  const [min, hour, dom, mon, dow] = parts;

  const allStar = (v: string) => v === "*";
  const pad2 = (v: string) => v.padStart(2, "0");

  // "N N * * *" → 每天 HH:MM
  if (!allStar(min) && !allStar(hour) && allStar(dom) && allStar(mon) && allStar(dow)) {
    return `每天 ${pad2(hour)}:${pad2(min)}`;
  }
  // "N N * * N" → 每周X HH:MM
  if (!allStar(min) && !allStar(hour) && allStar(dom) && allStar(mon) && !allStar(dow)) {
    const dayNames = ["日", "一", "二", "三", "四", "五", "六"];
    const dayName = dayNames[Number(dow)] ?? dow;
    return `每周${dayName} ${pad2(hour)}:${pad2(min)}`;
  }
  // "N N N * *" → 每月 Nd HH:MM
  if (!allStar(min) && !allStar(hour) && !allStar(dom) && allStar(mon) && allStar(dow)) {
    return `每月 ${dom} 日 ${pad2(hour)}:${pad2(min)}`;
  }
  // "*/N * * * *" → 每 N 分钟
  if (min.startsWith("*/") && allStar(hour) && allStar(dom) && allStar(mon) && allStar(dow)) {
    return `每 ${min.slice(2)} 分钟`;
  }
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

function useHabitI18n() {
  const { t } = useTranslation();
  return {
    name: (h: HabitSummary) => {
      const key = `habit.${h.id}.name` as any;
      const translated = t(key);
      return translated !== key ? translated : (h.displayName || h.prompt);
    },
    desc: (h: HabitSummary) => {
      const key = `habit.${h.id}.desc` as any;
      const translated = t(key);
      return translated !== key ? translated : h.description;
    },
  };
}

export default function HabitsTab({ agentId, blockId }: Props) {
  const { t } = useTranslation();
  const { name: localName, desc: localDesc } = useHabitI18n();
  const { workspaceId } = useAuth();
  const { addBlock, patchBlockState } = useCanvas();
  const toast = useToast();
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
      toast.success(enabled ? t("agent.toast.habitEnabled") : t("agent.toast.habitDisabled"));
    } catch {
      setHabits((prev) =>
        prev.map((h) => (h.id === jobId ? { ...h, enabled: !enabled } : h)),
      );
      toast.error(t("agent.toast.toggleFailed"));
    }
  }, [agentId, toast, t]);

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
                    <Tooltip title={localName(h)}>
                      <h4 className="ab-card-title">{localName(h)}</h4>
                    </Tooltip>
                    <span className={`ab-card-state ${h.type === "system" ? "ab-card-state-primary" : "ab-card-state-muted"}`}>
                      {h.type === "system" ? t("agent.card.official") : t("agent.card.custom")}
                    </span>
                  </div>
                  {localDesc(h) && (
                    <Tooltip title={localDesc(h)}>
                      <p className="ab-card-desc">{localDesc(h)}</p>
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
