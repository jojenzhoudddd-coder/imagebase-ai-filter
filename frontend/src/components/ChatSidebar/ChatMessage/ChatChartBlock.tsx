/**
 * ChatChartBlock — renders a vega-lite spec inline in chat.
 *
 * Dynamic import: vega-embed pulls ~400KB gzipped. We only load it when a
 * chart actually appears so the initial bundle stays lean.
 *
 * Rendered in two contexts:
 *   1. As the replacement for fenced ```vega-lite code blocks in AssistantText
 *   2. Inside Idea preview (via IdeaEditor MarkdownPreview) — same component
 *
 * Graceful degradation: if vega-embed fails to load or the spec is invalid,
 * we fall back to showing the raw JSON in a <pre> so the user doesn't get
 * a blank card.
 */

import { useEffect, useRef, useState } from "react";

export interface ChatChartBlockProps {
  spec: Record<string, unknown>;
  /** Height override in px — defaults to 280. */
  height?: number;
  /** Optional caption shown above the chart (chart title isn't always set). */
  caption?: string;
}

export default function ChatChartBlock({ spec, height = 280, caption }: ChatChartBlockProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rendering, setRendering] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setRendering(true);
    setError(null);
    (async () => {
      try {
        const mod = await import("vega-embed");
        if (cancelled || !hostRef.current) return;
        const embed = (mod as { default?: any }).default ?? mod;
        const enriched = {
          ...spec,
          width: (spec as any).width ?? "container",
          height: (spec as any).height ?? height,
        };
        await embed(hostRef.current, enriched as any, {
          actions: false,
          renderer: "svg",
          tooltip: { theme: "light" },
        });
        if (!cancelled) setRendering(false);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setRendering(false);
        }
      }
    })();
    return () => {
      cancelled = true;
      // Clear the host so React doesn't complain about a detached vega view
      if (hostRef.current) hostRef.current.innerHTML = "";
    };
  }, [spec, height]);

  if (error) {
    return (
      <div className="chat-chart-block chat-chart-block-error">
        <div className="chat-chart-block-header">
          图表渲染失败：{error}
        </div>
        <pre className="chat-chart-block-raw">{JSON.stringify(spec, null, 2).slice(0, 800)}</pre>
      </div>
    );
  }

  return (
    <div className="chat-chart-block">
      {caption && <div className="chat-chart-block-caption">{caption}</div>}
      <div ref={hostRef} className="chat-chart-host" style={{ minHeight: height }}>
        {rendering && <div className="chat-chart-loading">加载图表中…</div>}
      </div>
    </div>
  );
}
