/**
 * AgencyBlock — High Agency Mode 的 Magic Canvas Block
 *
 * 用户给定 Goal + Todos，双 Agent 自动驾驶完成目标。
 * 包含: TopBar(goal名/chaos monkey/checkpoints) + 左侧路线面板 + 右侧执行时间线
 */

import { useState, useEffect, useRef, useCallback, useMemo, Fragment, type ChangeEvent } from "react";
import { useCanvas } from "../../contexts/canvasContext";
import { useBlockShell } from "../../contexts/blockShellContext";
import { useAuth } from "../../auth/AuthContext";
import { type AgentMeta, getAgent, renameAgent, uploadAgentAvatar, fetchGoalSuggestions, type GoalSuggestion } from "../../api";
import { useTranslation } from "../../i18n";
import InlineEdit from "../InlineEdit";
import AvatarCropDialog from "../../auth/AvatarCropDialog";
import ChatModelPicker from "../ChatSidebar/ChatModelPicker";
import type { AgencyBlockState } from "../../canvas/types";
import { useWorkspace } from "../../contexts/workspaceContext";
import aiIconColorful from "../../assets/icon_ai-common_colorful.svg?url";
import "./AgencyBlock.css";

// ─── Icon component + ICONS ─────────────────────────────────────────────────

interface IconProps {
  d: string | React.ReactNode;
  size?: number;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  className?: string;
}

function Icon({ d, size = 14, fill = "none", stroke = "currentColor", strokeWidth = 1.5, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill={fill} className={className}>
      {typeof d === "string" ? (
        <path d={d} stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        d
      )}
    </svg>
  );
}

const ICONS = {
  star4: "M8 1.5 L9.4 6.6 L14.5 8 L9.4 9.4 L8 14.5 L6.6 9.4 L1.5 8 L6.6 6.6 Z",
  checkpoint: "M3 5.5 A2.5 2.5 0 0 1 5.5 3 H10.5 A2.5 2.5 0 0 1 13 5.5 V11 L8 13.5 L3 11 Z",
  minimize: "M3 8 H13",
  plus: "M8 3 V13 M3 8 H13",
  close: "M4 4 L12 12 M12 4 L4 12",
  check: "M3.5 8 L6.5 11 L12.5 5",
  pin: "M8 1.5 C5.5 1.5 4 3.4 4 5.5 C4 8 8 13 8 13 C8 13 12 8 12 5.5 C12 3.4 10.5 1.5 8 1.5 Z M8 5.5 A1.2 1.2 0 0 1 8 5.51",
  targetCircle: (
    <g>
      <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.5" fill="none" />
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.5" fill="none" />
    </g>
  ),
  dot: <circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.5" fill="none" />,
  monkey: (
    <g>
      <circle cx="8" cy="8.5" r="5" stroke="currentColor" strokeWidth="1.4" fill="none" />
      <circle cx="4.5" cy="6.5" r="1.5" stroke="currentColor" strokeWidth="1.2" fill="none" />
      <circle cx="11.5" cy="6.5" r="1.5" stroke="currentColor" strokeWidth="1.2" fill="none" />
      <circle cx="6.4" cy="8" r="0.5" fill="currentColor" />
      <circle cx="9.6" cy="8" r="0.5" fill="currentColor" />
      <path d="M6 11 Q8 12 10 11" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" />
    </g>
  ),
  play: (
    <path d="M5 3 V13 L13 8 Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" fill="currentColor" fillOpacity="0.15" />
  ),
  doc: "M4 2 H10 L12 4 V14 H4 Z M10 2 V4 H12 M6 7 H10 M6 9.5 H10 M6 12 H8.5",
};

// ─── Types ───────────────────────────────────────────────────────────────────

interface Props {
  blockId: string;
}

interface AgencyEvent {
  type: string;
  data: Record<string, unknown>;
}

interface Milestone {
  id: string;
  title: string;
  status: string;
  retryCount: number;
  segmentIndex: number;
  milestoneIndex: number;
}

type SessionStatus = "idle" | "planning" | "executing" | "validating" | "replanning" | "completed" | "cancelled";

// ─── Sub-components ──────────────────────────────────────────────────────────

/** Chaos Monkey popover */
function ChaosPopover({ isValidating, onClose }: { isValidating: boolean; onClose: () => void }) {
  return (
    <div className="ha-chaos-popover" onClick={(e) => e.stopPropagation()}>
      <div className="ha-chaos-id">
        <div className="ha-chaos-avatar-lg">
          <Icon d={ICONS.monkey} size={20} />
        </div>
        <div className="ha-chaos-id-txt">
          <div className="ha-chaos-name">
            chaos_monkey
            <span className={`ha-chaos-status ${isValidating ? "is-on" : "is-idle"}`}>
              {isValidating ? "\u25CF validating" : "\u25CB idle"}
            </span>
          </div>
          <div className="ha-chaos-role">adversarial validator &middot; v0.4</div>
        </div>
      </div>
      <div className="ha-chaos-config">
        <div className="ha-chaos-row">
          <span className="ha-cli-mono-key">sensitivity</span>
          <span className="ha-cli-mono-eq">=</span>
          <span className="ha-cli-mono-val">strict</span>
          <span className="ha-cli-mono-hint">(retry on any criterion fail)</span>
        </div>
        <div className="ha-chaos-row">
          <span className="ha-cli-mono-key">criteria_src</span>
          <span className="ha-cli-mono-eq">=</span>
          <span className="ha-cli-mono-val">auto + goal-derived</span>
        </div>
        <div className="ha-chaos-row">
          <span className="ha-cli-mono-key">retry_budget</span>
          <span className="ha-cli-mono-eq">=</span>
          <span className="ha-cli-mono-val">3 / step</span>
        </div>
        <div className="ha-chaos-row">
          <span className="ha-cli-mono-key">history</span>
          <span className="ha-cli-mono-eq">=</span>
          <span className="ha-cli-mono-val">0 approved &middot; 0 retry</span>
        </div>
      </div>
      <div className="ha-chaos-foot">
        Chaos Monkey gates each milestone before checkpointing.
      </div>
    </div>
  );
}

