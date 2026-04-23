import { Children, isValidElement, lazy, Suspense, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import ChatTableBlock from "./ChatTableBlock";

// Vega ships ~800KB — lazy-load so messages without charts don't pay the cost.
const ChatChartBlock = lazy(() => import("./ChatChartBlock"));

/**
 * AssistantText — renders the agent's textual reply.
 *
 * Two formatting modes:
 *   - Short text (no markdown structure): rendered as plain <div> for speed.
 *   - Anything with tables / lists / code / headings / emphasis: passed
 *     through react-markdown + remark-gfm so Analyst's inline results look
 *     like real content. GFM tables get replaced with <ChatTableBlock>.
 *
 * Sanitization is on — rehype-sanitize's default schema + a pass-through
 * for the common inline formatting tags. We don't allow raw HTML here
 * (unlike IdeaEditor) — chat messages should stay safe by default.
 */

const MD_DETECT = /(^#{1,6}\s)|(\n\s*[-*]\s)|(\n\s*\d+\.\s)|(\|[^\n]*\|)|(```)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\[[^\]]+\]\([^)]+\))/m;

function looksLikeMarkdown(s: string): boolean {
  if (!s) return false;
  if (s.length < 3) return false;
  return MD_DETECT.test(s);
}

export default function AssistantText({
  content,
  streaming,
}: {
  content: string;
  streaming?: boolean;
}) {
  if (!content && !streaming) return null;

  const markdown = useMemo(() => looksLikeMarkdown(content), [content]);

  if (!markdown) {
    return <div className="chat-msg-assistant">{content}</div>;
  }

  return (
    <div className="chat-msg-assistant chat-msg-assistant-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeSanitize, chatSanitizeSchema]]}
        components={chatMarkdownComponents}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

// ─── Custom table renderer: collect header + body rows and hand off to ChatTableBlock ─

const chatMarkdownComponents = {
  table({ children }: { children?: unknown }) {
    const { columns, rows } = collectTable(children);
    if (!columns.length) return null;
    return <ChatTableBlock columns={columns} rows={rows} totalRows={rows.length} />;
  },
  // Default markdown renderers for thead/tbody/tr/th/td would produce nested
  // HTML alongside our ChatTableBlock. Return null so only the block renders.
  thead() { return null; },
  tbody() { return null; },
  tr() { return null; },
  th() { return null; },
  td() { return null; },
  // Fenced code blocks: intercept `vega-lite` / `vega` → render as chart.
  code(props: any) {
    const className = props?.className || "";
    const classes = typeof className === "string" ? className.split(/\s+/) : [];
    const langMatch = classes.find((c: string) => c.startsWith("language-"));
    const lang = langMatch ? langMatch.slice("language-".length) : "";
    if (lang === "vega-lite" || lang === "vega") {
      const raw = extractText(props.children);
      try {
        const spec = JSON.parse(raw);
        return (
          <Suspense fallback={<div className="chat-chart-loading">加载图表中…</div>}>
            <ChatChartBlock spec={spec} />
          </Suspense>
        );
      } catch {
        // fall through to default code rendering
      }
    }
    return <code className={className}>{props.children}</code>;
  },
  // Inline code and block code get light styling via CSS — plain passthrough.
  a({ href, children }: any) {
    const isMention = typeof href === "string" && href.startsWith("mention://");
    if (isMention) {
      return (
        <span className="chat-mention-chip" data-href={href}>
          {children}
        </span>
      );
    }
    return (
      <a href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    );
  },
};

function collectTable(children: unknown): {
  columns: Array<{ name: string }>;
  rows: Array<Record<string, unknown>>;
} {
  const columns: Array<{ name: string }> = [];
  const rows: Array<Record<string, unknown>> = [];
  const visit = (node: unknown) => {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!isValidElement(node)) return;
    const type = (node as any).type;
    const typeName =
      typeof type === "string"
        ? type
        : type?.displayName || type?.name || "";
    if (typeName === "thead") {
      const headTrs = flattenRows((node.props as any).children);
      for (const tr of headTrs) {
        const cells = extractCells((tr.props as any).children);
        for (const c of cells) columns.push({ name: stringify(c) });
      }
    } else if (typeName === "tbody") {
      const bodyTrs = flattenRows((node.props as any).children);
      for (const tr of bodyTrs) {
        const cells = extractCells((tr.props as any).children);
        const row: Record<string, unknown> = {};
        cells.forEach((c, i) => {
          const colName = columns[i]?.name ?? `col_${i + 1}`;
          row[colName] = stringify(c);
        });
        rows.push(row);
      }
    } else {
      const childrenProp = (node.props as any)?.children;
      if (childrenProp) Children.toArray(childrenProp).forEach(visit);
    }
  };
  Children.toArray(children as never).forEach(visit);
  return { columns, rows };
}

function flattenRows(children: unknown): any[] {
  const out: any[] = [];
  const walk = (n: unknown) => {
    if (!n) return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (!isValidElement(n)) return;
    const type = (n as any).type;
    const name = typeof type === "string" ? type : type?.displayName || type?.name || "";
    if (name === "tr") out.push(n);
    else walk((n.props as any)?.children);
  };
  walk(children);
  return out;
}

function extractCells(children: unknown): unknown[] {
  const cells: unknown[] = [];
  Children.forEach(children as never, (n: any) => {
    if (!isValidElement(n)) return;
    const type = (n as any).type;
    const name = typeof type === "string" ? type : type?.displayName || type?.name || "";
    if (name === "th" || name === "td") {
      cells.push((n.props as any)?.children);
    }
  });
  return cells;
}

function stringify(x: unknown): string {
  if (x === null || x === undefined) return "";
  if (typeof x === "string") return x;
  if (typeof x === "number" || typeof x === "boolean") return String(x);
  if (Array.isArray(x)) return x.map(stringify).join("");
  if (isValidElement(x)) {
    return stringify((x.props as any)?.children);
  }
  return "";
}

/** Extract the raw text content from a code-block's children. */
function extractText(node: unknown): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (isValidElement(node)) return extractText((node.props as any)?.children);
  return String(node);
}

// Sanitize schema: extend default to allow `data-*` on our mention chip.
const chatSanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    "*": [...(defaultSchema.attributes?.["*"] ?? []), "className", "data*"],
  },
};
