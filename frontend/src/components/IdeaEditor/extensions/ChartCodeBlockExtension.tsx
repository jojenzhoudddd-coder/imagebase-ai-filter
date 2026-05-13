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

  // Concatenate all text children of the code-block node into a single string.
  // node.textContent already does this for inline-text-only nodes, which is
  // what fenced code blocks are.
  const code = useMemo(() => node.textContent || "", [node.textContent]);

  if (!isChart) {
    // Fall back to standard editable code block — NodeViewContent renders the
    // ProseMirror content inside the wrapper. Without it the user couldn't
    // edit / select the code.
    // `as` prop ts-types are limited; cast to any to allow `pre`/`code`.
    return (
      <NodeViewWrapper as={"pre" as any} className={`language-${language || "plaintext"}`}>
        <NodeViewContent as={"code" as any} />
      </NodeViewWrapper>
    );
  }

  // Vega-lite path: try to JSON.parse; on failure show a loading placeholder
  // if the code looks incomplete (likely mid-stream), or the raw text if
  // the JSON is genuinely malformed so the user can debug the spec.
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

  // During streaming writes the code block receives partial JSON that grows
  // token by token. Detect this: the JSON starts with `{` but doesn't end
  // with `}`, or parse error is "Unexpected end of JSON input" — treat as
  // in-progress and show a loading indicator instead of an error.
  const looksIncomplete =
    !spec &&
    trimmed.length > 0 &&
    (parseErr?.includes("end of JSON input") ||
      parseErr?.includes("Unexpected end") ||
      (trimmed.startsWith("{") && !trimmed.endsWith("}")));

  return (
    <NodeViewWrapper className="idea-preview-chart" contentEditable={false}>
      {spec ? (
        <Suspense fallback={<div className="chat-chart-loading">加载图表中…</div>}>
          <ChatChartBlock spec={spec} />
        </Suspense>
      ) : looksIncomplete || !trimmed ? (
        <div className="chat-chart-loading">加载图表中…</div>
      ) : (
        <div className="chat-chart-block chat-chart-block-error">
          <div className="chat-chart-block-header">图表 JSON 解析失败:{parseErr}</div>
          <pre className="chat-chart-block-raw">{code.slice(0, 800)}</pre>
        </div>
      )}
    </NodeViewWrapper>
  );
}

export const ChartCodeBlock = CodeBlock.extend({
  // Keep all default attrs / parseHTML / renderHTML — only swap the view.
  addNodeView() {
    return ReactNodeViewRenderer(ChartView);
  },
});
