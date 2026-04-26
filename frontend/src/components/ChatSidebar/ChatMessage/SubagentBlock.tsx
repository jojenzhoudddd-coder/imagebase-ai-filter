/**
 * SubagentBlock — V2.3 重构。
 *
 * 与 ToolCallCard 共享 `chat-expand-card` 样式骨架(D2)。视觉一致:同款
 * header / status dot / chevron / body 折叠容器。Subagent 特有内容
 * 体现在 body:思考 / 工具调用 / 最终输出三段式。
 *
 * V2.3 行为细节:
 *   - C6: streaming 时自动展开,success 后自动折叠回 header
 *   - 完成后用户仍可手动展开看完整流程
 *   - 错误状态保持展开露出错误信息
 */

import { useEffect, useRef, useState } from "react";
import type { ChatToolCall } from "../../../api";
import type { UiSubagentRun } from "../index";
import {
  StatusDot,
  Chevron,
  SubagentGlyph,
  CardTitleParts,
  formatElapsed,
  useCardTranslation,
  type CardStatus,
} from "./cardCommon";

interface Props {
  run: UiSubagentRun;
}

export default function SubagentBlock({ run }: Props) {
  const { t } = useCardTranslation();
  const [expanded, setExpanded] = useState(run.status === "running");
  // V2.3 C6: auto-collapse on success (but not on error — keep error visible)
  const prevStatusRef = useRef(run.status);
  useEffect(() => {
    const prev = prevStatusRef.current;
    if (prev === "running" && run.status === "success") {
      setExpanded(false);
    }
    if (prev === "running" && run.status === "error") {
      setExpanded(true);
    }
    prevStatusRef.current = run.status;
  }, [run.status]);

  const status: CardStatus = run.status;
  const userPromptShort =
    run.userPrompt.length > 60 ? run.userPrompt.slice(0, 60) + "…" : run.userPrompt;
  const statusTitle = t(`chat.subagent.status.${status}` as any) ?? status;

  // V2.5 placeholder: data-runid will let WorkflowBlock node-click scroll
  // here (C7). Already in DOM so V2.5/V2.8 can wire up scroll-to.
  return (
    <div
      className={`chat-expand-card chat-subagent-card ${status}${expanded ? " expanded" : ""}`}
      data-runid={run.runId}
    >
      <button
        type="button"
        className="chat-expand-card-header"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className="chat-expand-card-icon" aria-hidden="true">
          <SubagentGlyph />
        </span>
        <span className="chat-expand-card-title">
          <CardTitleParts
            primary={run.resolvedModel}
            secondary={userPromptShort}
          />
        </span>
        {run.usedFallback && (
          <span className="chat-expand-card-fallback-hint" title={`requested ${run.requestedModel}`}>
            ↳
          </span>
        )}
        <span className="chat-expand-card-elapsed">{formatElapsed(run.durationMs)}</span>
        <StatusDot status={status} title={statusTitle} />
        <Chevron expanded={expanded} />
      </button>

      {expanded && (
        <div className="chat-expand-card-body chat-subagent-body">
          {run.error && (
            <div className="chat-subagent-section chat-subagent-error-section">
              <div className="chat-expand-card-section-label">错误</div>
              <div className="chat-subagent-error-text">{run.error}</div>
            </div>
          )}
          {run.thinking && (
            <div className="chat-subagent-section">
              <div className="chat-expand-card-section-label">思考</div>
              <div className="chat-subagent-thinking">{run.thinking}</div>
            </div>
          )}
          {run.toolCalls.length > 0 && (
            <div className="chat-subagent-section">
              <div className="chat-expand-card-section-label">
                工具调用 ({run.toolCalls.length})
              </div>
              <ul className="chat-subagent-toolcalls">
                {run.toolCalls.map((tc) => (
                  <li key={tc.callId}>
                    <SubagentToolCallRow call={tc} />
                  </li>
                ))}
              </ul>
            </div>
          )}
          {run.finalText && (
            <div className="chat-subagent-section">
              <div className="chat-expand-card-section-label">最终输出</div>
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
  const status = (call.status ?? "running") as CardStatus;
  return (
    <div className={`chat-subagent-toolrow ${status}`}>
      <button
        type="button"
        className="chat-subagent-toolrow-head"
        onClick={() => setOpen((v) => !v)}
      >
        <StatusDot status={status} />
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
