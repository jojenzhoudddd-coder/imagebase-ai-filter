/**
 * WorkflowBlock — PR4 Agent Workflow.
 *
 * Renders one workflow run (a `UiWorkflowRun` from index.tsx) as a
 * collapsible card showing:
 *   - templateId pill (review / brainstorm / cowork / concurrent-data)
 *   - status (running / success / error / aborted) + duration
 *   - timeline of node events (start → end, with loop iterations + branch
 *     announcements interleaved)
 *
 * Subagent runs spawned BY this workflow render as separate SubagentBlock
 * components on the same message (they're added to msg.subagentRuns by
 * the spawnSubagent → subagent_start path);WorkflowBlock just shows the
 * orchestration timeline.
 */

import { useState } from "react";
import type { UiWorkflowRun } from "../index";

interface Props {
  run: UiWorkflowRun;
}

export default function WorkflowBlock({ run }: Props) {
  const [expanded, setExpanded] = useState(run.status === "running");

  const statusEmoji =
    run.status === "running"
      ? "⏳"
      : run.status === "success"
      ? "✓"
      : run.status === "aborted"
      ? "⊘"
      : "✗";
  const statusClass =
    run.status === "running"
      ? "workflow-running"
      : run.status === "success"
      ? "workflow-success"
      : run.status === "aborted"
      ? "workflow-aborted"
      : "workflow-error";

  const headerSubtitle =
    run.status === "running"
      ? "进行中…"
      : run.status === "success"
      ? `完成 · ${formatDuration(run.durationMs)} · ${run.nodeEvents.length} 个节点事件`
      : run.status === "aborted"
      ? `已中止 · ${run.error ?? ""}`
      : `失败 · ${run.error ?? ""}`;

  return (
    <div className={`chat-workflow-block ${statusClass}`}>
      <button
        type="button"
        className="chat-workflow-header"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="chat-workflow-icon">⚡</span>
        <span className="chat-workflow-headtext">
          <span className="chat-workflow-template">{run.templateId ?? "workflow"}</span>
          <span className="chat-workflow-runid"> · {run.runId.slice(0, 12)}</span>
        </span>
        <span className="chat-workflow-toggle">{expanded ? "▾" : "▸"}</span>
      </button>
      <div className="chat-workflow-status">
        <span className="chat-workflow-status-dot">{statusEmoji}</span>
        <span className="chat-workflow-status-text">{headerSubtitle}</span>
      </div>
      {expanded && (
        <div className="chat-workflow-body">
          <div className="chat-workflow-timeline">
            {run.nodeEvents.map((ev, idx) => (
              <div key={idx} className={`chat-workflow-tle chat-workflow-tle-${ev.kind}`}>
                {renderTimelineEvent(ev)}
              </div>
            ))}
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

function formatDuration(ms?: number): string {
  if (!ms || ms <= 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
