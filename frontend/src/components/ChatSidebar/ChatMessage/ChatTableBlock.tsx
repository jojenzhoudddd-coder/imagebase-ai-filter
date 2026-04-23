/**
 * ChatTableBlock — virtualized-ish table rendering inside chat bubbles.
 *
 * Used in two contexts:
 *   1. Analyst tool_result shows the compact preview from a _resultHandle
 *   2. Agent-generated Markdown tables (via remark-gfm) get replaced with
 *      this component for consistent scroll + overflow behavior
 *
 * Design choices (§9 of docs/analyst-skill-plan.md):
 *   - Rows ≤ 10      → static <table>
 *   - Rows 10–100    → scrollable container with sticky header
 *   - Rows > 100     → container + footer declaring total + prompt to continue
 *   - Columns > 6    → horizontal scroll; no sticky first column (keeps code simple
 *                      and markdown rendering parity)
 *   - No inline sort/filter — per user decision, interactive operations are via chat
 */

import type { CSSProperties, ReactNode } from "react";

export interface ChatTableBlockProps {
  columns: Array<{ name: string; type?: string }>;
  rows: Array<Record<string, unknown>>;
  /** Total number of rows in the full result — may exceed rows.length. */
  totalRows?: number;
  /** Optional caption above the table (tool name, handle, etc.). */
  caption?: ReactNode;
  /** Footer note (e.g. "本次分析基于 2026-04-23 10:15 的快照"). */
  footerNote?: ReactNode;
  /** Max container height in px. Default 360. */
  maxHeight?: number;
}

export default function ChatTableBlock({
  columns,
  rows,
  totalRows,
  caption,
  footerNote,
  maxHeight = 360,
}: ChatTableBlockProps) {
  const displayRows = rows;
  const computedTotal = totalRows ?? rows.length;
  const truncated = computedTotal > rows.length;
  const needsScroll = rows.length > 10;

  const containerStyle: CSSProperties | undefined = needsScroll
    ? { maxHeight: `${maxHeight}px` }
    : undefined;

  if (!columns.length) {
    return (
      <div className="chat-table-block chat-table-block-empty">
        {caption && <div className="chat-table-block-caption">{caption}</div>}
        <div className="chat-table-block-hint">（结果为空）</div>
        {footerNote && <div className="chat-table-block-footer">{footerNote}</div>}
      </div>
    );
  }

  return (
    <div className="chat-table-block">
      {caption && <div className="chat-table-block-caption">{caption}</div>}
      <div className="chat-table-block-scroll" style={containerStyle}>
        <table className="chat-table">
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.name} title={c.type ? `${c.name} · ${c.type}` : c.name}>
                  {c.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {displayRows.map((r, i) => (
              <tr key={i}>
                {columns.map((c) => (
                  <td key={c.name} className={cellClass(r[c.name])}>
                    {formatCell(r[c.name])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(truncated || footerNote) && (
        <div className="chat-table-block-footer">
          {truncated && (
            <span className="chat-table-block-truncation">
              显示 {displayRows.length} / 共 {computedTotal.toLocaleString()} 行
              {" · 告知即可继续分析或整理成文档"}
            </span>
          )}
          {footerNote && (
            <span className="chat-table-block-note">
              {truncated ? " · " : ""}
              {footerNote}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function cellClass(v: unknown): string {
  if (v === null || v === undefined) return "chat-table-cell null";
  if (typeof v === "number") return "chat-table-cell numeric";
  if (typeof v === "boolean") return "chat-table-cell boolean";
  return "chat-table-cell";
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") {
    if (Number.isInteger(v)) return v.toLocaleString();
    // 2 decimals for non-integers unless very small
    if (Math.abs(v) < 0.01 && v !== 0) return v.toExponential(2);
    return v.toLocaleString(undefined, { maximumFractionDigits: 4 });
  }
  if (typeof v === "boolean") return v ? "✓" : "";
  if (typeof v === "string") return v.length > 200 ? v.slice(0, 197) + "…" : v;
  try {
    const j = JSON.stringify(v);
    return j.length > 200 ? j.slice(0, 197) + "…" : j;
  } catch {
    return String(v);
  }
}