/** Sigil — leading status character */
function Sigil({ status }: { status: string }) {
  const map: Record<string, { ch: string; cls: string }> = {
    pending: { ch: "\u25A1", cls: "ha-sigil-muted" },
    running: { ch: "\u25CF", cls: "ha-sigil-accent ha-sigil-pulse" },
    passed: { ch: "\u2713", cls: "ha-sigil-accent" },
    failed: { ch: "\u2717", cls: "ha-sigil-danger" },
    retrying: { ch: "\u21BB", cls: "ha-sigil-warning" },
    thinking: { ch: "\u2026", cls: "ha-sigil-accent" },
    approved: { ch: "\u2713", cls: "ha-sigil-accent" },
    retry: { ch: "\u21BB", cls: "ha-sigil-warning" },
    checking: { ch: "?", cls: "ha-sigil-muted" },
    plan: { ch: "\u25B8", cls: "ha-sigil-accent" },
    save: { ch: "\u25C6", cls: "ha-sigil-accent" },
    done: { ch: "\u2605", cls: "ha-sigil-accent" },
  };
  const m = map[status] || { ch: "\u00B7", cls: "ha-sigil-muted" };
  return <span className={`ha-cli-sigil ${m.cls}`}>{m.ch}</span>;
}

/** CliBlock — collapsible block in the feed */
function CliBlock({
  status,
  time,
  label,
  meta,
  defaultOpen = false,
  children,
  expandable = true,
}: {
  status: string;
  time?: string;
  label: React.ReactNode;
  meta?: string | null;
  defaultOpen?: boolean;
  children?: React.ReactNode;
  expandable?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const hasBody = !!children && expandable;

  return (
    <div className={`ha-cli-block ${open ? "is-open" : ""} ${hasBody ? "is-expandable" : ""}`}>
      <div
        className="ha-cli-row ha-cli-row-head"
        role={hasBody ? "button" : undefined}
        onClick={hasBody ? () => setOpen(!open) : undefined}
      >
        <span className="ha-cli-chev">{hasBody ? (open ? "\u25BE" : "\u25B8") : " "}</span>
        <Sigil status={status} />
        {time && <span className="ha-cli-time">{time}</span>}
        <span className="ha-cli-label">{label}</span>
        {meta && <span className="ha-cli-meta">{meta}</span>}
      </div>
      {open && hasBody && <div className="ha-cli-body">{children}</div>}
    </div>
  );
}

/** CliLine — a child line under a CliBlock */
function CliLine({ children, kind = "default", isLast = false }: { children: React.ReactNode; kind?: string; isLast?: boolean }) {
  return (
    <div className={`ha-cli-row ha-cli-line ha-cli-line-${kind}`}>
      <span className="ha-cli-branch">{isLast ? "\u2514\u2500" : "\u251C\u2500"}</span>
      <span className="ha-cli-line-text">{children}</span>
    </div>
  );
}

/** PlanningCard — roadmap planned event */
function PlanningCard({ goal, milestones, status }: { goal: string; milestones: string[]; status: "thinking" | "ready" }) {
  const isReady = status === "ready";
  const sigilStatus = isReady ? "plan" : "thinking";
  const label = isReady ? "Roadmap ready" : "Planning roadmap\u2026";
  const meta = isReady ? `${milestones.length} steps` : null;

  return (
    <CliBlock status={sigilStatus} time="00:00" label={label} meta={meta} defaultOpen expandable={isReady}>
      {isReady &&
        milestones.map((m, i) => (
          <CliLine key={i} kind="step" isLast={i === milestones.length - 1}>
            <span className="ha-cli-step-num">{String(i + 1).padStart(2, "0")}</span>
            <span className="ha-cli-step-text">{m}</span>
          </CliLine>
        ))}
    </CliBlock>
  );
}

/** MilestoneCard — milestone event */
function MilestoneCard({
  idx,
  title,
  status,
  log,
  duration,
  tokens,
  defaultOpen,
}: {
  idx: number;
  title: string;
  status: string;
  log: { t: string; kind: string; text: string }[];
  duration?: string;
  tokens?: string;
  defaultOpen?: boolean;
}) {
  const meta =
    (status === "passed" || status === "failed") && (duration || tokens)
      ? [duration, tokens && `${tokens} tok`].filter(Boolean).join(" \u00B7 ")
      : null;
  const label = (
    <>
      <span className="ha-cli-num">[{String(idx).padStart(2, "0")}]</span>{" "}
      <span>{title}</span>
    </>
  );

  return (
    <CliBlock status={status} time={`00:${String(idx * 30 + 12).padStart(2, "0")}`} label={label} meta={meta} defaultOpen={defaultOpen ?? false}>
      {log.map((line, i) => (
        <CliLine key={i} kind={`log-${line.kind}`} isLast={i === log.length - 1}>
          <span className="ha-cli-log-time">{line.t}</span>
          <span className="ha-cli-log-text">{line.text}</span>
        </CliLine>
      ))}
    </CliBlock>
  );
}

/** ValidationCard — Chaos Monkey verdict */
function ValidationCard({
  verdict,
  criteria,
  reason,
  nextAction,
  defaultOpen,
}: {
  verdict: "approved" | "retry" | "checking";
  criteria: { ok: boolean; text: string }[];
  reason?: string;
  nextAction?: string;
  defaultOpen?: boolean;
}) {
  const titleMap: Record<string, string> = {
    approved: "validate \u00B7 approved",
    retry: "validate \u00B7 retry needed",
    checking: "validate \u00B7 checking\u2026",
  };
  const passCount = criteria.filter((c) => c.ok).length;
  const totalCount = criteria.length;
  const conf = verdict === "approved" ? 0.94 : verdict === "retry" ? 0.62 : null;

  const items: { key: string; kind: string; node: React.ReactNode }[] = [];

  if (verdict !== "checking") {
    items.push({
      key: "sig",
      kind: "signature",
      node: (
        <>
          <span className="ha-cli-mono-key">agent</span>
          <span className="ha-cli-mono-eq">=</span>
          <span className="ha-cli-mono-val">chaos_monkey@v0.4</span>
          <span className="ha-cli-mono-sep">&middot;</span>
          <span className="ha-cli-mono-key">conf</span>
          <span className="ha-cli-mono-eq">=</span>
          <span className={`ha-cli-mono-val ${conf !== null && conf >= 0.8 ? "is-good" : conf !== null && conf >= 0.5 ? "is-warn" : "is-bad"}`}>
            {conf?.toFixed(2)}
          </span>
        </>
      ),
    });
  }

  criteria.forEach((c, i) => {
    items.push({
      key: `crit-${i}`,
      kind: `crit-${c.ok ? "ok" : "fail"}`,
      node: (
        <>
          <span className={`ha-cli-mark ${c.ok ? "is-ok" : "is-fail"}`}>{c.ok ? "\u2713" : "\u2717"}</span>
          <span>{c.text}</span>
        </>
      ),
    });
  });

  if (reason) {
    items.push({
      key: "why",
      kind: "reason",
      node: (
        <>
          <span className="ha-cli-mono-key">why</span>
          <span className="ha-cli-mono-arrow">&rsaquo;</span>
          <span className="ha-cli-line-text">{reason}</span>
        </>
      ),
    });
  }

  if (verdict !== "checking") {
    items.push({
      key: "next",
      kind: verdict === "retry" ? "next-retry" : "next-ok",
      node: (
        <>
          <span className="ha-cli-mono-key">next</span>
          <span className="ha-cli-mono-arrow">&rsaquo;</span>
          <span className="ha-cli-line-text">
            {verdict === "retry" ? (nextAction || "retry step with adjusted params") : "proceed to next milestone"}
          </span>
        </>
      ),
    });
  }

  return (
    <CliBlock
      status={verdict}
      time="01:42"
      label={titleMap[verdict]}
      meta={verdict !== "checking" ? `chaos_monkey \u00B7 ${passCount}/${totalCount}` : undefined}
      defaultOpen={defaultOpen ?? verdict === "retry"}
    >
      {items.map((it, i) => (
        <CliLine key={it.key} kind={it.kind} isLast={i === items.length - 1}>
          {it.node}
        </CliLine>
      ))}
    </CliBlock>
  );
}

/** CheckpointChips — checkpoint/artifact saved event */
function CheckpointChips({ items }: { items: { name: string }[] }) {
  return (
    <CliBlock status="save" label="checkpoint saved" meta={`${items.length} ${items.length === 1 ? "artifact" : "artifacts"}`} defaultOpen={false}>
      {items.map((c, i) => (
        <CliLine key={i} kind="artifact" isLast={i === items.length - 1}>
          <span className="ha-cli-art-name">{c.name}</span>
        </CliLine>
      ))}
    </CliBlock>
  );
}

/** GoalEmpty — quiet CLI banner before run starts */
function GoalEmpty() {
  return (
    <div className="ha-cli-empty">
      <div className="ha-cli-empty-row">
        <span className="ha-cli-prompt">$</span>
        <span className="ha-cli-empty-cursor" />
      </div>
      <div className="ha-cli-empty-hint">
        Press <b>Start run</b> on the left to plan a route. The agent's progress will stream here.
      </div>
      <div className="ha-cli-empty-stages">
        <span className="ha-cli-empty-stage"><span className="ha-cli-empty-stage-num">1</span> plan</span>
        <span className="ha-cli-empty-stage-arrow">&rarr;</span>
        <span className="ha-cli-empty-stage"><span className="ha-cli-empty-stage-num">2</span> execute</span>
        <span className="ha-cli-empty-stage-arrow">&rarr;</span>
        <span className="ha-cli-empty-stage"><span className="ha-cli-empty-stage-num">3</span> validate</span>
      </div>
    </div>
  );
}

/** GoalDone — completion banner */
function GoalDone({ artifacts, duration, tokens }: { artifacts: number; duration: string; tokens: string }) {
  return (
    <CliBlock
      status="done"
      label="goal achieved"
      meta={`${artifacts} artifacts \u00B7 ${duration} \u00B7 ${tokens} tok`}
      defaultOpen={false}
      expandable={false}
    />
  );
}

/** RoutePlannerPopover — full setup form (idle state) */
function RoutePlannerPopover({
  goal,
  setGoal,
  todos,
  setTodos,
  onStart,
  onMidFlightEdit,
  isRunning,
  sessionId,
}: {
  goal: string;
  setGoal: (v: string) => void;
  todos: string[];
  setTodos: (v: string[]) => void;
  onStart: () => void;
  onMidFlightEdit: (patch: { goal?: string; todos?: string[] }) => void;
  isRunning: boolean;
  sessionId?: string;
}) {
  const addTodo = () => setTodos([...todos, ""]);
  const deleteTodo = (i: number) => {
    const next = todos.filter((_, j) => j !== i);
    setTodos(next);
    if (isRunning && sessionId) {
      onMidFlightEdit({ todos: next.filter((t) => t.trim()) });
    }
  };
  const updateTodo = (i: number, text: string) => {
    const next = [...todos];
    next[i] = text;
    setTodos(next);
  };

  return (
    <div className="ha-rp ha-rp-popover">
      <div className="ha-rp-pop">
        {/* From */}
        <div className="ha-rp-pop-from-row">
          <span className="ha-rp-pop-marker ha-rp-pop-marker-from" />
          <span className="ha-rp-pop-from-txt">Now</span>
        </div>

        {/* Steps */}
        <div className="ha-rp-pop-steps">
          {todos.map((td, i) => (
            <div className="ha-rp-pop-step" key={i}>
              <span className="ha-rp-pop-marker ha-rp-pop-marker-step" />
              <input
                type="text"
                className="ha-rp-pop-step-input"
                value={td}
                onChange={(e) => updateTodo(i, e.target.value)}
                onBlur={() => {
                  if (isRunning && sessionId) {
                    onMidFlightEdit({ todos: todos.filter((t) => t.trim()) });
                  }
                }}
                placeholder={`Step ${i + 1}`}
              />
              <button className="ha-rp-pop-del" onClick={() => deleteTodo(i)} aria-label="delete">
                <Icon d={ICONS.close} size={10} />
              </button>
            </div>
          ))}

          <button className="ha-rp-pop-add" onClick={addTodo}>
            <Icon d={ICONS.plus} size={10} />
            <span>Add step</span>
          </button>
        </div>

        {/* Goal */}
        <div className="ha-rp-pop-goal-row">
          <span className="ha-rp-pop-marker ha-rp-pop-marker-to" />
          <textarea
            className="ha-rp-pop-goal"
            rows={2}
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !isRunning) { e.preventDefault(); onStart(); } }}
            onBlur={() => {
              if (isRunning && sessionId) {
                onMidFlightEdit({ goal: goal.trim() });
              }
            }}
            placeholder="What's the desired outcome?"
          />
        </div>

        {/* Start button */}
        {!isRunning && goal.trim() && (
          <button className="ha-rp-pop-start" onClick={onStart}>
            <Icon d={ICONS.play} size={10} />
            Start run
          </button>
        )}

        <div className="ha-rp-pop-tail" />
      </div>

      <div className="ha-rp-cta">
        <Icon d={ICONS.plus} size={11} />
        <span>Plan a route</span>
      </div>
    </div>
  );
}

