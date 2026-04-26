/**
 * WorkflowBlock — V2.3 重构。
 *
 * 与 ToolCallCard / SubagentBlock 共享 `chat-expand-card` 样式骨架(D2)。
 * Workflow 特有内容是节点级 timeline(node_start / node_end / loop_iter /
 * branch_start)+ 模板 id pill。
 *
 * V2.3 C6: streaming 时自动展开,success 后自动折叠;error/aborted 保持展开。
 */

import { useEffect, useRef, useState } from "react";
import type { UiWorkflowRun } from "../index";
import {
  StatusDot,
  Chevron,
  WorkflowGlyph,
  CardTitleParts,
  formatElapsed,
  useCardTranslation,
  type CardStatus,
} from "./cardCommon";

interface Props {
  run: UiWorkflowRun;
}

export default function WorkflowBlock({ run }: Props) {
  const { t } = useCardTranslation();
  const [expanded, setExpanded] = useState(run.status === "running");
  // V2.3 C6: auto-collapse on success
  const prevStatusRef = useRef(run.status);
  useEffect(() => {
    const prev = prevStatusRef.current;
    if (prev === "running" && run.status === "success") setExpanded(false);
    if (prev === "running" && (run.status === "error" || run.status === "aborted"))
      setExpanded(true);
    prevStatusRef.current = run.status;
  }, [run.status]);

  const status: CardStatus =
    run.status === "running" ? "running"
    : run.status === "success" ? "success"
    : run.status === "aborted" ? "aborted"
    : "error";
  const statusTitle = t(`chat.workflow.status.${run.status}` as any) ?? run.status;

  return (
    <div
      className={`chat-expand-card chat-workflow-card ${run.status}${expanded ? " expanded" : ""}`}
      data-runid={run.runId}
    >
      <button
        type="button"
        className="chat-expand-card-header"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className="chat-expand-card-icon" aria-hidden="true">
          <WorkflowGlyph />
        </span>
        <span className="chat-expand-card-title">
          <CardTitleParts
            primary={`workflow · ${run.templateId ?? "custom"}`}
            secondary={`${run.nodeEvents.length} 个事件`}
          />
        </span>
        <span className="chat-expand-card-elapsed">{formatElapsed(run.durationMs)}</span>
        <StatusDot status={status} title={statusTitle} />
        <Chevron expanded={expanded} />
      </button>

      {expanded && (
        <div className="chat-expand-card-body chat-workflow-body">
          {run.error && (
            <div className="chat-subagent-error-section">
              <div className="chat-expand-card-section-label">错误</div>
              <div className="chat-subagent-error-text">{run.error}</div>
            </div>
          )}
          <div className="chat-workflow-timeline">
            {run.nodeEvents.map((ev, idx) => {
              const targetNodeId = extractNodeId(ev);
              const clickable = !!targetNodeId;
              return (
                <div
                  key={idx}
                  className={`chat-workflow-tle chat-workflow-tle-${ev.kind}${clickable ? " chat-workflow-tle-clickable" : ""}`}
                  role={clickable ? "button" : undefined}
                  tabIndex={clickable ? 0 : undefined}
                  onClick={clickable ? () => scrollToSubagentNode(targetNodeId) : undefined}
                  onKeyDown={
                    clickable
                      ? (e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            scrollToSubagentNode(targetNodeId);
                          }
                        }
                      : undefined
                  }
                >
                  {renderTimelineEvent(ev)}
                </div>
              );
            })}
            {run.nodeEvents.length === 0 && (
              <div className="chat-workflow-tle-empty">(尚无节点事件)</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function renderTimelineEvent(ev: UiWorkflowRun["nodeEvents"][number]): React.ReactNode {
  if (ev.kind === "node_start") {
    return (
      <>
        <span className="chat-workflow-tle-dot">▸</span>
        <span className="chat-workflow-tle-label">
          {ev.nodeKind === "trigger"
            ? "触发"
            : ev.nodeKind === "logic"
            ? `逻辑·${ev.nodeType ?? ""}`
            : `动作·${ev.nodeType ?? ""}`}
        </span>
        <span className="chat-workflow-tle-id">{ev.nodeId}</span>
      </>
    );
  }
  if (ev.kind === "node_end") {
    return (
      <>
        <span className="chat-workflow-tle-dot">✓</span>
        <span className="chat-workflow-tle-label">完成</span>
        <span className="chat-workflow-tle-id">{ev.nodeId}</span>
      </>
    );
  }
  if (ev.kind === "loop_iter") {
    return (
      <>
        <span className="chat-workflow-tle-dot">↻</span>
        <span className="chat-workflow-tle-label">
          循环 {ev.iter + 1}/{ev.maxIter}
        </span>
        <span className="chat-workflow-tle-id">{ev.loopNodeId}</span>
      </>
    );
  }
  if (ev.kind === "branch_start") {
    return (
      <>
        <span className="chat-workflow-tle-dot">⫶</span>
        <span className="chat-workflow-tle-label">
          分支 {ev.branchIdx + 1}/{ev.totalBranches}
        </span>
        <span className="chat-workflow-tle-id">{ev.parentNodeId}</span>
      </>
    );
  }
  return null;
}

/** V2.8 C7:从 nodeEvent 中抽取 nodeId(用于点击查找对应 SubagentBlock)。
 *  trigger / 工作流虚拟节点(_heartbeat 等)无效;仅 logic / action 才有可定位的目标。 */
function extractNodeId(ev: UiWorkflowRun["nodeEvents"][number]): string | null {
  if (ev.kind === "node_start" || ev.kind === "node_end") {
    if (!ev.nodeId || ev.nodeId.startsWith("_")) return null;
    return ev.nodeId;
  }
  return null;
}

/** Scroll the matching SubagentBlock (data-workflownodeid=…) into view + flash 1.4s. */
function scrollToSubagentNode(nodeId: string) {
  const el = document.querySelector<HTMLElement>(`[data-workflownodeid="${cssEscape(nodeId)}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.add("chat-expand-card-flash");
  window.setTimeout(() => el.classList.remove("chat-expand-card-flash"), 1400);
}

function cssEscape(v: string): string {
  // Modern browsers expose CSS.escape; fallback for older + tests
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(v) : v.replace(/["\\]/g, "\\$&");
}
