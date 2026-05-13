/**
 * ChartCodeBlockExtension — overrides Tiptap's default CodeBlock so fenced
 *   ```vega-lite
 *   { ... vega-lite spec JSON ... }
 *   ```
 * (or `vega`) blocks get rendered as an actual interactive chart via
 * `ChatChartBlock` — same component the chat UI uses, so heatmaps / line /
 * bar / etc. all work identically here.
 *
 * For any other language the code block falls back to a regular
 * `<pre><code>` view (StarterKit's default behaviour).
 *
 * Tiptap-markdown's serializer round-trips fenced code blocks unchanged,
 * so when we save the doc the JSON survives byte-for-byte.
 */

import CodeBlock from "@tiptap/extension-code-block";
import { ReactNodeViewRenderer, NodeViewWrapper, NodeViewContent, type NodeViewProps } from "@tiptap/react";
import { Suspense, lazy, useMemo } from "react";

// Lazy import — vega-embed is ~400KB gzipped, only pull when a chart actually
// renders. ChatChartBlock has its own ErrorBoundary so a malformed spec can't
// white-screen the editor.
const ChatChartBlock = lazy(() => import("../../ChatSidebar/ChatMessage/ChatChartBlock"));

function ChartView(props: NodeViewProps) {
  const { node } = props;
  const language: string = (node.attrs?.language as string) || "";
  const isChart = language === "vega-lite" || language === "vega";

  const code = node.textContent || "";

  if (!isChart) {
    return (
      <NodeViewWrapper as={"pre" as any} className={`language-${language || "plaintext"}`}>
        <NodeViewContent as={"code" as any} />
      </NodeViewWrapper>
    );
  }

  // DEBUG: log what node.textContent actually returns
  console.warn("[ChartView] language=%s, node.childCount=%d, node.textContent.length=%d, first100=%s",
    language, node.childCount, code.length, JSON.stringify(code.slice(0, 100)));

  let spec: Record<string, unknown> | null = null;
  let parseErr: string | null = null;
  const trimmed = code.trim();
  if (trimmed) {
    try {
      spec = JSON.parse(trimmed) as Record<string, unknown>;
    } catch (err) {
      parseErr = err instanceof Error ? err.message : String(err);
    }
  }

  return (
    <NodeViewWrapper className="idea-preview-chart" contentEditable={false}>
      {spec ? (
        <Suspense fallback={<div className="chat-chart-loading">加载图表中…</div>}>
          <ChatChartBlock spec={spec} />
        </Suspense>
      ) : (
        <div className="chat-chart-block chat-chart-block-error">
          <div className="chat-chart-block-header">
            图表 JSON 解析失败:{parseErr || "(empty)"}
            {" "}(code.length={code.length}, childCount={node.childCount})
          </div>
          <pre className="chat-chart-block-raw">{code.slice(0, 800) || "(node.textContent is empty)"}</pre>
        </div>
      )}
    </NodeViewWrapper>
  );
}

export const ChartCodeBlock = CodeBlock.extend({
  addNodeView() {
    return ReactNodeViewRenderer(ChartView);
  },
});
