/**
 * HabitsTab — displays agent's scheduled habits (cron jobs).
 * System habits have a "system" badge; user habits have "custom".
 * All habits have an enabled toggle.
 */

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../auth/AuthContext";
import { useCanvas } from "../../contexts/canvasContext";
import { useWorkspace } from "../../contexts/workspaceContext";
import type { SystemBlockState } from "../../canvas/types";
import { createConversation, listHabits, toggleHabit, deleteHabit, type HabitSummary } from "../../api";
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

const ADD_HABIT_PROMPT = `我想添加一个新的定时习惯（Habit）。请引导我配置完后用 schedule_task 工具登记。

需要从我这里收集 4 件事:
1. **标题（displayName）**:Habits tab 卡片上显示的短标题,≤12 字。例如"每周表结构复盘" / "月度记忆清理"。
2. **执行频率（schedule）**:每天 / 每周几 / 每月几号几点。你要把它转成 cron 表达式(5 字段或 @daily 等别名)。
3. **具体任务（prompt）**:到期那一刻你自己将读到的完整指令,写得像给自己留的便签。
4. **激活技能（skills,可选）**:执行时要不要带 table-skill / analyst-skill 之类的。

收集完后再:
- 帮我合成一句卡片小字说明（description,≤30 字,概述这条 habit 在做什么 + 什么时候执行,例如"每周五下午 17:00 — 总结这周表结构变化"）。
- 调 schedule_task 工具,**displayName + description 两个字段一定要传**(否则 UI 卡片会把整段 prompt 灌进标题,体验极差)。

请一步步引导我,问完就直接登记,不用再确认一遍。`;

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

function formatLastUsed(ts: string | null | undefined, timezone: string): string {
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

/** Derive a short display title from a long prompt. Custom habits created
 *  via the schedule_task MCP tool only carry `prompt` (no displayName/desc),
 *  so we used to dump the full prompt as the card title — it overflowed and
 *  pushed the system/custom badge to the next line.
 *  Strategy: take the first sentence (split on common terminators) and clip
 *  to ~24 chars; if first line is itself short enough use it as-is. */
function deriveShortTitle(prompt: string): string {
  const trimmed = prompt.trim().replace(/\s+/g, " ");
  if (!trimmed) return "Custom habit";
  // First sentence — split on Chinese / English terminators or newline
  const firstSentence = trimmed.split(/[。!?;\n.!?]/)[0] ?? trimmed;
  const candidate = firstSentence.trim() || trimmed;
  const chars = Array.from(candidate); // CJK-safe length
  if (chars.length <= 24) return candidate;
  return chars.slice(0, 24).join("") + "…";
}

function useHabitI18n() {
  const { t } = useTranslation();
  return {
    name: (h: HabitSummary) => {
      const key = `habit.${h.id}.name` as any;
      const translated = t(key);
      if (translated !== key) return translated;
      // System habits without i18n key still have displayName from seed.
      if (h.displayName) return h.displayName;
      // Custom habits: derive a short title from prompt (full prompt
      // shows up in description below).
      return deriveShortTitle(h.prompt);
    },
    desc: (h: HabitSummary) => {
      const key = `habit.${h.id}.desc` as any;
      const translated = t(key);
      if (translated !== key) return translated;
      // Custom habits don't carry a separate description field — fall back
      // to the full prompt so the user can see what the habit actually does
      // (truncated by .ab-card-desc CSS to one line + ellipsis,Tooltip on
      // hover shows the full text).
      return h.description || h.prompt;
    },
  };
}

export default function HabitsTab({ agentId, blockId }: Props) {
  const { t } = useTranslation();
  const { name: localName, desc: localDesc } = useHabitI18n();
  const { preferences } = useAuth();
  const { workspaceId } = useWorkspace();
  const timezone = preferences.timezone ?? "Asia/Shanghai";
  const { addBlock, patchBlockState } = useCanvas();
  const toast = useToast();
  const [habits, setHabits] = useState<HabitSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const loadHabits = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    try {
      const data = await listHabits(agentId, workspaceId);
      setHabits(data.habits);
    } catch {
      setHabits([]);
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [agentId, workspaceId]);

  useEffect(() => {
    void loadHabits(true);
  }, [loadHabits]);

  const refreshHabits = useCallback(() => {
    void loadHabits(false);
  }, [loadHabits]);

  useAgentHomeRefresh(agentId, refreshHabits);

  const handleToggle = useCallback(async (jobId: string, enabled: boolean) => {
    setHabits((prev) =>
      prev.map((h) => (h.id === jobId ? { ...h, enabled } : h)),
    );
    try {
      await toggleHabit(agentId, jobId, enabled, workspaceId);
      toast.success(enabled ? t("agent.toast.habitEnabled") : t("agent.toast.habitDisabled"));
    } catch {
      setHabits((prev) =>
        prev.map((h) => (h.id === jobId ? { ...h, enabled: !enabled } : h)),
      );
      toast.error(t("agent.toast.toggleFailed"));
    }
  }, [agentId, workspaceId, toast, t]);

  const handleDeleteHabit = useCallback(async (jobId: string) => {
    const prev = habits;
    setHabits((h) => h.filter((x) => x.id !== jobId));
    try {
      await deleteHabit(agentId, jobId);
      toast.success(t("agent.toast.habitDeleted"));
    } catch {
      setHabits(prev);
      toast.error(t("agent.toast.deleteFailed"));
    }
  }, [agentId, habits, toast, t]);

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
                  <dd>{formatLastUsed(h.lastFiredAt, timezone)}</dd>
                </div>
              </dl>
            </div>
          ))}
        </CardGrid>
      )}
    </div>
  );
}
