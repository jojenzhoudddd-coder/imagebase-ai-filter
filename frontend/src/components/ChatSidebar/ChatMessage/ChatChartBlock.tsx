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
        // DM 适配:不依赖 vega-themes 的命名主题(注册时机 / tree-shake 不可靠),
        // 直接 merge 一份 config 把轴/网格/图例/标题文字色全切到浅色;background
        // 透明让图表吃宿主卡片的 surface 颜色。
        const isDark = resolvedTheme === "dark";
        // DM 调色盘
        const DM_SURFACE = "#2C2C2E";   // 卡片背景色 / 数据缺失格的填充
        const DM_BORDER  = "#646A73";   // 轴线 / tick
        const DM_LABEL   = "#C7C9CC";   // 文字
        const DM_TITLE   = "#E5E6EB";
        // DM 下用一组深→浅蓝渐变作为热力图默认 scheme(覆盖 vega-lite 默认的
        // "blues",原 scheme 0 端是纯白,DM 下最刺眼)
        const DM_HEATMAP_RANGE = ["#1E3A8A", "#3B5BDB", "#7A99FF", "#B0C4FF"];
        const dmConfig = isDark ? {
          background: "transparent",
          // view.fill 设成卡片色 → 数据缺失格透出来也是和外层卡片一致的灰,
          // 不再是"纯黑空洞"; view.stroke 透明去掉外框
          view: { fill: DM_SURFACE, stroke: "transparent" },
          axis: {
            domainColor: DM_BORDER,
            tickColor: DM_BORDER,
            gridColor: "rgba(229, 230, 235, 0.08)",
            labelColor: DM_LABEL,
            titleColor: DM_TITLE,
          },
          legend: {
            labelColor: DM_LABEL,
            titleColor: DM_TITLE,
            gradientStrokeColor: "transparent",
          },
          title: { color: DM_TITLE },
          header: { labelColor: DM_LABEL, titleColor: DM_TITLE },
          text: { color: DM_LABEL },
          // 关键: rect / cell mark 的默认 stroke 改成 surface 色 —— 等同于
          // LM 默认 white-on-white 的"无形分隔":DM 下 dark-on-dark,heatmap /
          // gantt 单元格之间的白色细线消失。
          rect: { stroke: DM_SURFACE },
          cell: { stroke: DM_SURFACE },
          mark: { stroke: DM_SURFACE },
          // 默认色阶替换 —— 让连续 quantitative 色阶低端从 surface 色起,
          // 不再有刺眼白色低端。用户自定义 scheme 不受影响(spec.config.range 优先)
          range: { heatmap: DM_HEATMAP_RANGE, ramp: DM_HEATMAP_RANGE },
        } : undefined;
        // 深合并 config —— 用户(spec.config)优先于 DM 默认,但仅覆盖具体字段,
        // 不要让用户的 axis.titleFontSize 把我们整个 axis.{labelColor,gridColor,...}
        // 清空。
        const userConfig = ((spec as any).config ?? {}) as Record<string, any>;
        const mergedConfig: Record<string, any> = { ...(dmConfig ?? {}) };
        for (const [k, v] of Object.entries(userConfig)) {
          if (v && typeof v === "object" && !Array.isArray(v) && mergedConfig[k] && typeof mergedConfig[k] === "object") {
            mergedConfig[k] = { ...mergedConfig[k], ...v };
          } else {
            mergedConfig[k] = v;
          }
        }
        const enriched = {
          ...spec,
          width: (spec as any).width ?? "container",
          height: (spec as any).height ?? height,
          background: "transparent",
          config: mergedConfig,
        };
        await embed(hostRef.current, enriched as any, {
          actions: false,
          renderer: "svg",
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
