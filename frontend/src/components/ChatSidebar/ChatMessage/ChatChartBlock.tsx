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

import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useResolvedTheme } from "../../../theme";

export interface ChatChartBlockProps {
  spec: Record<string, unknown>;
  /** Height override in px — defaults to 280. */
  height?: number;
  /** Optional caption shown above the chart (chart title isn't always set). */
  caption?: string;
}

// Local error boundary — a malformed vega spec (or a vega-embed internal throw)
// used to cascade through React's reconciliation and white-screen the entire
// chat feed. We now contain the damage here so the rest of the message tree
// keeps rendering even when one chart breaks.
class ChartErrorBoundary extends Component<
  { children: ReactNode; spec: Record<string, unknown> },
  { err: Error | null }
> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) { return { err }; }
  componentDidCatch(err: Error) { console.warn("[ChatChartBlock] render crashed:", err); }
  render() {
    if (this.state.err) {
      return (
        <div className="chat-chart-block chat-chart-block-error">
          <div className="chat-chart-block-header">图表渲染失败：{this.state.err.message}</div>
          <pre className="chat-chart-block-raw">{JSON.stringify(this.props.spec, null, 2).slice(0, 800)}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

function ChatChartBlockInner({ spec, height = 280, caption }: ChatChartBlockProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rendering, setRendering] = useState(true);
  // 主题切换 → 重新渲染图表(vega 不支持运行时换主题,得整张重画)
  const resolvedTheme = useResolvedTheme();

  // Spec may arrive as a fresh object on every parent render (it's JSON.parsed
  // inside AssistantText's code renderer). Without memoizing by content,
  // the effect below re-runs on every chat chunk, racing vega-embed's async
  // init against its own cleanup and leaving the host in an inconsistent
  // state — which is the exact trigger for the NotFoundError cascade.
  const specKey = useMemo(() => {
    try { return JSON.stringify(spec); } catch { return ""; }
  }, [spec]);

  useEffect(() => {
    let cancelled = false;
    setRendering(true);
    setError(null);
    (async () => {
      try {
        const mod = await import("vega-embed");
        if (cancelled || !hostRef.current) return;
        const embed = (mod as { default?: any }).default ?? mod;
        // DM 适配:
        //  - vega-embed 内置 "dark" 主题(深底浅字),light 用默认无主题
        //  - 透明背景让图表自然吃宿主容器的 dm/lm 背景色
        //  - tooltip theme 也跟随
        const isDark = resolvedTheme === "dark";
        const enriched = {
          ...spec,
          width: (spec as any).width ?? "container",
          height: (spec as any).height ?? height,
          // 强制透明背景,这样 dm 下不会出现"白色矩形浮在深色容器上"的视觉断层
          background: (spec as any).background ?? "transparent",
        };
        await embed(hostRef.current, enriched as any, {
          actions: false,
          renderer: "svg",
          theme: isDark ? "dark" : undefined,
          tooltip: { theme: isDark ? "dark" : "light" },
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
      // Clear the host so a stale vega view doesn't overlap with the next
      // render. Guard against the ref already being detached.
      const el = hostRef.current;
      if (el) {
        try { el.innerHTML = ""; } catch { /* swallow — detached node is fine */ }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specKey, height, resolvedTheme]);

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

  // CRITICAL: the vega host MUST NOT have any React children. vega-embed
  // mutates the host via innerHTML; if React owns anything inside it, the
  // next reconcile fails with "Failed to execute 'removeChild' on 'Node'"
  // and white-screens the whole chat feed (and outer app, since the error
  // unwinds through the message list). Loading indicator lives OUTSIDE the
  // host as an absolutely-positioned sibling.
  return (
    <div className="chat-chart-block">
      {caption && <div className="chat-chart-block-caption">{caption}</div>}
      <div className="chat-chart-host-wrap" style={{ position: "relative", minHeight: height }}>
        <div ref={hostRef} className="chat-chart-host" />
        {rendering && (
          <div
            className="chat-chart-loading"
            style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}
          >
            加载图表中…
          </div>
        )}
      </div>
    </div>
  );
}

export default function ChatChartBlock(props: ChatChartBlockProps) {
  return (
    <ChartErrorBoundary spec={props.spec}>
      <ChatChartBlockInner {...props} />
    </ChartErrorBoundary>
  );
}