/** RoutePlannerMini — narrow progress bar (running state) */
function RoutePlannerMini({
  milestones,
  currentMilestoneId,
  status,
  onExpand,
}: {
  milestones: Milestone[];
  currentMilestoneId: string | null;
  status: SessionStatus;
  onExpand: () => void;
}) {
  const total = milestones.length + 2; // from + milestones + goal
  const currentIdx = currentMilestoneId ? milestones.findIndex((m) => m.id === currentMilestoneId) : -1;
  const agentProg =
    status === "completed" ? 100
    : status === "idle" || status === "planning" ? 0
    : ((Math.max(0, currentIdx) + 1) / (total - 1)) * 100;

  const positions = milestones.map((_, i) => ((i + 1) / (total - 1)) * 100);

  return (
    <div className="ha-rp ha-rp-mini" onClick={onExpand}>
      <div className="ha-rp-mini-head"><Icon d={ICONS.pin} size={10} /></div>
      <div className="ha-rp-mini-bar">
        <div className="ha-rp-mini-bar-bg" />
        <div className="ha-rp-mini-bar-fill" style={{ height: `${agentProg}%` }} />
        {positions.map((p, i) => {
          const passed = currentIdx > i;
          const active = currentIdx === i;
          return (
            <div
              key={i}
              className={`ha-rp-mini-node ${passed ? "is-passed" : ""} ${active ? "is-active" : ""}`}
              style={{ top: `${p}%` }}
              title={milestones[i]?.title}
            />
          );
        })}
        {status !== "idle" && status !== "completed" && (
          <div className="ha-rp-mini-agent" style={{ top: `${agentProg}%` }}>
            <Icon d={ICONS.star4} size={10} />
          </div>
        )}
      </div>
      <div className="ha-rp-mini-foot"><Icon d={ICONS.targetCircle} size={10} /></div>
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────

const FALLBACK_AVATAR = "/avatars/avatar_1.png";

export default function AgencyBlock({ blockId }: Props) {
  const { state, patchBlockState, scheduleSave } = useCanvas();
  const shellCtx = useBlockShell();
  const { agentId } = useAuth();
  const { t } = useTranslation();
  const blockState = (state.blockStates[blockId] ?? {}) as AgencyBlockState;

  // Agent hero state
  const [agent, setAgent] = useState<AgentMeta | null>(null);
  const [nameEditing, setNameEditing] = useState(false);
  const [cropSource, setCropSource] = useState<string | null>(null);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const avatarFileRef = useRef<HTMLInputElement>(null);
  const resolvedAgentId = agentId || "agent_default";

  useEffect(() => {
    if (!resolvedAgentId) return;
    getAgent(resolvedAgentId).then(setAgent).catch(() => {});
  }, [resolvedAgentId]);

  // Sync avatar/name from other blocks
  useEffect(() => {
    const onAvatar = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (d?.agentId === resolvedAgentId && d?.avatarUrl) setAgent((p) => p ? { ...p, avatarUrl: d.avatarUrl } : p);
    };
    const onName = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (d?.agentId === resolvedAgentId && d?.name) setAgent((p) => p ? { ...p, name: d.name } : p);
    };
    window.addEventListener("agent-avatar-changed", onAvatar);
    window.addEventListener("agent-name-changed", onName);
    return () => { window.removeEventListener("agent-avatar-changed", onAvatar); window.removeEventListener("agent-name-changed", onName); };
  }, [resolvedAgentId]);

  const onAvatarFilePicked = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !/^image\/(png|jpe?g|gif|webp)$/.test(file.type)) return;
    const reader = new FileReader();
    reader.onload = () => setCropSource(reader.result as string);
    reader.readAsDataURL(file);
  }, []);

  const handleAvatarCropped = useCallback(async (dataUrl: string) => {
    setCropSource(null);
    if (!resolvedAgentId) return;
    setAvatarUploading(true);
    try {
      const res = await uploadAgentAvatar(resolvedAgentId, dataUrl);
      const busted = res.avatarUrl ? `${res.avatarUrl}?v=${Date.now()}` : res.avatarUrl;
      setAgent((p) => p ? { ...p, avatarUrl: busted } : p);
      window.dispatchEvent(new CustomEvent("agent-avatar-changed", { detail: { agentId: resolvedAgentId, avatarUrl: busted } }));
    } catch { /* ignore */ }
    setAvatarUploading(false);
  }, [resolvedAgentId]);

  const handleNameSave = useCallback(async (name: string) => {
    setNameEditing(false);
    if (!resolvedAgentId || !name.trim()) return;
    try {
      await renameAgent(resolvedAgentId, name.trim());
      setAgent((p) => p ? { ...p, name: name.trim() } : p);
      window.dispatchEvent(new CustomEvent("agent-name-changed", { detail: { agentId: resolvedAgentId, name: name.trim() } }));
    } catch { /* ignore */ }
  }, [resolvedAgentId]);

  const agentName = agent?.name || "Agent";
  const workspace = useWorkspace();

  // Fetch goal suggestions from backend (Todo Suggestions habit)
  const [recommendations, setRecommendations] = useState<GoalSuggestion[]>([]);
  useEffect(() => {
    fetchGoalSuggestions(workspace.workspaceId)
      .then((r) => setRecommendations(r.goals))
      .catch(() => {});
  }, [workspace.workspaceId]);

  // Local state
  const [status, setStatus] = useState<SessionStatus>("idle");
  const [goal, setGoal] = useState("");
  const [todos, setTodos] = useState<string[]>([]);
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [events, setEvents] = useState<AgencyEvent[]>([]);
  const [checkpoints, setCheckpoints] = useState<{ id: string; artifactType: string; label: string }[]>([]);
  const [currentMilestoneId, setCurrentMilestoneId] = useState<string | null>(null);
  const [popoverMode, setPopoverMode] = useState<"full" | "mini">(blockState.popoverMode ?? "full");
  const [chaosOpen, setChaosOpen] = useState(false);
  const [showCheckpoints, setShowCheckpoints] = useState(false);
  const [showRoutePopover, setShowRoutePopover] = useState(false);

  const eventSourceRef = useRef<EventSource | null>(null);
  const eventsEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll timeline
  useEffect(() => {
    eventsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events]);

  // SSE connection when session is active
  useEffect(() => {
    const sessionId = blockState.sessionId;
    if (!sessionId) return;

    const es = new EventSource(`/api/agency/sessions/${sessionId}/events`);
    eventSourceRef.current = es;

    es.addEventListener("connected", (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      setStatus(data.status as SessionStatus);
    });

    const handleEvent = (e: Event) => {
      const me = e as MessageEvent;
      const eventType = e.type;
      const data = JSON.parse(me.data);
      const agencyEvent: AgencyEvent = { type: eventType, data };
      setEvents((prev) => [...prev.slice(-200), agencyEvent]);

      if (eventType === "session:status") {
        setStatus(data.status as SessionStatus);
      } else if (eventType === "roadmap:planned") {
        fetchMilestones(sessionId);
      } else if (eventType === "milestone:started") {
        setCurrentMilestoneId(data.milestoneId as string);
        setStatus("executing");
      } else if (eventType === "milestone:validating") {
        setStatus("validating");
      } else if (eventType === "milestone:passed" || eventType === "milestone:failed") {
        fetchMilestones(sessionId);
      } else if (eventType === "checkpoint:created") {
        fetchCheckpoints(sessionId);
      } else if (eventType === "session:completed") {
        fetchCheckpoints(sessionId);
        setStatus("completed");
      }
    };

    const eventTypes = [
      "session:status", "roadmap:planned", "roadmap:replanned",
      "milestone:started", "milestone:progress", "milestone:validating",
      "milestone:validated", "milestone:passed", "milestone:failed",
      "checkpoint:created", "session:completed", "error",
    ];
    for (const t of eventTypes) es.addEventListener(t, handleEvent);

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [blockState.sessionId]);

  // Fetch milestones from REST
  const fetchMilestones = useCallback(async (sessionId: string) => {
    try {
      const res = await fetch(`/api/agency/sessions/${sessionId}/milestones`);
      if (res.ok) {
        const data = await res.json();
        setMilestones(data);
      }
    } catch { /* ignore */ }
  }, []);

  // Fetch checkpoints from REST
  const fetchCheckpoints = useCallback(async (sessionId: string) => {
    try {
      const res = await fetch(`/api/agency/sessions/${sessionId}/checkpoints`);
      if (res.ok) {
        const data = await res.json();
        setCheckpoints(data);
      }
    } catch { /* ignore */ }
  }, []);

  // Start agency session
  const handleStart = useCallback(async () => {
    if (!goal.trim()) return;
    setStatus("planning");
    setEvents([]);

    try {
      const res = await fetch("/api/agency/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: "ws_default",
          goal: goal.trim(),
          todos: todos.filter((t) => t.trim()),
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        setStatus("idle");
        setEvents([{ type: "error", data: { message: err.error ?? "Failed to start" } }]);
        return;
      }
      const session = await res.json();
      patchBlockState(blockId, { sessionId: session.id });
      scheduleSave();
    } catch (err: any) {
      setStatus("idle");
      setEvents([{ type: "error", data: { message: err.message } }]);
    }
  }, [goal, todos, blockId, patchBlockState, scheduleSave]);

  // Mid-flight edit
  const handleMidFlightEdit = useCallback(async (patch: { goal?: string; todos?: string[] }) => {
    const sessionId = blockState.sessionId;
    if (!sessionId) return;
    try {
      await fetch(`/api/agency/sessions/${sessionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
    } catch { /* ignore */ }
  }, [blockState.sessionId]);

  // Toggle popover mode
  const handleTogglePopover = useCallback(() => {
    const next = popoverMode === "full" ? "mini" : "full";
    setPopoverMode(next);
    patchBlockState(blockId, { popoverMode: next });
  }, [popoverMode, blockId, patchBlockState]);

  // ─── Derived state ────────────────────────────────────────────────────
  const isRunning = status === "planning" || status === "executing" || status === "validating" || status === "replanning";
  const isValidating = status === "validating";
  const showPopover = status === "idle";

  // ─── Map events to feed cards ─────────────────────────────────────────
  function renderFeed() {
    if (events.length === 0 && status === "idle") {
      return <GoalEmpty />;
    }

    const feedItems: React.ReactNode[] = [];

    events.forEach((ev, i) => {
      switch (ev.type) {
        case "roadmap:planned":
        case "roadmap:replanned": {
          const milestoneTitles = (ev.data.milestones as string[] | undefined) ?? milestones.map((m) => m.title);
          feedItems.push(
            <PlanningCard
              key={`plan-${i}`}
              goal={goal}
              milestones={milestoneTitles}
              status="ready"
            />
          );
          break;
        }
        case "milestone:started": {
          const msId = ev.data.milestoneId as string;
          const ms = milestones.find((m) => m.id === msId);
          const idx = ms ? ms.milestoneIndex + 1 : i + 1;
          feedItems.push(
            <MilestoneCard
              key={`ms-started-${i}`}
              idx={idx}
              title={ms?.title ?? (ev.data.title as string) ?? "Milestone"}
              status="running"
              log={[]}
              defaultOpen
            />
          );
          break;
        }
        case "milestone:progress": {
          // Progress lines are rendered as inline updates (CLI lines)
          feedItems.push(
            <div key={`prog-${i}`} className="ha-cli-block">
              <div className="ha-cli-row ha-cli-row-head">
                <span className="ha-cli-chev">{" "}</span>
                <Sigil status="running" />
                <span className="ha-cli-label">{String(ev.data.text ?? ev.data.message ?? "...")}</span>
              </div>
            </div>
          );
          break;
        }
        case "milestone:validating":
        case "milestone:validated": {
          feedItems.push(
            <div key={`val-${i}`} className="ha-cli-block">
              <div className="ha-cli-row ha-cli-row-head">
                <span className="ha-cli-chev">{" "}</span>
                <Sigil status="checking" />
                <span className="ha-cli-label">validate &middot; checking&hellip;</span>
              </div>
            </div>
          );
          break;
        }
        case "milestone:passed": {
          const msId = ev.data.milestoneId as string;
          const ms = milestones.find((m) => m.id === msId);
          const idx = ms ? ms.milestoneIndex + 1 : 1;
          const durationMs = ev.data.durationMs as number | undefined;
          const tokens = ev.data.promptTokens != null
            ? `${(((ev.data.promptTokens as number) + ((ev.data.completionTokens as number) || 0)) / 1000).toFixed(1)}k`
            : undefined;
          feedItems.push(
            <MilestoneCard
              key={`ms-passed-${i}`}
              idx={idx}
              title={ms?.title ?? (ev.data.title as string) ?? "Milestone"}
              status="passed"
              log={[]}
              duration={durationMs != null ? formatDuration(durationMs) : undefined}
              tokens={tokens}
            />
          );
          // Show validation card if criteria exist
          if (ev.data.criteria && Array.isArray(ev.data.criteria)) {
            feedItems.push(
              <ValidationCard
                key={`val-ok-${i}`}
                verdict="approved"
                criteria={(ev.data.criteria as { ok: boolean; text: string }[])}
              />
            );
          }
          break;
        }
        case "milestone:failed": {
          const msId = ev.data.milestoneId as string;
          const ms = milestones.find((m) => m.id === msId);
          const idx = ms ? ms.milestoneIndex + 1 : 1;
          feedItems.push(
            <MilestoneCard
              key={`ms-failed-${i}`}
              idx={idx}
              title={ms?.title ?? (ev.data.title as string) ?? "Milestone"}
              status="failed"
              log={[]}
            />
          );
          if (ev.data.criteria && Array.isArray(ev.data.criteria)) {
            feedItems.push(
              <ValidationCard
                key={`val-retry-${i}`}
                verdict="retry"
                criteria={(ev.data.criteria as { ok: boolean; text: string }[])}
                reason={ev.data.reason as string | undefined}
                nextAction={ev.data.nextAction as string | undefined}
                defaultOpen
              />
            );
          }
          break;
        }
        case "checkpoint:created": {
          feedItems.push(
            <CheckpointChips
              key={`cp-${i}`}
              items={[{ name: (ev.data.label as string) ?? (ev.data.artifactType as string) ?? "artifact" }]}
            />
          );
          break;
        }
        case "session:completed": {
          const totalDuration = ev.data.durationMs != null ? formatDuration(ev.data.durationMs as number) : "—";
          const totalTokens = ev.data.totalTokens != null ? `${((ev.data.totalTokens as number) / 1000).toFixed(1)}k` : "—";
          feedItems.push(
            <GoalDone
              key={`done-${i}`}
              artifacts={checkpoints.length}
              duration={totalDuration}
              tokens={totalTokens}
            />
          );
          if (checkpoints.length > 0) {
            feedItems.push(
              <CheckpointChips
                key={`cp-final-${i}`}
                items={checkpoints.map((cp) => ({ name: cp.label }))}
              />
            );
          }
          break;
        }
        case "error": {
          feedItems.push(
            <CliBlock key={`err-${i}`} status="failed" label="Error" expandable={false}>
              <CliLine kind="default" isLast>
                <span style={{ color: "var(--danger)" }}>{String(ev.data.message ?? "Unknown error")}</span>
              </CliLine>
            </CliBlock>
          );
          break;
        }
        default: {
          // Generic event — show as a simple CLI line
          feedItems.push(
            <div key={`generic-${i}`} className="ha-cli-block">
              <div className="ha-cli-row ha-cli-row-head">
                <span className="ha-cli-chev">{" "}</span>
                <Sigil status="pending" />
                <span className="ha-cli-label">
                  {ev.data.title != null ? String(ev.data.title) : formatEventType(ev.type)}
                </span>
              </div>
            </div>
          );
          break;
        }
      }
    });

    // Show planning spinner if planning but no roadmap event yet
    if (status === "planning" && !events.some((ev) => ev.type === "roadmap:planned")) {
      feedItems.unshift(
        <PlanningCard key="plan-thinking" goal={goal} milestones={[]} status="thinking" />
      );
    }

    // Final "goal achieved" if completed and no session:completed event rendered
    if (status === "completed" && !events.some((ev) => ev.type === "session:completed")) {
      feedItems.push(
        <CliBlock key="done-fallback" status="done" label="goal achieved" expandable={false} />
      );
    }

    return feedItems;
  }

  // ─── Render ─────────────────────────────────────────────────────────────

  return (
    <div className={`ha-block ha-state-${status}`}>

      {/* TopBar */}
      <header className="ha-topbar">
        <div className="ha-topbar-left">
          <button
            className={`ha-topbar-goal-btn ${showRoutePopover ? "is-active" : ""}`}
            onClick={() => setShowRoutePopover((v) => !v)}
          >
            {goal
              ? <span className="ha-topbar-goal-txt">{goal}</span>
              : <span className="ha-topbar-goal-placeholder">Set your goal&hellip;</span>}
          </button>
        </div>
        <div className="ha-topbar-actions">
          {/* 1) Chaos Monkey — icon + text */}
          <div className="ha-chaos-wrap">
            <button
              className={`ha-topbar-text-btn ${chaosOpen ? "is-active" : ""}`}
              onClick={() => setChaosOpen(!chaosOpen)}
            >
              <Icon d={ICONS.monkey} size={14} />
              <span>Chaos Monkey</span>
            </button>
            {chaosOpen && (
              <ChaosPopover isValidating={isValidating} onClose={() => setChaosOpen(false)} />
            )}
          </div>

          {/* 2) Checkpoints — icon + text */}
          <button
            className={`ha-topbar-text-btn ${showCheckpoints ? "is-active" : ""}`}
            onClick={() => setShowCheckpoints((v) => !v)}
          >
            <Icon d={ICONS.checkpoint} size={14} />
            <span>Checkpoints</span>
            {checkpoints.length > 0 && <span className="ha-checkpoint-count">{checkpoints.length}</span>}
          </button>

          {/* 3) AI icon — collapse block to infra topbar */}
          <button
            className="ha-topbar-ai-btn"
            title="Collapse to topbar"
            onClick={() => shellCtx?.onClose?.()}
          >
            <img src={aiIconColorful} alt="" width="18" height="18" />
          </button>
        </div>

      </header>

      {/* Route planner popover — overlay at block level, below topbar */}
      {showRoutePopover && (
          <div className="ha-rp-pop-overlay">
            <div className="ha-rp-pop-overlay-backdrop" onClick={() => setShowRoutePopover(false)} />
            <div className="ha-rp-pop ha-rp-pop-inline">
              {/* From */}
              <div className="ha-rp-pop-row">
                <span className="ha-rp-pop-marker ha-rp-pop-marker-from" />
                <div className="ha-compound-input ha-compound-input-sm">
                  <div className="ha-compound-prefix">From</div>
                  <div className="ha-compound-divider" />
                  <input type="text" className="ha-compound-field" value="Now" readOnly />
                </div>
              </div>

              {/* Steps — guide line connects markers */}
              <div className="ha-rp-pop-steps">
                {todos.map((td, i) => (
                  <div className="ha-rp-pop-step" key={i}>
                    <span className="ha-rp-pop-marker ha-rp-pop-marker-step" />
                    <div className="ha-compound-input ha-compound-input-sm">
                      <div className="ha-compound-prefix">Todo {i + 1}</div>
                      <div className="ha-compound-divider" />
                      <input
                        type="text"
                        className="ha-compound-field"
                        value={td}
                        onChange={(e) => {
                          const next = [...todos];
                          next[i] = e.target.value;
                          setTodos(next);
                        }}
                        onBlur={() => {
                          if (isRunning && blockState.sessionId) {
                            handleMidFlightEdit({ todos: todos.filter((t) => t.trim()) });
                          }
                        }}
                        placeholder="Describe a todo…"
                      />
                    </div>
                    <button className="ha-rp-pop-step-del" onClick={() => setTodos(todos.filter((_, j) => j !== i))} aria-label="delete">
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                        <path d="M18 6 6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                      </svg>
                    </button>
                  </div>
                ))}

                <button className="ha-rp-pop-add" onClick={() => setTodos([...todos, ""])}>
                  <Icon d={ICONS.plus} size={12} />
                  <span>Add Todo</span>
                </button>
              </div>

              {/* To (Goal) */}
              <div className="ha-rp-pop-row">
                <span className="ha-rp-pop-marker ha-rp-pop-marker-to" />
                <div className="ha-compound-input ha-compound-input-sm">
                  <div className="ha-compound-prefix">To</div>
                  <div className="ha-compound-divider" />
                  <input
                    type="text"
                    className="ha-compound-field"
                    value={goal}
                    onChange={(e) => setGoal(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && !isRunning) { e.preventDefault(); handleStart(); setShowRoutePopover(false); } }}
                    onBlur={() => {
                      if (isRunning && blockState.sessionId) {
                        handleMidFlightEdit({ goal: goal.trim() });
                      }
                    }}
                    placeholder="Set your goal…"
                  />
                </div>
              </div>

              {/* Submit button — always visible at bottom */}
              <button
                className="ha-rp-pop-submit"
                disabled={!goal.trim() || isRunning}
                onClick={() => { handleStart(); setShowRoutePopover(false); }}
              >
                {isRunning ? "Running…" : "Start"}
              </button>
            </div>
          </div>
        )}

      {/* Body — centered container, max 800px */}
      <div className="ha-body">
        <div className="ha-body-center">

          {/* Agent hero header (avatar + name + model) */}
          <div className="ab-hero ha-hero">
            <div className="ab-hero-avatar-wrap" title={t("topbar.changeAvatar") as string}>
              {agent ? (
                <img
                  key={agent.avatarUrl}
                  className="ab-hero-avatar"
                  src={agent.avatarUrl || FALLBACK_AVATAR}
                  alt=""
                  onError={(e) => { (e.currentTarget as HTMLImageElement).src = FALLBACK_AVATAR; }}
                />
              ) : (
                <div className="ab-hero-avatar ab-hero-avatar-skeleton" />
              )}
              <div className="ab-hero-avatar-overlay">
                {avatarUploading ? <span>…</span> : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                    <path d="M4 7h3l1.5-2h7L17 7h3a1 1 0 011 1v10a1 1 0 01-1 1H4a1 1 0 01-1-1V8a1 1 0 011-1z" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    <circle cx="12" cy="13" r="3.5" stroke="#fff" strokeWidth="1.6" />
                  </svg>
                )}
              </div>
              <input ref={avatarFileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="ab-hero-avatar-input" onChange={onAvatarFilePicked} />
            </div>
            <div className="ab-hero-meta">
              <div className="ab-hero-line">
                <span className="ab-hero-name">
                  <InlineEdit value={agentName} isEditing={nameEditing} onStartEdit={() => setNameEditing(true)} onSave={handleNameSave} onCancelEdit={() => setNameEditing(false)} maxLength={40} />
                </span>
              </div>
              <div className="ab-hero-chips">
                <ChatModelPicker agentId={resolvedAgentId} open={true} />
              </div>
            </div>
          </div>

          {/* Main content: route line + work area */}
          <div className="ha-main-row">
          {/* Left: Route line (From dot → dashed line → To dot) */}
          <div className="ha-route-side">
            <span className="ha-rp-pop-marker ha-rp-pop-marker-from" />
            <div className="ha-route-side-track">
              {milestones.map((m) => {
                const passed = m.status === "passed";
                const active = m.id === currentMilestoneId;
                return (
                  <span
                    key={m.id}
                    className={`ha-rp-pop-marker ha-rp-pop-marker-step ${passed ? "is-passed" : ""} ${active ? "is-active" : ""}`}
                    title={m.title}
                  />
                );
              })}
            </div>
            <span className="ha-rp-pop-marker ha-rp-pop-marker-to" />
          </div>

          {/* Right: Agent work area */}
          <div className="ha-work-area">
            {status === "idle" && events.length === 0 && (
              <div className="ha-work-welcome">
                <div className="ha-work-welcome-header">
                  <span>What would you like to achieve?</span>
                  <span className="ha-work-cursor" />
                </div>
                <p className="ha-work-welcome-sub">Set a goal and the agent will drive autonomously. Here are some ideas based on your workspace:</p>
                <div className="ha-work-suggestions">
                  {recommendations.map((rec, i) => (
                    <button
                      key={i}
                      className="ha-work-suggestion"
                      onClick={() => {
                        setGoal(rec.goal);
                        if (rec.todos) setTodos(rec.todos);
                        setShowRoutePopover(true);
                      }}
                    >
                      <span className="ha-work-suggestion-goal">{rec.goal}</span>
                      {rec.todos && (
                        <span className="ha-work-suggestion-todos">
                          {rec.todos.length} steps: {rec.todos.join(" → ")}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {(status !== "idle" || events.length > 0) && (
              <div className="ha-feed">
                <div className="ha-feed-inner">
                  {renderFeed()}
                  <div ref={eventsEndRef} />
                </div>
              </div>
            )}
          </div>
          </div>
        </div>
      </div>

      {/* Avatar crop dialog */}
      {cropSource && (
        <AvatarCropDialog
          sourceDataUrl={cropSource}
          onConfirm={handleAvatarCropped}
          onCancel={() => setCropSource(null)}
        />
      )}
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60000);
  const sec = Math.round((ms % 60000) / 1000);
  return `${min}:${String(sec).padStart(2, "0")}`;
}

function formatEventType(type: string): string {
  const map: Record<string, string> = {
    "session:status": "Status",
    "roadmap:planned": "Roadmap Ready",
    "roadmap:replanned": "Roadmap Updated",
    "milestone:started": "Milestone Started",
    "milestone:progress": "Progress",
    "milestone:validating": "Validating...",
    "milestone:validated": "Validation Result",
    "milestone:passed": "Passed",
    "milestone:failed": "Retry Needed",
    "checkpoint:created": "Artifact",
    "session:completed": "Completed",
    "error": "Error",
  };
  return map[type] ?? type;
}
