/**
 * SubagentBlock — PR3 Agent Workflow.
 *
 * Renders one subagent run (one row from `subagent_runs` table) as a
 * collapsible block within the parent host message. Visual hierarchy:
 *
 *   ┌──────────────────────────────────────────┐
 *   │ 🤖  Claude 4.7 Opus → audit security  ▾ │  ← collapsed header
 *   │  ✓ 完成 · 12.3s · 2 个工具调用            │
 *   └──────────────────────────────────────────┘
 *
 * Expanded state additionally shows:
 *   - User prompt (gray quote block)
 *   - Thinking (灰色小字)
 *   - Tool calls list (re-uses ToolCallCard styling)
 *   - Final text (主气泡风格)
 *
 * V1 keeps it linear (no nested SubagentBlock). PR4 enables depth=2 by
 * recursively rendering subagentRuns inside ToolCalls — but the UI hooks
 * are already in place via the recursive `runs` prop.
 */

import { useState } from "react";
import type { ChatToolCall } from "../../../api";
import type { UiSubagentRun } from "../index";

interface Props {
  run: UiSubagentRun;
}

export default function SubagentBlock({ run }: Props) {
  const [expanded, setExpanded] = useState(run.status === "running");
  const statusEmoji = run.status === "running" ? "⏳" : run.status === "success" ? "✓" : "✗";
  const statusClass =
    run.status === "running"
      ? "subagent-running"
      : run.status === "success"
      ? "subagent-success"
      : "subagent-error";

  const userPromptShort =
    run.userPrompt.length > 60 ? run.userPrompt.slice(0, 60) + "…" : run.userPrompt;

  const headerSubtitle =
    run.status === "running"
      ? "进行中…"
      : run.status === "success"
      ? `完成 · ${formatDuration(run.durationMs)} · ${run.toolCalls.length} 个工具调用`
      : `出错 · ${run.error ?? ""}`;

  return (
    <div className={`chat-subagent-block ${statusClass}`}>
      <button
        type="button"
        className="chat-subagent-header"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="chat-subagent-icon">🤖</span>
        <span className="chat-subagent-headtext">
          <span className="chat-subagent-model">{run.resolvedModel}</span>
          <span className="chat-subagent-task"> → {userPromptShort}</span>
        </span>
        <span className="chat-subagent-toggle">{expanded ? "▾" : "▸"}</span>
      </button>
      <div className="chat-subagent-status">
        <span className="chat-subagent-status-dot">{statusEmoji}</span>
        <span className="chat-subagent-status-text">{headerSubtitle}</span>
        {run.usedFallback && (
          <span className="chat-subagent-fallback-hint">(用户请求 {run.requestedModel},已 fallback)</span>
        )}
      </div>
      {expanded && (
        <div className="chat-subagent-body">
          {run.thinking && (
            <div className="chat-subagent-section">
              <div className="chat-subagent-section-label">思考</div>
              <div className="chat-subagent-thinking">{run.thinking}</div>
            </div>
          )}
          {run.toolCalls.length > 0 && (
            <div className="chat-subagent-section">
              <div className="chat-subagent-section-label">工具调用</div>
              <ul className="chat-subagent-toolcalls">
                {run.toolCalls.map((tc) => (
                  <li key={tc.callId} className={`chat-subagent-toolcall ${tc.status ?? "running"}`}>
                    <SubagentToolCallRow call={tc} />
                  </li>
                ))}
              </ul>
            </div>
          )}
          {run.finalText && (
            <div className="chat-subagent-section">
              <div className="chat-subagent-section-label">最终输出</div>
              <div className="chat-subagent-final">{run.finalText}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SubagentToolCallRow({ call }: { call: ChatToolCall }) {
  const [open, setOpen] = useState(false);
  const status = call.status ?? "running";
  const dot = status === "running" ? "⏳" : status === "success" ? "✓" : status === "error" ? "✗" : "•";
  return (
    <div className={`chat-subagent-toolrow ${status}`}>
      <button
        type="button"
        className="chat-subagent-toolrow-head"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="chat-subagent-toolrow-dot">{dot}</span>
        <span className="chat-subagent-toolrow-name">{call.tool}</span>
        <span className="chat-subagent-toolrow-toggle">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="chat-subagent-toolrow-body">
          <pre className="chat-subagent-toolrow-args">{JSON.stringify(call.args ?? {}, null, 2)}</pre>
          {call.result !== undefined && (
            <pre className="chat-subagent-toolrow-result">
              {typeof call.result === "string" ? call.result : JSON.stringify(call.result, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function formatDuration(ms?: number): string {
  if (!ms || ms <= 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
