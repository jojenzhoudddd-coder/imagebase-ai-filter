import {
  forwardRef, lazy, memo, Suspense, useCallback, useEffect, useImperativeHandle,
  useMemo, useRef, useState,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { parseMentionHref } from "../Mention/mentionSyntax";
import type { ParsedMention } from "../Mention/mentionSyntax";

// Analyst P3: lazy-load the vega-lite chart block so Idea editor doesn't
// pull ~400KB of vega into its bundle until a chart actually appears.
const ChatChartBlock = lazy(
  () => import("../ChatSidebar/ChatMessage/ChatChartBlock"),
);

function LazyIdeaChart({ spec }: { spec: Record<string, unknown> }) {
  return (
    <Suspense fallback={<div className="idea-chart-loading">加载图表中…</div>}>
      <ChatChartBlock spec={spec} />
    </Suspense>
  );
}

/** Platform detection for the heading shortcut — on Mac the primary modifier
 * is Cmd (metaKey); on Windows/Linux it's Ctrl. We reject the "wrong" modifier
 * so e.g. Ctrl+Alt+1 on Mac doesn't accidentally trigger (Ctrl+Alt is reserved
 * for AltGr-style characters on some keyboard layouts). */
const IS_MAC = typeof navigator !== "undefined"
  && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || "");

/** Mention query state — emitted whenever the caret sits immediately after an
 * `@<query>` sequence with no whitespace between `@` and the caret. `atIndex`
 * is the position of the `@` character inside the *source* buffer, NOT the
 * DOM; it's what the picker hands back to `insertMention` below. */
export interface MentionQueryState {
  /** Source-buffer index of the `@` char triggering this query. */
  atIndex: number;
  /** Text typed after the `@`, up to the caret. Can be empty. */
  query: string;
  /** Full viewport-pixel rect of the `@` glyph itself — picker anchors to
   * either bottom-right (default) or bottom-left (flipped) of this rect so
   * it stays glued to the symbol regardless of how long the query gets. */
  atRect: { left: number; right: number; top: number; bottom: number };
}

/** Imperative handle the parent uses to insert a completed mention link. We
 * expose this via a ref rather than taking an extra prop so the parent can
 * trigger the action in a callback without wiring up yet another effect. */
export interface MarkdownPreviewHandle {
  insertMention: (link: string, atIndex: number, queryLen: number) => void;
  /** Return the source-offset that corresponds to the current caret
   * position in the preview DOM, or null if no caret / unmappable.
   * Used by mode-toggle to preserve caret across preview → source. */
  getCaretSourceOffset: () => number | null;
  /** Place the caret at the DOM position that corresponds to the given
   * source-offset. Returns true on success. Used when toggling source →
   * preview. */
  setCaretFromSourceOffset: (offset: number) => boolean;
  /** Returns the contenteditable root element so external overlays
   * (block drag handles, ⋮ menu) can measure block bounding rects. May
   * return null while the component is unmounted. */
  getRoot: () => HTMLDivElement | null;
  /** Force the InnerMarkdown to unmount + remount, picking up the latest
   * `source` prop. Use this AFTER an external (non-editing) source change
   * — e.g. after a block-level mutation succeeds — so the rendered DOM
   * reflects the new content. Do NOT call mid-edit; the InnerMarkdown
   * memo bails during edits to preserve browser-driven DOM mutations,
   * and forcing a remount with stale fiber crashes (see the useEffect
   * comment above). */
  forceRemount: () => void;
}

interface Props {
  source: string;
  onMentionClick: (m: ParsedMention) => void;
  /** When true, the preview surface is `contentEditable` and edits round-trip
   * back into the markdown source via the AST-offset delta algorithm below
   * (see handleInput). Set to false in Source mode — the preview is then a
   * read-only render. */
  editable?: boolean;
  /** Fired whenever an edit is committed to source (debounced through the
   * composition guard so IME doesn't fire a partial character). The arg is
   * the full new markdown source; the parent only needs to persist it. */
  onEditableInput?: (newSource: string) => void;
  /** Placeholder text to render when `source` is empty. Uses the same
   * color token as the textarea ::placeholder (design token
   * --color-text-placeholder, #BBBFC4). */
  placeholder?: string;
  /** Fires in editable mode whenever the caret is at the end of an `@<query>`
   * sequence. `null` means the picker should close. Fires on every relevant
   * key / input / selection change. */
  onMentionQuery?: (state: MentionQueryState | null) => void;
}

/**
 * Markdown preview with optional in-place editing ("preview mode editing").
 *
 * Key invariants:
 *
 * 1. **Operator preservation**: each block element carries data-md-range
 *    (`start-end` source offsets) and data-md-orig-text (the rendered text
 *    snapshot). On edit, we diff current innerText against data-md-orig-text
 *    and splice only the *content* delta into the source — the operator
 *    frame (`# `, `- `, `> `, etc.) never leaves the source buffer.
 *
 * 2. **IME support**: onInput fires mid-composition (browsers buffer the
 *    composed chars). We gate commits on compositionstart/compositionend so
 *    Chinese / Japanese / Korean IMEs don't see their preedit stripped.
 *
 * 3. **No React re-renders during edit**: once the user focuses the surface,
 *    React must not re-render MarkdownPreview from a source prop change —
 *    doing so would clobber the live DOM and the caret. The InnerMarkdown
 *    child is wrapped in React.memo with a comparator that bails while the
 *    user is focused (tracked by `editingRef`). External source changes
 *    (e.g. SSE) land when focus is released.
 *
 * 4. **Anchorable headings**: every rendered h1–h6 gets a deterministic `id`
 *    derived from the heading text (GitHub-style slug + -N disambiguation
 *    within the doc). The algorithm matches the backend's slugger in
 *    mentionRoutes.ts, so `mention://idea-section/<slug>?idea=<id>` URLs
 *    resolve by `#slug` lookup.
 */

const SVG_TAGS = [
  "svg", "g", "path", "rect", "circle", "ellipse", "line", "polygon",
  "polyline", "text", "tspan", "defs", "use", "clipPath", "mask",
  "linearGradient", "radialGradient", "stop", "filter", "feColorMatrix",
  "feGaussianBlur", "feOffset", "feBlend", "feComposite", "feFlood",
  "feMorphology", "feMerge", "feMergeNode", "symbol", "title", "desc",
];

const SVG_ATTRS = [
  "viewBox", "width", "height", "fill", "stroke", "strokeWidth",
  "stroke-width", "strokeLinecap", "stroke-linecap", "strokeLinejoin",
  "stroke-linejoin", "strokeDasharray", "stroke-dasharray", "cx", "cy",
  "r", "rx", "ry", "x", "y", "x1", "y1", "x2", "y2", "d", "points",
  "transform", "opacity", "fillOpacity", "fill-opacity", "strokeOpacity",
  "stroke-opacity", "gradientUnits", "offset", "stopColor", "stop-color",
  "stopOpacity", "stop-opacity", "patternUnits", "xmlns", "id", "class",
  "className", "preserveAspectRatio", "clipPathUnits", "clipPath", "mask",
  "markerEnd", "markerStart", "markerMid", "vectorEffect", "filter",
];

/** react-markdown ships its own URL sanitizer (`defaultUrlTransform`) that
 * hard-codes a protocol allow-list of http/https/irc/ircs/mailto/xmpp and
 * blanks out anything else — including our `mention://` scheme, which would
 * leave chips with `href=""` and break the `parseMentionHref` dispatch below.
 * This override mirrors react-markdown's own logic but treats `mention` as
 * safe as well, and otherwise preserves the default behavior bit-for-bit so
 * we don't accidentally unsafe-ify any other links.
 *
 * Note: this runs BEFORE rehype-sanitize, so rehype-sanitize's `protocols.href`
 * whitelist is still the second line of defense. Adding to react-markdown's
 * allow-list is necessary but not sufficient. */
// 2026-04-29: extended with `data` + `blob` to keep inline images alive after
// react-markdown's own `defaultUrlTransform` runs. (Sanitisation by
// rehype-sanitize is the second-line defense; see `schema.protocols.src`.)
const SAFE_URL_PROTOCOL = /^(https?|ircs?|mailto|xmpp|mention|data|blob)$/i;
function safeUrlTransform(value: string): string {
  const colon = value.indexOf(":");
  const questionMark = value.indexOf("?");
  const numberSign = value.indexOf("#");
  const slash = value.indexOf("/");
  if (
    colon === -1 ||
    (slash !== -1 && colon > slash) ||
    (questionMark !== -1 && colon > questionMark) ||
    (numberSign !== -1 && colon > numberSign) ||
    SAFE_URL_PROTOCOL.test(value.slice(0, colon))
  ) {
    return value;
  }
  return "";
}

const schema: typeof defaultSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames || []), ...SVG_TAGS],
  attributes: {
    ...(defaultSchema.attributes || {}),
    "*": [
      ...((defaultSchema.attributes?.["*"]) || []),
      ...SVG_ATTRS,
      // Allow our AST-offset + orig-text data attributes through the sanitizer.
      // data-md-inline-src is stamped on atomic inline elements (mention chips,
      // strong, em, del, code) and contains the verbatim source slice for that
      // element. commitEdits's rebuild path uses it to preserve markdown syntax
      // around contentEditable=false regions the user can't edit directly.
      "data-md-start", "data-md-end", "data-md-orig-text",
      "data-md-inline-src", "data-md-inline-start", "data-md-inline-end",
    ],
    a: [
      ...((defaultSchema.attributes?.a) || []),
      ["href", /^mention:\/\//, /^https?:\/\//, /^#/, /^\//, /^mailto:/, /^tel:/],
    ],
    // 2026-04-29: GH's defaultSchema.attributes.img is just `[aria, longDesc, src]`
    // — `alt`, `title`, `width`, `height` get stripped, so a stock markdown
    // `![alt](url)` renders an *attribute-less* `<img>` whose `alt` text
    // never reaches the user (some screen readers also refuse to announce
    // unaliased images). We allow the standard set here. `src` itself is
    // still constrained by the `protocols.src` allow-list below.
    img: [
      ...((defaultSchema.attributes?.img) || []),
      "alt", "title", "width", "height", "loading", "referrerpolicy",
      "crossorigin", "decoding",
    ],
    // P1 fix: rehype-sanitize's defaultSchema strips `start` / `type` /
    // `reversed` from <ol> and `value` from <li>, which is why preview was
    // losing ordered list numbering when source had `1. … 2. … 3. …`. The
    // numbers themselves render fine when present from index=1, but custom
    // `start="3"` (e.g. continuing a list across a sub-paragraph) was lost.
    // We allow them here so author-controlled numbering survives sanitisation.
    ol: [
      ...((defaultSchema.attributes?.ol) || []),
      "start", "type", "reversed",
    ],
    li: [
      ...((defaultSchema.attributes?.li) || []),
      "value",
    ],
  },
  protocols: {
    ...(defaultSchema.protocols || {}),
    href: [...((defaultSchema.protocols?.href) || []), "mention"],
    // 2026-04-29: allow `data:` and `blob:` URLs for inline images so
    // pasted screenshots and locally-generated previews render. (Server
    // attachments like `/api/idea-attachments/...` are relative URLs and
    // pass through hast-util-sanitize's "no colon → safe" rule.)
    src: [...((defaultSchema.protocols?.src) || []), "data", "blob"],
  },
};

// Block tags we make editable. Inline tags (strong/em/code/a/...) stay
// contentEditable={false} via the component wrappers below so edits never
// land inside them — the `indexOf` delta algorithm only works cleanly when
// the block's innerText equals a contiguous substring of its source slice.
// (Used informationally; the actual gating happens via wrapBlock/inline wraps.)
// const EDITABLE_BLOCKS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote"]);

/** Slugify — matches the backend `slugify` in mentionRoutes.ts byte-for-byte
 * so an `idea-section` mention produced by the picker resolves by looking up
 * `document.getElementById(slug)` in the rendered doc. Dedupe is per-doc. */
function slugifyBase(raw: string): string {
  const base = raw
    .trim()
    .toLowerCase()
    .replace(/[\s]+/g, "-")
    .replace(/[^a-z0-9\u4e00-\u9fff_\-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "section";
}

/** Inner markdown renderer. Memo'd so parent re-renders (e.g. from status
 * label updates) don't retrigger the markdown parse/walk.
 *
 * When `editable` and `source` is empty (or renders to nothing — e.g. pure
 * whitespace, or trailing `\n\n` after an Enter), we render a single empty
 * `<p>` carrying `data-md-start=0 data-md-end=0`. This guarantees the
 * contenteditable root always has at least one React-managed block for the
 * user to type into: browsers would otherwise insert the first keystroke as
 * a bare text node directly under the root, which React then "double-
 * renders" on its next commit (user's text node + React's new `<p>` both end
 * up as children of the root div, producing duplicated characters and a
 * stranded caret). The empty block also removes the need for the fragile
 * root-fallback codepath in `commitEdits` / `detectMentionAtCaret`. */
const InnerMarkdown = memo(function InnerMarkdown({
  source,
  onMentionClick,
  editable,
  placeholder,
}: {
  source: string;
  onMentionClick: (m: ParsedMention) => void;
  editable: boolean;
  placeholder?: string;
}) {
  // V2.9 #14: remark-breaks 让单个 \n 渲染成 <br>,有序列表 / 无序列表里
  // 用户在两个序号之间敲的 newlines 在 preview 里得到保留(默认 CommonMark
  // 会把 soft line break 折叠成空格 → 列表项视觉上"全连成一行")。
  const remarkPlugins = useMemo(() => [remarkGfm, remarkBreaks], []);
  const rehypePlugins = useMemo(
    () => [rehypeRaw, [rehypeSanitize, schema]] as any,
    []
  );

  // Per-render slug dedupe counter. Headings walk top-down, so this gives
  // us the same "first-with-this-slug, then -2, -3…" ordering as the backend.
  // We create a fresh Map each render and let the closure below mutate it.
  const slugSeenMapRef = useRef<Map<string, number>>(new Map());
  slugSeenMapRef.current = new Map();

  // Wrap a block-level tag so it carries AST offsets + an orig-text snapshot.
  // For h1–h6 we additionally stamp a deterministic `id` for anchor lookup.
  const wrapBlock = useCallback((Tag: keyof JSX.IntrinsicElements) => {
    return ({ node, children, ...rest }: any) => {
      const start = node?.position?.start?.offset;
      const end = node?.position?.end?.offset;
      const origText = flattenChildren(children);
      const props: any = { ...rest };
      if (editable && typeof start === "number" && typeof end === "number") {
        props["data-md-start"] = start;
        props["data-md-end"] = end;
        props["data-md-orig-text"] = origText;
      }
      if (/^h[1-6]$/.test(String(Tag))) {
        const plain = origText.trim();
        const base = slugifyBase(plain);
        const seen = slugSeenMapRef.current.get(base) ?? 0;
        slugSeenMapRef.current.set(base, seen + 1);
        props.id = seen === 0 ? base : `${base}-${seen + 1}`;
      }
      return <Tag {...props}>{children}</Tag>;
    };
  }, [editable]);

  // Pick the verbatim source slice for an inline atomic (chip / strong / em
  // / del / code). Stamped on the rendered element as `data-md-inline-src`
  // so `commitEdits`'s rebuild path can preserve the exact markdown syntax
  // (`**bold**`, `[@foo](mention://…)`, etc.) when the block is rewritten.
  //
  // Without this, the delta algorithm tries `srcSlice.indexOf(origText)`
  // where origText is the flattened form (`bold` / `@foo`) — the source
  // form (`**bold**` / `[@foo](mention://…)`) doesn't match, `indexOf`
  // returns -1, and every edit in a block that contains inline formatting
  // is silently dropped. That's exactly the "can't continue typing after a
  // mention chip" bug we're fixing.
  const inlineSrcFrom = useCallback((node: any): string | undefined => {
    const s = node?.position?.start?.offset;
    const e = node?.position?.end?.offset;
    if (typeof s !== "number" || typeof e !== "number") return undefined;
    return source.slice(s, e);
  }, [source]);

  const components = useMemo(() => {
    const c: any = {
      h1: wrapBlock("h1"),
      h2: wrapBlock("h2"),
      h3: wrapBlock("h3"),
      h4: wrapBlock("h4"),
      h5: wrapBlock("h5"),
      h6: wrapBlock("h6"),
      p: wrapBlock("p"),
      li: wrapBlock("li"),
      blockquote: wrapBlock("blockquote"),
      // Inline formatting must stay atomic so the delta algorithm can cleanly
      // match text. Users switch to Source mode to edit inline markdown.
      // Each one stamps `data-md-inline-src` with its source-side markdown so
      // commitEdits can preserve the syntax when rebuilding the block.
      // 2026-04-29: drop `contentEditable={false}` from strong/em/del so the
      // user can click into them to position the caret. They were originally
      // atomic to keep the chip-aware delta mapper simple, but the price was
      // "I can't put my caret in bold text". Editing inside still produces
      // sensible source updates: the inline-src attr captures the verbatim
      // `**bold**` slice, and `commitEdits`'s rebuild path splices the new
      // flat text into the inline-src window so the surrounding `**`s
      // survive across edits.
      strong: ({ node, children, ...rest }: any) => (
        <strong data-md-inline-src={inlineSrcFrom(node)} {...rest}>{children}</strong>
      ),
      em: ({ node, children, ...rest }: any) => (
        <em data-md-inline-src={inlineSrcFrom(node)} {...rest}>{children}</em>
      ),
      del: ({ node, children, ...rest }: any) => (
        <del data-md-inline-src={inlineSrcFrom(node)} {...rest}>{children}</del>
      ),
      // Image — wrap with the same inline-atomic contract so `commitEdits`
      // sees deletions. Without a wrapper, the bare `<img>` has no
      // data-md-inline-src/start/end attrs and `flattenChildren` returns ""
      // for it, so when the user Backspaces the image out, commitEdits
      // computes a zero-delta and the source still has `![](url)` → the
      // image reappears on the next render. Wrapping in a span with the
      // markdown source captured AND a single-char placeholder text
      // ("⁣" invisible separator) gives the mapper something concrete
      // to splice out when the image is removed. (2026-04-29.)
      img: ({ node, src, alt, ...rest }: any) => {
        const srcSlice = inlineSrcFrom(node);
        return (
          <span
            contentEditable={false}
            data-md-inline-src={srcSlice}
            data-md-inline-start={node?.position?.start?.offset}
            data-md-inline-end={node?.position?.end?.offset}
            className="idea-image-wrap"
            // 2026-04-29: make image selectable on click. Without this,
            // contentEditable=false elements don't reliably accept caret
            // (the click bubbles out to the contenteditable parent which
            // resolves caret based on coordinates, often landing OUTSIDE
            // the image's paragraph). Selecting the wrapper turns the
            // image into a Backspace-deletable atomic — the user clicks
            // it, sees the selection highlight, presses Backspace, and
            // browser native delete fires `input` → commitEdits →
            // rebuildFromDom drops `![alt](url)` from source.
            onClick={(e) => {
              e.stopPropagation();
              const range = document.createRange();
              range.selectNode(e.currentTarget);
              const sel = window.getSelection();
              if (sel) {
                sel.removeAllRanges();
                sel.addRange(range);
              }
            }}
          >
            <img src={src} alt={alt} {...rest} />
          </span>
        );
      },
      code: ({ node, children, className, ...rest }: any) => {
        // Fenced ```vega-lite``` blocks → render as a chart. Falls back to
        // the raw <code> element when the spec doesn't parse as JSON so
        // nothing gets silently swallowed.
        const cls = typeof className === "string" ? className : "";
        if (/^(language-)?vega(-lite)?$/.test(cls.replace(/^language-/, "language-"))
            && cls.includes("language-")) {
          const raw = flattenChildren(children);
          try {
            const spec = JSON.parse(raw);
            return (
              <div
                className="idea-chart-embed"
                contentEditable={false}
                data-md-inline-src={inlineSrcFrom(node)}
              >
                <LazyIdeaChart spec={spec} />
              </div>
            );
          } catch {
            // fall through
          }
        }
        return (
          <code
            contentEditable={false}
            data-md-inline-src={inlineSrcFrom(node)}
            className={className}
            {...rest}
          >
            {children}
          </code>
        );
      },
      // Links / mention chips
      a({ href, children, node, ...rest }: any) {
        if (typeof href === "string") {
          const label = flattenChildren(children);
          const mention = parseMentionHref(href, label);
          if (mention) {
            return (
              <button
                type="button"
                className={`idea-mention-chip idea-mention-chip-${mention.type}`}
                contentEditable={false}
                data-md-inline-src={inlineSrcFrom(node)}
                data-md-inline-start={node?.position?.start?.offset}
                data-md-inline-end={node?.position?.end?.offset}
                onClick={(e) => {
                  e.preventDefault();
                  onMentionClick(mention);
                }}
                title={mention.label}
              >
                @{mention.label}
              </button>
            );
          }
        }
        return (
          <a href={href} target="_blank" rel="noopener noreferrer" contentEditable={false} {...rest}>
            {children}
          </a>
        );
      },
    };
    return c;
  }, [wrapBlock, onMentionClick, inlineSrcFrom]);

  // Empty / trailing-whitespace editable source: render a single empty
  // paragraph with a `<br>` so the browser has a concrete caret target and
  // any typed text lands inside a React-managed block carrying the
  // data-md-* attrs. Without this, the browser inserts a text node directly
  // under the contenteditable root and React's next commit collides with it
  // (orphan text + React's mounted block ⇒ duplicated content, stranded
  // caret, unreliable `@` triggering). The `<br>` is the classic
  // contenteditable "empty line" marker — browsers render a caret-height
  // line box for it without counting it as real content.
  if (editable && source.trim() === "") {
    return (
      <p
        data-md-start={0}
        data-md-end={source.length}
        data-md-orig-text=""
        data-idea-empty-line=""
        data-placeholder={placeholder || undefined}
      >
        <br />
      </p>
    );
  }

  // Non-empty source that ends with a bare paragraph break (source ends
  // with `\n\n` — e.g. right after an Enter-at-end was spliced in by
  // `insertParagraphBreak`). Remark-gfm doesn't emit a trailing empty
  // paragraph for that whitespace, so the caret would have nowhere visible
  // to go after Enter and any subsequent typing would land outside any
  // wrapped block (orphan under the root). Append an empty editable
  // paragraph here so `insertParagraphBreak`'s caret-placement loop has a
  // concrete target and subsequent edits flow through `commitEdits`'
  // normal block path. Its `data-md-start/end` both point at `source.length`
  // so `srcSlice.indexOf("")` resolves deterministically and offset
  // propagation handles the typed delta. */
  const trailingEmpty = editable && /\n\n$/.test(source);

  return (
    <>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
        urlTransform={safeUrlTransform}
      >
        {source}
      </ReactMarkdown>
      {trailingEmpty && (
        <p
          data-md-start={source.length}
          data-md-end={source.length}
          data-md-orig-text=""
          data-idea-empty-line=""
        >
          <br />
        </p>
      )}
    </>
  );
}, (prev, next) => {
  // Bail on re-render entirely while editable. The outer component decides
  // when to remount via `key` — which happens on external source updates
  // (see MarkdownPreview below).
  if (next.editable && prev.editable) return true;
  return prev.source === next.source
    && prev.editable === next.editable
    && prev.placeholder === next.placeholder
    && prev.onMentionClick === next.onMentionClick;
});

/** Map a flat-text caret offset inside `block` to the corresponding source
 * offset (relative to `srcSlice`'s start, i.e. add the block's `data-md-start`
 * on top to get an absolute source offset).
 *
 * We can't just do `srcSlice.indexOf(flatText) + caretInBlock` when the block
 * contains atomic inline elements (mention chips, strong / em / code / del):
 * their flat form (`@foo`, `bold`) isn't a substring of the source form
 * (`[@foo](mention://…)`, `**bold**`), so indexOf returns -1 and every
 * caret-driven operation (Enter splicing \n\n, mode-toggle caret restore)
 * silently bails.
 *
 * Walks the block's children and accumulates two parallel counters: `flat`
 * tracks text-node + atomic-innerText lengths, `srcPos` tracks text-node +
 * atomic-inline-src lengths. When `flat` catches up to the target offset we
 * emit the matching `srcPos`. When the caret lands inside an atomic (which
 * it can't visually since `contentEditable=false` blocks caret entry, but
 * the range's startContainer can still report a descendant text node), we
 * snap to the position just after the atomic — consistent with what the
 * browser will actually place the caret at on the next keystroke. */
function mapFlatOffsetToSource(
  block: HTMLElement,
  flatOffset: number,
  srcSlice: string,
): number {
  const tag = block.tagName.toLowerCase();
  let opPrefixLen = 0;
  if (/^h[1-6]$/.test(tag)) {
    opPrefixLen = (/^#{1,6} /.exec(srcSlice)?.[0] || "").length;
  } else if (tag === "li") {
    opPrefixLen = (/^(?:[-*+]|\d+\.) +/.exec(srcSlice)?.[0] || "").length;
  } else if (tag === "blockquote") {
    opPrefixLen = (/^(?:> ?)+/.exec(srcSlice)?.[0] || "").length;
  }

  let flat = 0;
  let srcPos = opPrefixLen;
  let found = false;
  let result = opPrefixLen;

  const walk = (n: Node): boolean => {
    if (found) return true;
    if (n.nodeType === Node.TEXT_NODE) {
      const text = (n.textContent || "").replace(/\u00A0/g, " ");
      const len = text.length;
      if (flat + len >= flatOffset) {
        result = srcPos + (flatOffset - flat);
        found = true;
        return true;
      }
      flat += len;
      srcPos += len;
      return false;
    }
    if (n instanceof HTMLElement) {
      const inSrc = n.getAttribute("data-md-inline-src");
      if (inSrc != null) {
        const flatLen = (n.innerText || "").replace(/\u00A0/g, " ").length;
        const srcLen = inSrc.length;
        if (flat + flatLen >= flatOffset) {
          // Caret at / inside an atomic — snap to the source position just
          // past it. The atomic is contentEditable=false so the browser
          // won't actually place the caret inside it anyway.
          result = srcPos + srcLen;
          found = true;
          return true;
        }
        flat += flatLen;
        srcPos += srcLen;
        return false;
      }
      if (n.tagName === "BR") return false;
      for (const child of Array.from(n.childNodes)) {
        if (walk(child)) return true;
      }
    }
    return false;
  };

  for (const child of Array.from(block.childNodes)) {
    if (walk(child)) break;
  }

  if (!found) {
    // Caret past the last walked child — place just before any trailing
    // newlines so the splice lands at the logical "end of content" rather
    // than after the block separator.
    const trailingNLLen = (/\n+$/.exec(srcSlice)?.[0] || "").length;
    result = Math.max(opPrefixLen, srcSlice.length - trailingNLLen);
  }

  return result;
}

/** Flatten ReactNode children to plain text for the orig-text snapshot.
 * Must mirror what the browser will put in innerText — mention chips render
 * as `@label`, so we respect that. Images render as a single replacement
 * char so deleting the `<img>` produces a non-zero innerText delta and
 * `commitEdits` can splice the source. */
function flattenChildren(children: any): string {
  if (children == null) return "";
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(flattenChildren).join("");
  if (typeof children === "object" && "props" in children) {
    // Mention chip → "@label"
    const cls: string | undefined = children.props?.className;
    if (typeof cls === "string" && cls.includes("idea-mention-chip")) {
      return `@${children.props?.title ?? ""}`;
    }
    // Image wrapper → single object-replacement char (U+FFFC). Picked
    // because it matches what browsers put in `innerText` for <img>
    // — keeping flat-vs-DOM consistent so commitEdits sees a delta when
    // the <img> is deleted. (2026-04-29.)
    if (typeof cls === "string" && cls.includes("idea-image-wrap")) {
      return "￼";
    }
    // 2026-04-29: at wrapBlock("p") time the child is still the
    // unrendered react-markdown component wrapper — `children.type` is
    // the function we registered in `components.img`, NOT the literal
    // string "img". The string-equal check fails. Detect images by their
    // distinctive props (`src` is mandatory on `<img>`, plus there's no
    // sane non-image React element a paragraph would receive a `src` on),
    // and substitute the same replacement char.
    if (children.props && typeof children.props.src === "string") {
      return "￼";
    }
    return flattenChildren(children.props?.children);
  }
  return "";
}

const MarkdownPreview = forwardRef<MarkdownPreviewHandle, Props>(function MarkdownPreview({
  source,
  onMentionClick,
  editable = false,
  onEditableInput,
  placeholder,
  onMentionQuery,
}, ref) {
  const rootRef = useRef<HTMLDivElement>(null);
  // True while the user has focus inside the editable surface. Drives the
  // "don't re-render mid-edit" guard — we bump `renderToken` only when we
  // explicitly need InnerMarkdown to re-render in place (e.g. after a
  // heading-level shortcut restructures the block).
  const editingRef = useRef(false);
  // Composition guard for IME — onInput fires during preedit (e.g. while
  // typing pinyin) and would commit half-formed characters. We defer until
  // compositionend.
  const composingRef = useRef(false);
  // Snapshot of the source we last rendered. All delta splicing computes
  // off this (not the stale `source` prop which might be updated by our own
  // last onEditableInput call). Updated on every commit.
  const sourceSnapshotRef = useRef(source);

  const onMentionQueryRef = useRef(onMentionQuery);
  useEffect(() => { onMentionQueryRef.current = onMentionQuery; }, [onMentionQuery]);

  // Render token — incremented whenever we *need* InnerMarkdown to remount
  // mid-edit (heading shortcut, paste-as-structured-markdown, …). Normal
  // character edits DON'T bump this; they flow through commitEdits which
  // splices text back into the source but keeps the DOM as-is (the memo
  // comparator bails on re-render while `editable`). Using React `key` makes
  // the remount deterministic and sidesteps the memo entirely.
  const [renderToken, setRenderToken] = useState(0);

  // If source changes *externally* (tab switch, SSE, programmatic
  // setContent from a block-level mutation, etc.) while we're NOT editing,
  // re-snapshot. We deliberately do NOT bump `renderToken` here anymore.
  //
  // Why: bumping renderToken forces InnerMarkdown to unmount + remount.
  // While the user has been editing, the contenteditable contract lets
  // the browser mutate DOM directly (Backspace, native Enter, IME, ...).
  // The InnerMarkdown memo bails on every edit-time render to *keep* the
  // browser's DOM mutations from being clobbered, so React's fiber for
  // InnerMarkdown gets STALE — it still records the children that were
  // there at last commit, while the actual DOM has fewer (or different)
  // children. When something later forces a remount, React's unmount
  // path walks the stale fiber and calls `removeChild` on nodes that
  // are no longer in the DOM → `NotFoundError: The node to be removed
  // is not a child of this node` → page crash.
  //
  // For programmatic source changes that REALLY need a re-render (e.g.
  // BlockOverlays' move/delete/transform success path), the parent now
  // calls `previewRef.current.forceRemount()` explicitly, which is only
  // invoked from controlled non-editing entry points where the DOM
  // hasn't been browser-mutated mid-flight. (2026-04-29.)
  useEffect(() => {
    if (!editingRef.current) {
      sourceSnapshotRef.current = source;
    }
  }, [source]);

  // Initial caret on mount — only auto-focus + place caret when the doc
  // is genuinely EMPTY. For non-empty docs, leave focus + caret untouched
  // so the user can read first and click where they want.
  //
  // Why this changed (2026-04-29): the previous behavior auto-focused the
  // editor and placed the caret at end-of-doc on every mount. For docs
  // ending with a trailing-empty placeholder `<p>` (any source ending in
  // `\n\n`), this dropped the caret BELOW the visible content on a blank
  // line — the user couldn't tell where the cursor was, and reported
  // "光标位置不对，放在 placeholder 后面了". For empty docs the same code
  // collapsed to end of an empty `<p data-idea-empty-line>` whose CSS
  // ::before placeholder text sits in the inline flow, so the visible
  // caret landed past the hint instead of at the start of where typing
  // would go.
  //
  // New rule: empty doc → focus + caret at start of the empty paragraph
  // (so the user can immediately type into the placeholder spot). Non-
  // empty doc → no auto-caret. The user clicks where they want to edit.
  useEffect(() => {
    if (!editable) return;
    let cancelled = false;
    const schedule = (fn: () => void) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => { if (!cancelled) fn(); });
      });
    };
    schedule(() => {
      const root = rootRef.current;
      if (!root) return;
      // Only auto-position when doc is empty (single empty-line placeholder).
      const isEmpty =
        root.childNodes.length === 1 &&
        root.firstElementChild?.hasAttribute("data-idea-empty-line");
      if (!isEmpty) return;
      try {
        root.focus({ preventScroll: true });
        const emptyP = root.firstElementChild as HTMLElement;
        const range = document.createRange();
        // Caret INSIDE the empty <p>, before its <br> child. This way the
        // browser puts the visible caret at the start-of-line position
        // alongside the placeholder text (which is rendered via ::before
        // and is `pointer-events:none; user-select:none`).
        range.setStart(emptyP, 0);
        range.collapse(true);
        const sel = window.getSelection();
        if (sel) {
          sel.removeAllRanges();
          sel.addRange(range);
        }
      } catch {
        // Safe to ignore — first click will place a caret naturally.
      }
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const commitEdits = useCallback(() => {
    if (!editable || !onEditableInput) return;
    if (composingRef.current) return;
    const root = rootRef.current;
    if (!root) return;

    const blocks = root.querySelectorAll<HTMLElement>("[data-md-start]");
    if (blocks.length === 0) {
      // Root fallback: no wrapped blocks yet (empty doc that just got its
      // first character, or content that existed only as loose text nodes
      // under root). Without this sync, sourceSnapshotRef stays empty and
      // `detectMentionAtCaret`'s root-fallback path computes `srcSlice` as
      // "" — `indexOf(currentText)` returns -1 and the picker never opens
      // on the first `@` of a brand-new idea. Mirror `innerText` straight
      // into source; no block structure to preserve in this case.
      const currentText = root.innerText.replace(/\u00A0/g, " ");
      if (currentText !== sourceSnapshotRef.current) {
        sourceSnapshotRef.current = currentText;
        onEditableInput(currentText);
      }
      return;
    }

    const edits: Array<{ start: number; end: number; newSlice: string }> = [];
    blocks.forEach(block => {
      const startStr = block.getAttribute("data-md-start");
      const endStr = block.getAttribute("data-md-end");
      const origText = block.getAttribute("data-md-orig-text") ?? "";
      if (!startStr || !endStr) return;
      const start = Number(startStr);
      const end = Number(endStr);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return;

      // P2 (PR1) — Skip blocks that contain wrapped descendants. For nested
      // lists the OUTER `<li>` covers `2. two\n   - sub-a\n   - sub-b\n`
      // but rebuildFromDom flattens children to plain text, losing the inner
      // operator prefixes. The inner `<li>` blocks have their own data-md-*
      // stamps and will be visited by this same forEach — let them handle
      // their own slice. The outer block's mode-toggle no-op case is
      // already covered by the boundary-stripped equality check below.
      if (block.querySelector("[data-md-start]") !== null) return;

      const currentText = block.innerText.replace(/\u00A0/g, " ");
      if (currentText === origText) return;

      // P2 (PR1) round-trip stabiliser:
      //   Browsers serialise `<li>` innerText with a trailing `\n` for tight
      //   lists and may add other block-level newlines that `origText` (the
      //   flattened MDAST text) doesn't carry. Without this guard, a no-op
      //   preview → source toggle triggers `rebuildFromDom` with stale-looking
      //   `currentText`, which then writes back a slightly different srcSlice
      //   (extra `\n`, lost original placement).
      //   Compare with boundary whitespace stripped — a user's real edit
      //   changes the body, not the boundary whitespace, so stripping doesn't
      //   miss real edits.
      if (currentText.replace(/^\s+|\s+$/g, "") === origText.replace(/^\s+|\s+$/g, "")) {
        return;
      }

      const srcSlice = sourceSnapshotRef.current.slice(start, end);

      // When the block has no atomic inline elements (chips, strong, em,
      // code, del), origText (flattened text) should be a substring of
      // srcSlice (source). Splice the delta directly.
      //
      // When atomics ARE present, srcSlice contains markdown syntax the
      // flattened view can't see — `[@foo](mention://…)` flattens to `@foo`,
      // `**bold**` flattens to `bold`. `indexOf` returns -1, we can't splice.
      // Fall back to rebuilding the block by walking DOM children: text
      // nodes contribute their current textContent, atomic elements
      // contribute their stamped `data-md-inline-src`. That reconstructs
      // source-side syntax exactly, at the cost of assuming the block's
      // operator prefix is stable (valid because contentEditable is
      // scoped to inline content, not block operators).
      const hasInlineAtomic = block.querySelector("[data-md-inline-src]") !== null;

      // Rebuild helper — walks the block's children, using each atomic's
      // stamped `data-md-inline-src` for chip / bold / em / code / del
      // regions and each text node's live textContent for the rest. Wraps
      // with the detected block operator prefix + any trailing newlines so
      // the spliced slice drops cleanly back into source.
      //
      // This path is correct regardless of whether chips are currently
      // present; it's slightly slower than the plain indexOf splice so we
      // only reach for it when indexOf can't find origText inside srcSlice.
      // That happens:
      //   (a) whenever the block currently contains an atomic (origText is
      //       flattened form, srcSlice is source form — they don't match);
      //   (b) immediately after the user Backspaces a chip — the block no
      //       longer has any atomic, but origText still carries the chip's
      //       flattened `@label` while srcSlice still carries
      //       `[@label](mention://…)`. Without this fallback the edit would
      //       be silently dropped and the chip markdown would come back on
      //       next render.
      const rebuildFromDom = (): string => {
        const tag = block.tagName.toLowerCase();
        let opPrefix = "";
        if (/^h[1-6]$/.test(tag)) {
          opPrefix = /^#{1,6} /.exec(srcSlice)?.[0] || "";
        } else if (tag === "li") {
          opPrefix = /^(?:[-*+]|\d+\.) +/.exec(srcSlice)?.[0] || "";
        } else if (tag === "blockquote") {
          opPrefix = /^(?:> ?)+/.exec(srcSlice)?.[0] || "";
        }
        const trailingNL = /\n+$/.exec(srcSlice)?.[0] || "";

        let content = "";
        const walk = (n: Node) => {
          if (n.nodeType === Node.TEXT_NODE) {
            content += (n.textContent || "").replace(/\u00A0/g, " ");
            return;
          }
          if (n instanceof HTMLElement) {
            const inSrc = n.getAttribute("data-md-inline-src");
            if (inSrc != null) {
              content += inSrc;
              return;
            }
            if (n.tagName === "BR") return;
            for (const child of Array.from(n.childNodes)) walk(child);
          }
        };
        for (const child of Array.from(block.childNodes)) walk(child);

        return opPrefix + content + trailingNL;
      };

      let newSlice: string;
      if (!hasInlineAtomic) {
        const idx = srcSlice.indexOf(origText);
        if (idx >= 0) {
          const prefix = srcSlice.slice(0, idx);
          const suffix = srcSlice.slice(idx + origText.length);
          newSlice = prefix + currentText + suffix;
        } else {
          // origText out of sync with srcSlice — e.g. chip just deleted.
          // Fall back to DOM-walk rebuild so the removal lands in source.
          newSlice = rebuildFromDom();
        }
      } else {
        newSlice = rebuildFromDom();
      }

      // If reconstruction produced no actual change (e.g. BR normalization
      // noise), skip the edit.
      if (newSlice === srcSlice) return;

      edits.push({ start, end, newSlice });
      block.setAttribute("data-md-orig-text", currentText);
    });

    // Detect ORPHAN top-level elements — elements directly under root that
    // don't carry `data-md-start`. Browsers introduce these in two main
    // ways the per-block forEach above can't catch:
    //
    //   1. Native Enter splits a paragraph: the ORIGINAL `<p>` keeps its
    //      data-md-start, but the SECOND half lands as a new sibling
    //      `<p>` / `<div>` with no stamps. Without rescue the second-half
    //      content is silently dropped from source.
    //   2. Paste of formatted HTML / multi-line plain text: Chrome inserts
    //      one or more sibling `<p>` / `<div>` after the caret block.
    //      Same outcome — orphan content stays in DOM only, never round-
    //      trips into source, and gets wiped the next time the doc
    //      re-renders or autosave fires with the stale source.
    //
    // Skip BR / TEXT_NODE / known blocks. Only ELEMENT_NODE without
    // data-md-start counts as an orphan worth rescuing. (We also filter
    // out `data-idea-empty-line` placeholders we render ourselves.)
    let hasOrphan = false;
    for (const child of Array.from(root.childNodes)) {
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const el = child as HTMLElement;
      if (el.tagName === "BR") continue;
      if (el.hasAttribute("data-md-start")) continue;
      if (el.hasAttribute("data-idea-empty-line")) continue;
      hasOrphan = true;
      break;
    }

    if (edits.length === 0 && !hasOrphan) return;

    edits.sort((a, b) => b.start - a.start);
    let newSource = sourceSnapshotRef.current;
    for (const e of edits) {
      newSource = newSource.slice(0, e.start) + e.newSlice + newSource.slice(e.end);
    }

    // Propagate the offset shifts back into the block attrs so subsequent
    // edits + mention detection see fresh offsets. The InnerMarkdown memo
    // deliberately bails on re-render while editable (to keep the caret),
    // which means `data-md-start/end` otherwise stay frozen at their last
    // parse values — as soon as any block grows or shrinks, the stale
    // window no longer covers its text, and:
    //   • next `commitEdits` sees `srcSlice.indexOf(origText) === -1` and
    //     silently drops the edit, stranding the DOM ahead of source; and
    //   • `detectMentionAtCaret` hits the same -1 path and fails to open
    //     the picker — which is why typing `@` inside an existing heading
    //     or paragraph (e.g. `# Topic @`) never surfaces the mention menu.
    //
    // Walk blocks in document order (NodeList is already doc-ordered),
    // carrying a running delta. Edited blocks get their end recomputed
    // from the new slice length; unedited blocks simply shift by the
    // accumulated delta so later blocks stay in sync too.
    const editsByStart = new Map<number, number>();
    for (const e of edits) editsByStart.set(e.start, e.newSlice.length);
    let delta = 0;
    blocks.forEach(block => {
      const oldStart = Number(block.getAttribute("data-md-start"));
      const oldEnd = Number(block.getAttribute("data-md-end"));
      if (!Number.isFinite(oldStart) || !Number.isFinite(oldEnd)) return;
      const newLen = editsByStart.get(oldStart);
      block.setAttribute("data-md-start", String(oldStart + delta));
      if (newLen !== undefined) {
        block.setAttribute("data-md-end", String(oldStart + delta + newLen));
        delta += newLen - (oldEnd - oldStart);
      } else {
        block.setAttribute("data-md-end", String(oldEnd + delta));
      }
    });

    // Orphan rescue: walk root in document order, splicing orphan content
    // BETWEEN known-block source slices. Known blocks contribute their
    // (now offset-correct) source range from `newSource`. Orphans contribute
    // a flattened DOM walk with inline atomics preserved through their
    // `data-md-inline-src` stamps + a best-effort block prefix from their
    // tag (heading / blockquote / paragraph). Pure-source-only formatting
    // (e.g. extra blank lines between paragraphs the browser collapsed in
    // DOM) is not preserved across an orphan rescue — acceptable trade-off
    // vs silently losing user-typed / pasted content.
    if (hasOrphan) {
      const flattenOrphan = (n: Node, into: string[]) => {
        if (n.nodeType === Node.TEXT_NODE) {
          into.push((n.textContent || "").replace(/ /g, " "));
          return;
        }
        if (n instanceof HTMLElement) {
          const inSrc = n.getAttribute("data-md-inline-src");
          if (inSrc != null) { into.push(inSrc); return; }
          if (n.tagName === "BR") { into.push("\n"); return; }
          for (const c of Array.from(n.childNodes)) flattenOrphan(c, into);
        }
      };

      const parts: string[] = [];
      const childrenInOrder = Array.from(root.childNodes).filter(
        (n): n is HTMLElement => n.nodeType === Node.ELEMENT_NODE,
      );
      for (const child of childrenInOrder) {
        if (child.tagName === "BR") continue;
        // Known block — both regular wrapped blocks AND the
        // empty-line / trailing-empty placeholders the renderer emits
        // (which carry both `data-md-start` AND `data-idea-empty-line`).
        // The data-md-start path MUST run first so a placeholder that
        // has just absorbed a typed character (or a paste's first line)
        // contributes its actual spliced content from `newSource`,
        // rather than being collapsed to a blank line.
        if (child.hasAttribute("data-md-start")) {
          const s = Number(child.getAttribute("data-md-start"));
          const e = Number(child.getAttribute("data-md-end"));
          if (Number.isFinite(s) && Number.isFinite(e)) {
            // Normalise to a `\n\n` paragraph break so this block's slice
            // joins cleanly with the next part. Why this matters: an
            // empty-doc / trailing-empty placeholder has start=end (e.g.
            // both 0); after a typed character or paste's first line is
            // spliced in, the slice becomes the typed text WITHOUT a
            // trailing newline. Concatenating it with the next orphan
            // would mash them together ("firstsecond" instead of
            // "first\n\nsecond"). Strip whatever trailing newlines the
            // slice already has, append exactly two — idempotent for
            // normal blocks (source paragraphs already end in `\n\n`).
            const slice = newSource.slice(s, e).replace(/\n*$/, "") + "\n\n";
            parts.push(slice);
            continue;
          }
        }
        // Orphan: flatten its DOM with chip preservation, prefix with the
        // markdown operator that matches its tag, ensure paragraph break.
        const buf: string[] = [];
        for (const c of Array.from(child.childNodes)) flattenOrphan(c, buf);
        let content = buf.join("");
        // Drop any trailing newline so we can append our own consistent
        // double-newline paragraph break.
        content = content.replace(/\n+$/, "");
        const tag = child.tagName.toLowerCase();
        let prefix = "";
        if (/^h[1-6]$/.test(tag)) {
          prefix = "#".repeat(Number(tag[1])) + " ";
        } else if (tag === "blockquote") {
          prefix = "> ";
        } else if (tag === "li") {
          prefix = "- ";
        }
        if (content.length === 0 && prefix === "") {
          // Truly empty orphan div — represents a blank line.
          parts.push("\n");
        } else {
          parts.push(prefix + content + "\n\n");
        }
      }
      newSource = parts.join("");
    }

    sourceSnapshotRef.current = newSource;
    onEditableInput(newSource);
  }, [editable, onEditableInput]);

  /** Detect whether the caret sits right after an `@<query>` sequence and
   * fire onMentionQuery accordingly. Runs AFTER commitEdits so the source
   * reflects the typed `@query`, which is how we map DOM caret → source
   * offset. The trigger requires a boundary char (start-of-block / whitespace
   * / punctuation) immediately before the `@` so email-like strings don't
   * spuriously open the picker. */
  const detectMentionAtCaret = useCallback(() => {
    if (!editable) return;
    const cb = onMentionQueryRef.current;
    if (!cb) return;

    const root = rootRef.current;
    if (!root) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) { cb(null); return; }
    const range = sel.getRangeAt(0);
    if (!range.collapsed) { cb(null); return; }

    // Walk up to the block that owns our caret. Falls back to the editable
    // root when no `data-md-start` wrapper exists — this is the empty-
    // document case where the user types the very first `@` before any
    // paragraph block has been materialized (the bare text node lives
    // directly under root). Without this fallback the first `@` in a new
    // idea would silently not trigger the picker.
    let node: Node | null = range.startContainer;
    let block: HTMLElement | null = null;
    while (node && node !== root) {
      if (node instanceof HTMLElement && node.hasAttribute("data-md-start")) {
        block = node;
        break;
      }
      node = node.parentNode;
    }
    const isRootFallback = !block;
    const container: HTMLElement | null = block ?? (root.contains(range.startContainer) ? root : null);
    if (!container) { cb(null); return; }

    // Caret offset inside the container's innerText (chips flatten to "@label").
    const pre = document.createRange();
    pre.selectNodeContents(container);
    try {
      pre.setEnd(range.endContainer, range.endOffset);
    } catch {
      cb(null); return;
    }
    const caretInBlock = pre.toString().replace(/\u00A0/g, " ").length;
    const currentText = container.innerText.replace(/\u00A0/g, " ");
    const before = currentText.slice(0, caretInBlock);

    // Any `@` triggers the picker — no email guard. Typing `Heading@` or
    // `word@` should open mentions directly after existing text; users who
    // actually want to type an email address just see an empty picker they
    // dismiss with Esc. The old `[^A-Za-z0-9_]@` boundary wrongly blocked
    // the most common case (mentioning after a heading or inline word).
    const m = /@([^\s@\n]*)$/.exec(before);
    if (!m) { cb(null); return; }
    const query = m[1];
    const atInBlockText = m.index;

    // Map container-text offset → source-buffer offset.
    //   Normal path (wrapped block): blockStart/End from data-md-*.
    //   Fallback path (root): whole source corresponds to root's text, so
    //   offsets [0, source.length] are the implicit block range.
    let blockStart: number;
    let blockEnd: number;
    if (isRootFallback) {
      blockStart = 0;
      blockEnd = sourceSnapshotRef.current.length;
    } else {
      blockStart = Number(container.getAttribute("data-md-start"));
      blockEnd = Number(container.getAttribute("data-md-end"));
      if (!Number.isFinite(blockStart) || !Number.isFinite(blockEnd)) { cb(null); return; }
    }
    const srcSlice = sourceSnapshotRef.current.slice(blockStart, blockEnd);
    const origIdx = srcSlice.indexOf(currentText);
    if (origIdx < 0) { cb(null); return; }

    const atIndex = blockStart + origIdx + atInBlockText;

    // Pixel rect of the `@` glyph itself, not the caret — so the picker
    // stays glued to `@` as the user types the query. We build a range
    // spanning exactly the `@` character by walking back `query.length + 1`
    // characters from the caret container (which is how the regex already
    // located it). Common case: caret is inside a single text node and the
    // walk is a one-liner `setStart(container, endOffset - query.length - 1)`.
    // Fall back to the caret rect on any oddness (cross-node, detached, etc.).
    let atRectBox: { left: number; right: number; top: number; bottom: number } | null = null;
    try {
      const endC = range.endContainer;
      const endO = range.endOffset;
      if (endC.nodeType === Node.TEXT_NODE) {
        const tn = endC as Text;
        const atStart = endO - query.length - 1; // position of `@`
        const atEnd = atStart + 1;               // position right after `@`
        if (atStart >= 0 && atEnd <= tn.length) {
          const atR = document.createRange();
          atR.setStart(tn, atStart);
          atR.setEnd(tn, atEnd);
          const r = atR.getBoundingClientRect();
          // Range#getBoundingClientRect can union across lines on wrap; we
          // want the last line's rect so the picker sits right under the `@`.
          const rects = atR.getClientRects();
          const last = rects.length > 0 ? rects[rects.length - 1] : r;
          if (last.width || last.height) {
            atRectBox = { left: last.left, right: last.right, top: last.top, bottom: last.bottom };
          }
        }
      }
    } catch { /* fall through */ }

    if (!atRectBox) {
      let rect: DOMRect;
      try {
        rect = range.getBoundingClientRect();
        if (rect.top === 0 && rect.left === 0 && rect.width === 0 && rect.height === 0) {
          rect = container.getBoundingClientRect();
        }
      } catch {
        rect = container.getBoundingClientRect();
      }
      // No measured `@` width — pretend the glyph is zero-wide at the caret
      // so the bottom-right and bottom-left anchors collapse to the same
      // point (picker still flips sensibly near the right edge).
      atRectBox = { left: rect.left, right: rect.left, top: rect.top, bottom: rect.bottom };
    }

    cb({ atIndex, query, atRect: atRectBox });
  }, [editable]);

  const handleInput = useCallback(() => {
    if (composingRef.current) return;
    commitEdits();
    detectMentionAtCaret();
  }, [commitEdits, detectMentionAtCaret]);

  const handleCompositionEnd = useCallback(() => {
    composingRef.current = false;
    commitEdits();
    detectMentionAtCaret();
  }, [commitEdits, detectMentionAtCaret]);

  const handleCompositionStart = useCallback(() => {
    composingRef.current = true;
  }, []);

  const handleFocus = useCallback(() => {
    editingRef.current = true;
    sourceSnapshotRef.current = source;
  }, [source]);

  const handleBlur = useCallback(() => {
    editingRef.current = false;
    composingRef.current = false;
    commitEdits();
    // Don't clear the mention picker on blur — the blur fires when the user
    // clicks a picker item, and we want the picker to stay alive through the
    // selection handshake. The picker's own outside-click handler closes it
    // otherwise.
  }, [commitEdits]);

  const applyHeadingLevel = useCallback((level: 0 | 1 | 2 | 3 | 4 | 5 | 6) => {
    if (!editable || !onEditableInput) return;
    if (composingRef.current) return;
    const root = rootRef.current;
    if (!root) return;
    try {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      let node: Node | null = sel.getRangeAt(0).startContainer;
      let block: HTMLElement | null = null;
      while (node && node !== root) {
        if (node instanceof HTMLElement && node.hasAttribute("data-md-start")) {
          block = node;
          break;
        }
        node = node.parentNode;
      }
      if (!block) return;
      const tag = block.tagName.toLowerCase();
      // Heading toggle applies cleanly to paragraphs and existing headings.
      // For list items and blockquotes we'd need to restructure the outer
      // container (pull the line out of the list, etc.), which is out of
      // scope here — silently bail so the user knows nothing happened.
      if (tag !== "p" && !/^h[1-6]$/.test(tag)) return;

      const start = Number(block.getAttribute("data-md-start"));
      const end = Number(block.getAttribute("data-md-end"));
      if (!Number.isFinite(start) || !Number.isFinite(end)) return;

      commitEdits();

      // commitEdits may have shifted this block's offsets. Re-read after flush.
      const freshStart = Number(block.getAttribute("data-md-start"));
      const freshEnd = Number(block.getAttribute("data-md-end"));
      const s = Number.isFinite(freshStart) ? freshStart : start;
      const e = Number.isFinite(freshEnd) ? freshEnd : end;

      let slice = sourceSnapshotRef.current.slice(s, e);
      let trailingNewline = "";
      if (slice.endsWith("\n")) {
        trailingNewline = "\n";
        slice = slice.slice(0, -1);
      }
      const stripped = slice.replace(/^#{1,6}\s+/, "");
      const newPrefix = level === 0 ? "" : "#".repeat(level) + " ";
      const newSlice = newPrefix + stripped + trailingNewline;

      if (newSlice === sourceSnapshotRef.current.slice(s, e)) return;

      const newSource =
        sourceSnapshotRef.current.slice(0, s) +
        newSlice +
        sourceSnapshotRef.current.slice(e);
      sourceSnapshotRef.current = newSource;
      onEditableInput(newSource);
      setRenderToken(t => t + 1);

      requestAnimationFrame(() => {
        const r = rootRef.current;
        if (!r) return;
        const newBlock = r.querySelector<HTMLElement>(`[data-md-start="${s}"]`);
        if (!newBlock) return;
        try {
          const range = document.createRange();
          range.selectNodeContents(newBlock);
          range.collapse(false);
          const cur = window.getSelection();
          if (cur) {
            cur.removeAllRanges();
            cur.addRange(range);
          }
        } catch { /* caret restore best-effort */ }
      });
    } catch (err) {
      // Defensive: never let a caret / selection API quirk crash React.
      // eslint-disable-next-line no-console
      console.warn("[IdeaEditor] applyHeadingLevel failed:", err);
    }
  }, [editable, onEditableInput, commitEdits]);

  /** Splice a paragraph break into the source buffer at the caret's source
   * offset, then force `InnerMarkdown` to remount so the DOM reflects the
   * new block structure. Invoked from `handleKeyDown` on Enter.
   *
   * Why we intercept Enter instead of letting the browser handle it:
   * Chrome's default Enter inside a contenteditable creates either a
   * `<div><br></div>` sibling or splits the current block into a naked
   * element pair — neither of which carries the `data-md-start` attribute
   * that `commitEdits` and `detectMentionAtCaret` rely on. The orphan
   * content then (a) never makes it back into source, (b) breaks subsequent
   * `@` detection because the root-fallback `srcSlice` no longer contains
   * the DOM's `innerText`, and (c) visually reflows unpredictably once any
   * later re-parse reconciles the stale source. Splicing `\n\n` into
   * source ourselves keeps source as the single source of truth — the
   * remount replays markdown parsing and the picker continues to work. */
  const insertParagraphBreak = useCallback(() => {
    if (!editable || !onEditableInput) return;
    if (composingRef.current) return;
    const root = rootRef.current;
    if (!root) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    // Flush any pending input edits so sourceSnapshotRef is current before
    // we map the caret through it.
    try {
      commitEdits();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[IdeaEditor] commitEdits before Enter failed:", err);
    }

    try {
    // Walk to the nearest wrapped block (or root) to map caret → source.
    let node: Node | null = range.startContainer;
    let block: HTMLElement | null = null;
    while (node && node !== root) {
      if (node instanceof HTMLElement && node.hasAttribute("data-md-start")) {
        block = node;
        break;
      }
      node = node.parentNode;
    }
    const isRootFallback = !block;
    const container: HTMLElement | null =
      block ?? (root.contains(range.startContainer) ? root : null);
    if (!container) return;

    const pre = document.createRange();
    pre.selectNodeContents(container);
    try {
      pre.setEnd(range.endContainer, range.endOffset);
    } catch {
      return;
    }
    const caretInBlock = pre.toString().replace(/\u00A0/g, " ").length;
    const currentText = container.innerText.replace(/\u00A0/g, " ");

    let blockStart: number;
    let blockEnd: number;
    if (isRootFallback) {
      blockStart = 0;
      blockEnd = sourceSnapshotRef.current.length;
    } else {
      blockStart = Number(container.getAttribute("data-md-start"));
      blockEnd = Number(container.getAttribute("data-md-end"));
      if (!Number.isFinite(blockStart) || !Number.isFinite(blockEnd)) return;
    }
    const srcSlice = sourceSnapshotRef.current.slice(blockStart, blockEnd);
    // Use the chip-aware mapper — plain `indexOf(currentText)` fails the
    // instant the block contains a mention chip or any other inline atomic
    // (the flattened `@Foo` form doesn't appear in the source-form
    // `[@Foo](mention://…)`), and the Enter key would silently no-op for
    // every block with a chip in it. That was the "Enter doesn't work after
    // inserting a mention" bug.
    const offsetInSlice = isRootFallback
      ? (srcSlice.indexOf(currentText) >= 0
          ? srcSlice.indexOf(currentText) + caretInBlock
          : caretInBlock)
      : mapFlatOffsetToSource(container, caretInBlock, srcSlice);
    const sourceOffset = blockStart + offsetInSlice;

    // 2026-04-29 take-2: drop the ZWSP-landing-pad approach.
    //
    // Why the ZWSP plan failed: it created a 1-char (`​`) paragraph that the
    // parser preserved, but the side-effects were ugly:
    //   • Backspace required two presses — first to delete the invisible
    //     ZWSP, second to actually merge the now-empty paragraph into the
    //     previous one. From the user's POV, the line "wouldn't delete" on
    //     the first press because nothing visibly changed.
    //   • The second Enter after a partial-Backspace hit a state where the
    //     block's `data-md-orig-text="​"` no longer matched its innerText
    //     and the splice path resolved to bogus offsets — page crash.
    //
    // New approach: insert a SINGLE `\n` at the caret. With `remark-breaks`
    // (already enabled in remarkPlugins), `\n` inside a paragraph renders
    // as a `<br>` soft break — visible new line, caret naturally lands
    // after it, Backspace deletes the `\n` cleanly. No ZWSP, no orphan
    // blocks, no two-step delete.
    //
    // To get a hard paragraph break, the user just presses Enter twice:
    // the second `\n` makes `\n\n`, which IS a markdown paragraph break,
    // and the parser splits on it naturally. That's the canonical
    // markdown semantics — let it do the work instead of fighting it.
    const src = sourceSnapshotRef.current;
    // Clamp the computed source offset to the actual source bounds.
    // After a sequence like "Enter → Backspace → Enter", the block's
    // data-md-orig-text can lag behind its innerText, which makes the
    // mapFlatOffsetToSource math overshoot or undershoot. An out-of-
    // bounds splice produces malformed markdown that has crashed the
    // renderer in past sessions ("press Enter twice → page blanks").
    // Clamping keeps us in the legal range; the worst-case visual is
    // a slightly off caret, which is recoverable.
    const safeOffset = Math.max(0, Math.min(sourceOffset, src.length));
    const before = src.slice(0, safeOffset);
    const after = src.slice(safeOffset);
    const splice = "\n";
    const caretTargetOffset = safeOffset + splice.length;

    const newSource = before + splice + after;
    sourceSnapshotRef.current = newSource;
    onEditableInput(newSource);
    // Force a fresh parse so the new <br> / paragraph structure
    // materialises — the InnerMarkdown memo otherwise holds onto the
    // pre-Enter DOM forever.
    setRenderToken(t => t + 1);

    // Restore caret at the new source position. After remount, find the
    // block whose source range contains `targetOffset` and place the caret
    // accordingly. If we can't locate one (target is past the last block),
    // fall back to end of the editable root — still better than losing the
    // caret entirely.
    const targetOffset = caretTargetOffset;
    requestAnimationFrame(() => {
      const r = rootRef.current;
      if (!r) return;
      const candidates = Array.from(
        r.querySelectorAll<HTMLElement>("[data-md-start]"),
      );
      let host: HTMLElement | null = null;
      let placeAtStart = true;
      for (const b of candidates) {
        const bStart = Number(b.getAttribute("data-md-start"));
        const bEnd = Number(b.getAttribute("data-md-end"));
        if (!Number.isFinite(bStart) || !Number.isFinite(bEnd)) continue;
        if (targetOffset >= bStart && targetOffset <= bEnd) {
          host = b;
          placeAtStart = targetOffset === bStart;
          break;
        }
        if (targetOffset < bStart) {
          host = b;
          placeAtStart = true;
          break;
        }
      }
      try {
        const range = document.createRange();
        if (host) {
          range.selectNodeContents(host);
          range.collapse(placeAtStart);
        } else {
          range.selectNodeContents(r);
          range.collapse(false);
        }
        const s = window.getSelection();
        if (s) {
          s.removeAllRanges();
          s.addRange(range);
        }
        r.focus({ preventScroll: true });
      } catch { /* ignore */ }
    });
    } catch (err) {
      // Defensive: a Selection / Range API throw (cross-browser quirks, odd
      // caret positions around non-editable atomics, etc.) must not crash
      // the whole editor. Log and bail — the user's keypress is lost but
      // the editor stays alive.
      // eslint-disable-next-line no-console
      console.warn("[IdeaEditor] insertParagraphBreak failed:", err);
    }
  }, [editable, onEditableInput, commitEdits]);

  /** Keyboard handler — Cmd+Alt+[0..6] on Mac, Ctrl+Alt+[0..6] on Windows/Linux
   * sets the heading level of the block at the caret. Platform-aware: we
   * require the *correct* primary modifier and explicitly reject the other,
   * so a cross-platform muscle-memory miss (e.g. Ctrl on Mac) doesn't fire.
   *
   * Important: when Alt is held on macOS, `e.key` becomes the Option-modified
   * character (e.g. Alt+1 → "¡", Alt+2 → "™"), so matching on `e.key` silently
   * fails. We key off `e.code` (`Digit0`..`Digit6`) which stays stable across
   * modifier states, and fall back to `e.key` for keyboard layouts whose
   * `code` value may not follow the US layout convention (e.g. AZERTY top row
   * still reports `Digit1` but some embedded keyboards don't).
   *
   * Enter is intercepted so Chrome / Safari don't insert unattached
   * `<div><br></div>` siblings (see `insertParagraphBreak`). Shift+Enter is
   * left alone — users who want a `<br>` soft break inside the same block
   * still expect native behavior there. */
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    // 2026-04-29 take-3: stop intercepting Enter.
    //
    // History of this code:
    //   1. Originally we intercepted Enter, splice `\n\n` into source via
    //      `insertParagraphBreak()`, and bumped `renderToken` to force a
    //      remount so the new paragraph structure was visible.
    //   2. Today's session tried two splice variants (ZWSP landing pad
    //      then plain `\n`) — both still required the renderToken bump
    //      to flush the new render.
    //   3. The renderToken bump unmounts the InnerMarkdown subtree. Its
    //      memo bails on every edit-time render (to keep the DOM stable
    //      under user keystrokes), so the React fiber drifts from the
    //      actual DOM whenever the browser handles a Backspace etc.
    //      When the next Enter then forces a remount, React walks the
    //      stale fiber and calls `removeChild` on nodes the browser has
    //      already removed → `NotFoundError` → the entire React tree
    //      blanks.
    //
    // Browser's native Enter inside contentEditable inserts a `<br>` (or
    // splits the paragraph) directly into the DOM. The follow-up `input`
    // event flows through `handleInput` → `commitEdits`, which captures
    // the new innerText and splices it back into source via the existing
    // delta-based path. No fiber bump needed because we never need to
    // re-render: the DOM the browser produced IS the new state. Memo
    // bails on the next React render → DOM stays as-is → consistent.
    //
    // Trade-off: native Enter behavior varies slightly across browsers
    // (Chrome usually splits into `<div>`s, Firefox into `<br>`s). Both
    // round-trip cleanly through innerText → source. Inline atomics
    // (mention chips) are still `contentEditable=false` so the user
    // can't accidentally split inside one.
    //
    // Shift+Enter behavior is unchanged: native, inserts `<br>`.

    // Backspace chip deletion — when the caret sits immediately after a
    // mention chip (contentEditable=false), the browser's default Backspace
    // is a no-op because there's nothing editable to remove at that offset.
    // Detect that case, drop the chip node ourselves, then flush through
    // commitEdits which (thanks to the chip-aware rebuild path) syncs the
    // source without the chip's markdown link.
    if (
      e.key === "Backspace" &&
      !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey &&
      editable && !composingRef.current
    ) {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        // 2026-04-29: also catch the "user clicked an image and the entire
        // wrap is selected" case. Native Backspace would delete the wrap
        // from DOM but our source-splicer doesn't notice the whole-block
        // disappeared. Detect the exact selection of an idea-image-wrap
        // and route through the same source-splice path the
        // collapsed-Backspace branch uses.
        if (
          !range.collapsed &&
          range.startContainer === range.endContainer &&
          range.startContainer.nodeType === Node.ELEMENT_NODE &&
          range.endOffset - range.startOffset === 1
        ) {
          const selectedNode = (range.startContainer as Element).childNodes[
            range.startOffset
          ];
          if (
            selectedNode instanceof HTMLElement &&
            selectedNode.classList.contains("idea-image-wrap")
          ) {
            // Promote into the collapsed-Backspace path by manually
            // arranging the right state: pick the wrap as the "atomic
            // chip", and stash its parent block for whole-block deletion
            // so the source splice fires.
            e.preventDefault();
            const wrap = selectedNode as HTMLElement;
            const parentBlock = wrap.closest("p, h1, h2, h3, h4, h5, h6, blockquote, li") as HTMLElement | null;
            if (parentBlock && onEditableInput) {
              const bs = Number(parentBlock.getAttribute("data-md-start"));
              const be = Number(parentBlock.getAttribute("data-md-end"));
              if (Number.isFinite(bs) && Number.isFinite(be)) {
                const src = sourceSnapshotRef.current;
                let extEnd = be;
                while (extEnd < src.length && src.charCodeAt(extEnd) === 10) extEnd++;
                // Drop the wrap then drop the parent block if image-only.
                wrap.remove();
                const onlyEmptyTextLeft = Array.from(parentBlock.childNodes).every(
                  (n) =>
                    n.nodeType === Node.TEXT_NODE &&
                    ((n as Text).data || "").trim() === "",
                );
                if (onlyEmptyTextLeft && parentBlock.parentNode) {
                  parentBlock.parentNode.removeChild(parentBlock);
                  // Splice source.
                  const newSrc = src.slice(0, bs) + src.slice(extEnd);
                  sourceSnapshotRef.current = newSrc;
                  onEditableInput(newSrc);
                  // Shift remaining offsets.
                  const delta = extEnd - bs;
                  if (rootRef.current) {
                    rootRef.current
                      .querySelectorAll<HTMLElement>("[data-md-start]")
                      .forEach((el) => {
                        const s = Number(el.getAttribute("data-md-start"));
                        const e2 = Number(el.getAttribute("data-md-end"));
                        if (Number.isFinite(s) && s >= extEnd) {
                          el.setAttribute("data-md-start", String(s - delta));
                        }
                        if (Number.isFinite(e2) && e2 >= extEnd) {
                          el.setAttribute("data-md-end", String(e2 - delta));
                        }
                      });
                  }
                } else {
                  // Wrap was inside a paragraph that has other content;
                  // commitEdits' rebuildFromDom path will pick up the
                  // missing inline-src and splice correctly.
                  commitEdits();
                }
                // Place caret where the wrap was.
                try {
                  const r = document.createRange();
                  if (parentBlock.parentNode) {
                    r.selectNodeContents(parentBlock.parentNode);
                  }
                  r.collapse(true);
                  sel.removeAllRanges();
                  sel.addRange(r);
                } catch { /* ignore */ }
                return;
              }
            }
          }
        }
        if (range.collapsed) {
          // Two possible caret-after-atomic shapes:
          //  (a) caret is at offset 0 of a text node whose previousSibling is an atomic
          //  (b) caret is at index N of an element node, and childNodes[N-1] is an atomic
          // 2026-04-29: extended to also catch image wrappers (idea-image-wrap).
          // Without this, Backspace right after an image either silently
          // deletes nothing (atomic is contentEditable=false) or the
          // browser nukes the entire enclosing <p>, both leaving the
          // markdown source's `![alt](url)` orphaned.
          const isAtomic = (el: Element): boolean =>
            el.classList.contains("idea-mention-chip") ||
            el.classList.contains("idea-image-wrap");
          let chip: HTMLElement | null = null;
          const sc = range.startContainer;
          const so = range.startOffset;
          if (sc.nodeType === Node.TEXT_NODE && so === 0) {
            const prev = (sc as Text).previousSibling;
            if (prev instanceof HTMLElement && isAtomic(prev)) {
              chip = prev;
            }
          } else if (sc.nodeType === Node.ELEMENT_NODE && so > 0) {
            const prev = sc.childNodes[so - 1];
            if (prev instanceof HTMLElement && isAtomic(prev)) {
              chip = prev;
            }
          }
          // 2026-04-29: also catch "Backspace at start of a paragraph
          // whose PREVIOUS PARAGRAPH is an image-only paragraph". Native
          // Backspace there would merge the two `<p>`s, which leaves the
          // image embedded inside the merged paragraph and the merged
          // block's data-md-* attrs out of sync — commitEdits ends up
          // with `![alt](url)end` instead of removing the image. Detect
          // this case and delete the image paragraph instead. (Same
          // rule applies if the user has a non-collapsed selection that
          // spans the image — but that's caught natively, so only worry
          // about the merge-from-below case here.)
          if (!chip && range.collapsed) {
            // Find the paragraph the caret currently lives in.
            const ceRoot = rootRef.current;
            let blockEl: HTMLElement | null = null;
            let cur: Node | null = sc;
            while (cur && cur !== ceRoot?.parentNode) {
              if (
                cur instanceof HTMLElement &&
                /^(P|H[1-6]|BLOCKQUOTE|LI)$/.test(cur.tagName)
              ) {
                blockEl = cur;
                break;
              }
              cur = cur.parentNode;
            }
            if (blockEl) {
              // Caret at start of blockEl? Measure by comparing boundary
              // points — direct (container, offset) reference equality
              // fails because the caret's container is usually a text node
              // descendant, not the block element itself, even when the
              // visual position is identical.
              let isAtBlockStart = false;
              try {
                const probe = document.createRange();
                probe.setStart(blockEl, 0);
                probe.setEnd(range.startContainer, range.startOffset);
                isAtBlockStart = probe.toString() === "";
              } catch { /* ignore — leave isAtBlockStart=false */ }
              if (isAtBlockStart) {
                const prevBlock = blockEl.previousElementSibling;
                // Image-only paragraph = a `<p>` whose only meaningful
                // child is `.idea-image-wrap` (we tolerate trailing text
                // nodes that are pure whitespace from markdown rendering).
                if (
                  prevBlock instanceof HTMLElement &&
                  prevBlock.tagName === "P" &&
                  prevBlock.querySelector(":scope > .idea-image-wrap")
                ) {
                  const onlyImage = Array.from(prevBlock.childNodes).every(
                    (n) =>
                      (n instanceof HTMLElement &&
                        n.classList.contains("idea-image-wrap")) ||
                      (n.nodeType === Node.TEXT_NODE &&
                        ((n as Text).data || "").trim() === ""),
                  );
                  if (onlyImage) {
                    // Treat the image paragraph as the atomic to delete.
                    chip = prevBlock.querySelector<HTMLElement>(".idea-image-wrap");
                    // Removing the wrapper alone leaves an empty <p>
                    // behind — clean it up so we don't end up with a
                    // phantom blank line in source.
                    if (chip) {
                      // Stash the parent <p> so we can remove it after
                      // the chip-removal handler below runs.
                      (chip as any).__deleteParentBlockOnRemoval = prevBlock;
                    }
                  }
                }
              }
            }
          }
          if (chip) {
            e.preventDefault();
            const parent = chip.parentNode;
            // Stashed by the image-only-paragraph branch above: when we're
            // deleting an image whose paragraph contains nothing else, also
            // wipe the now-empty paragraph so the source doesn't keep a
            // phantom blank line.
            const parentBlockToWipe: HTMLElement | undefined =
              (chip as any).__deleteParentBlockOnRemoval;
            // For the "delete image-only paragraph" path we ALSO need to
            // splice the source ourselves — `commitEdits` operates on
            // surviving `[data-md-start]` blocks, so a wholesale block
            // deletion (the image's `<p>` is gone, not just modified)
            // would leave the source's `![alt](url)\n\n` orphaned.
            // Capture the block's source range BEFORE we mutate the DOM.
            let blockSpliceRange: { start: number; end: number } | null = null;
            if (parentBlockToWipe) {
              const bs = Number(parentBlockToWipe.getAttribute("data-md-start"));
              const be = Number(parentBlockToWipe.getAttribute("data-md-end"));
              if (Number.isFinite(bs) && Number.isFinite(be)) {
                // Extend `end` to swallow the trailing `\n\n` block separator
                // so we don't leave a phantom blank line.
                const src = sourceSnapshotRef.current;
                let extendedEnd = be;
                while (
                  extendedEnd < src.length &&
                  src.charCodeAt(extendedEnd) === 10 // \n
                ) {
                  extendedEnd++;
                }
                blockSpliceRange = { start: bs, end: extendedEnd };
              }
            }
            if (parent) {
              // Capture a reference to whatever sits immediately after the
              // chip so we can place the caret there after removal. If the
              // chip was followed by its rebuild-inserted trailing space,
              // we'll drop that too — leaving `foo | bar` → `foo| bar` reads
              // strange, so we trim exactly one leading space when present.
              const nextNode = chip.nextSibling;
              parent.removeChild(chip);
              if (parentBlockToWipe && parentBlockToWipe.parentNode) {
                // After chip removal, the wrap's host <p> is empty (or
                // pure whitespace). Drop it entirely. Caret stays in the
                // following block (which the user was at the start of).
                parentBlockToWipe.parentNode.removeChild(parentBlockToWipe);
              } else if (nextNode && nextNode.nodeType === Node.TEXT_NODE) {
                const tn = nextNode as Text;
                if (tn.data.startsWith(" ")) {
                  tn.deleteData(0, 1);
                }
                try {
                  const r = document.createRange();
                  r.setStart(tn, 0);
                  r.collapse(true);
                  sel.removeAllRanges();
                  sel.addRange(r);
                } catch { /* ignore */ }
              } else if (parent instanceof HTMLElement) {
                try {
                  const r = document.createRange();
                  r.selectNodeContents(parent);
                  r.collapse(false);
                  sel.removeAllRanges();
                  sel.addRange(r);
                } catch { /* ignore */ }
              }
              if (blockSpliceRange && onEditableInput) {
                // Whole-block deletion: splice the source directly because
                // commitEdits only walks surviving blocks.
                const src = sourceSnapshotRef.current;
                const newSrc =
                  src.slice(0, blockSpliceRange.start) +
                  src.slice(blockSpliceRange.end);
                sourceSnapshotRef.current = newSrc;
                onEditableInput(newSrc);
                // Walk remaining [data-md-start] blocks AFTER the deleted
                // range and shift their offsets back so subsequent
                // commitEdits calls don't compute stale deltas.
                const delta = blockSpliceRange.end - blockSpliceRange.start;
                if (rootRef.current) {
                  rootRef.current
                    .querySelectorAll<HTMLElement>("[data-md-start]")
                    .forEach((el) => {
                      const s = Number(el.getAttribute("data-md-start"));
                      const e2 = Number(el.getAttribute("data-md-end"));
                      if (Number.isFinite(s) && s >= blockSpliceRange!.end) {
                        el.setAttribute("data-md-start", String(s - delta));
                      }
                      if (Number.isFinite(e2) && e2 >= blockSpliceRange!.end) {
                        el.setAttribute("data-md-end", String(e2 - delta));
                      }
                    });
                }
              } else {
                commitEdits();
              }
            }
            return;
          }
        }
      }
    }

    const primary = IS_MAC ? e.metaKey : e.ctrlKey;
    const wrongModifier = IS_MAC ? e.ctrlKey : e.metaKey;
    if (!primary || wrongModifier || !e.altKey || e.shiftKey) return;
    // Prefer e.code so Alt-modified characters on macOS don't mask the digit.
    const codeMatch = /^Digit([0-6])$/.exec(e.code || "");
    const keyMatch = /^[0-6]$/.test(e.key) ? e.key : null;
    const digit = codeMatch ? codeMatch[1] : keyMatch;
    if (!digit) return;
    e.preventDefault();
    applyHeadingLevel(parseInt(digit, 10) as 0 | 1 | 2 | 3 | 4 | 5 | 6);
  }, [applyHeadingLevel, insertParagraphBreak, editable, commitEdits]);

  /** After selection change (arrow keys, clicks) re-evaluate whether we're
   * still on an `@<query>` — this closes the picker when the user navigates
   * away without typing and reopens it if they cursor back into one. */
  const handleKeyUp = useCallback(() => {
    if (composingRef.current) return;
    detectMentionAtCaret();
  }, [detectMentionAtCaret]);

  const handleMouseUp = useCallback(() => {
    detectMentionAtCaret();
  }, [detectMentionAtCaret]);

  /** Defensive copy handler — native Cmd/Ctrl+C copies the selected text
   * as expected; this callback only guarantees the caret + selection stay
   * live afterwards so the user sees a visible cursor and can continue
   * copying or typing without having to click back in.
   *
   * Why this is needed: a copy keystroke can overlap with an in-flight
   * autosave debounce firing `setSaveStatus`. The resulting parent
   * re-render reconciles the contentEditable wrapper, and on some
   * browsers that reconciliation drops the live selection even when the
   * same `<div>` node is kept. We snapshot the selection on copy and
   * re-apply it in rAF if it got cleared. No-op on the happy path. */
  /** Paste handler — neutralises rich-clipboard HTML so it round-trips cleanly
   * through `commitEdits`. Without this, Chrome inserts whatever HTML happens
   * to be on the clipboard (e.g. `<p>`, `<h1>`, `<table>`, `<span style=...>`
   * from a webpage / Word) directly into the contenteditable. Most of those
   * sibling elements have no `data-md-start` so the orphan-rescue path in
   * `commitEdits` would still handle them, but the rescue's flatten loop
   * loses any inline atomics the pasted HTML happened to use AND throws away
   * potentially useful semantic structure (lists, code blocks, etc.) by
   * collapsing to plain text anyway.
   *
   * We just take `text/plain` from the clipboard and `execCommand("insertText")`
   * — Chrome inserts literal characters at the caret (splitting blocks on `\n`
   * naturally; `commitEdits` + orphan rescue then catch the result). No HTML
   * sneaks in, no styles, no images-as-base64, no surprise rich text. Same
   * behaviour Notion / Linear etc. settled on for their plain-text editors.
   *
   * Image paste from screenshot tools (`image/png`) is intentionally NOT
   * supported here — that goes through the existing drag-drop / attachment
   * upload pipeline. A dedicated screenshot-paste path can land in a follow-up.
   */
  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLDivElement>) => {
    if (!editable || !onEditableInput) return;
    const text = e.clipboardData?.getData("text/plain");
    if (text == null) return;
    e.preventDefault();
    // execCommand("insertText") is the simplest API that:
    //   • respects current selection (replaces selected range, or inserts
    //     at caret if collapsed),
    //   • emits a synthetic `input` event so `handleInput` → `commitEdits`
    //     fires next tick and rolls the new text into source.
    // It IS deprecated, but every Chromium-based browser still supports
    // it — Notion / Slack / Linear all rely on it for the same reason.
    // The replacements (`InputEvent` / Selection API + manual DOM mutation)
    // either don't fire `input` consistently or skip undo-stack integration.
    try {
      document.execCommand("insertText", false, text);
    } catch {
      // Extremely defensive — execCommand is missing or threw. Fall back
      // to a manual range insertion. The browser still fires `input` after
      // a `Range.deleteContents` + `Range.insertNode`, so commitEdits picks
      // up the change.
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      range.deleteContents();
      range.insertNode(document.createTextNode(text));
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
      // Trigger a manual flush — synthetic `input` events vary across
      // browsers; safer to call commitEdits directly.
      commitEdits();
    }
  }, [editable, onEditableInput, commitEdits]);

  const handleCopy = useCallback(() => {
    if (!editable) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const saved = sel.getRangeAt(0).cloneRange();
    requestAnimationFrame(() => {
      const r = rootRef.current;
      if (!r) return;
      // Keep focus on the editable surface — a blurred contentEditable
      // renders no caret even when a collapsed selection is inside it.
      if (document.activeElement !== r) {
        try { r.focus({ preventScroll: true }); } catch { /* ignore */ }
      }
      const cur = window.getSelection();
      if (!cur) return;
      // If the browser already preserved selection, re-adding the same
      // range is harmless — removeAllRanges + addRange resets it cleanly.
      // We only intervene when the range was truly lost, so we don't
      // churn the caret on every copy.
      const stillLive =
        cur.rangeCount > 0 &&
        cur.getRangeAt(0).startContainer === saved.startContainer &&
        cur.getRangeAt(0).startOffset === saved.startOffset &&
        cur.getRangeAt(0).endContainer === saved.endContainer &&
        cur.getRangeAt(0).endOffset === saved.endOffset;
      if (stillLive) return;
      try {
        cur.removeAllRanges();
        cur.addRange(saved);
      } catch { /* saved range detached — let the browser manage */ }
    });
  }, [editable]);

  // Imperative insertion — the parent hands us the finished markdown link
  // plus the source offset we reported in onMentionQuery, and we splice it in
  // place of `@<query>` (optionally followed by a space for readability).
  useImperativeHandle(ref, () => ({
    insertMention: (link, atIndex, queryLen) => {
      if (!onEditableInput) return;
      const src = sourceSnapshotRef.current;
      // Defensive: ensure the char at atIndex is still `@`. If source shifted
      // (e.g. external edit landed), bail rather than corrupt.
      if (src[atIndex] !== "@") return;
      const newSource =
        src.slice(0, atIndex) + link + " " + src.slice(atIndex + 1 + queryLen);
      sourceSnapshotRef.current = newSource;
      onEditableInput(newSource);
      // Bump render token so the link renders as a chip immediately — the
      // memo comparator otherwise keeps the stale DOM.
      setRenderToken(t => t + 1);

      // After remount, place caret IMMEDIATELY after the inserted chip's
      // trailing space so the user can keep typing. Two rAFs so React has
      // committed the remount before we query for the chip.
      const chipStart = atIndex;        // source offset of the new `[`
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const r = rootRef.current;
        if (!r) return;
        try {
          r.focus({ preventScroll: true });
          const sel = window.getSelection();
          if (!sel) return;
          // Find the chip by its source-offset attr (stamped in `a()` render).
          const chip = r.querySelector<HTMLElement>(
            `[data-md-inline-start="${chipStart}"]`
          );
          const range = document.createRange();
          if (chip && chip.nextSibling && chip.nextSibling.nodeType === Node.TEXT_NODE) {
            // The rebuild inserts a trailing space after the link; the chip's
            // nextSibling is exactly that text node. Caret after the space.
            const ns = chip.nextSibling as Text;
            const offset = Math.min(1, ns.length);
            range.setStart(ns, offset);
            range.collapse(true);
          } else if (chip && chip.parentNode) {
            // Fallback: caret just after the chip element itself.
            range.setStartAfter(chip);
            range.collapse(true);
          } else {
            // Last-resort: end of editable surface.
            range.selectNodeContents(r);
            range.collapse(false);
          }
          sel.removeAllRanges();
          sel.addRange(range);
        } catch { /* ignore */ }
      }));
    },
    /** Return the source-offset that corresponds to the current caret
     * position in the preview DOM. Returns null when there's no selection
     * or we can't map cleanly. Used by the IdeaEditor mode toggle to
     * carry caret position across preview → source.  */
    getCaretSourceOffset: () => {
      const root = rootRef.current;
      if (!root) return null;
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return null;
      const range = sel.getRangeAt(0);
      // Only mappable when the selection is inside the editable surface.
      if (!root.contains(range.startContainer)) return null;

      // Walk up to the nearest wrapped block.
      let node: Node | null = range.startContainer;
      let block: HTMLElement | null = null;
      while (node && node !== root) {
        if (node instanceof HTMLElement && node.hasAttribute("data-md-start")) {
          block = node;
          break;
        }
        node = node.parentNode;
      }
      const container: HTMLElement = block ?? root;

      // Caret offset inside the container's innerText.
      const pre = document.createRange();
      pre.selectNodeContents(container);
      try {
        pre.setEnd(range.endContainer, range.endOffset);
      } catch {
        return null;
      }
      const caretInBlock = pre.toString().replace(/\u00A0/g, " ").length;
      const currentText = container.innerText.replace(/\u00A0/g, " ");

      let blockStart: number;
      let blockEnd: number;
      if (!block) {
        blockStart = 0;
        blockEnd = sourceSnapshotRef.current.length;
      } else {
        blockStart = Number(block.getAttribute("data-md-start"));
        blockEnd = Number(block.getAttribute("data-md-end"));
        if (!Number.isFinite(blockStart) || !Number.isFinite(blockEnd)) return null;
      }
      const srcSlice = sourceSnapshotRef.current.slice(blockStart, blockEnd);
      // Use the chip-aware mapper so chip-containing blocks return an
      // accurate source offset (not just the block end) when the user
      // toggles preview → source.
      if (block) {
        return blockStart + mapFlatOffsetToSource(block, caretInBlock, srcSlice);
      }
      // Root fallback — no mention chips possible here (chips render inside
      // wrapped blocks). Plain indexOf is fine.
      const origIdx = srcSlice.indexOf(currentText);
      if (origIdx < 0) return blockEnd;
      return blockStart + origIdx + caretInBlock;
    },
    /** Place the caret at the DOM position that corresponds to the given
     * source-offset. Returns true on success. Used when toggling source →
     * preview so the user lands in roughly the same spot. */
    setCaretFromSourceOffset: (offset: number) => {
      const root = rootRef.current;
      if (!root) return false;
      const blocks = Array.from(root.querySelectorAll<HTMLElement>("[data-md-start]"));
      // Find the block whose source range contains `offset`, or the first
      // block that starts after it (place caret at its start).
      let host: HTMLElement | null = null;
      let caretInBlock: number | null = null;
      for (const b of blocks) {
        const bStart = Number(b.getAttribute("data-md-start"));
        const bEnd = Number(b.getAttribute("data-md-end"));
        if (!Number.isFinite(bStart) || !Number.isFinite(bEnd)) continue;
        if (offset >= bStart && offset <= bEnd) {
          host = b;
          // Approximate flat-text caret by clipping relative offset into
          // block innerText — works when srcSlice ≈ flat text (non-chip).
          const rel = offset - bStart;
          const flat = b.innerText.replace(/\u00A0/g, " ");
          caretInBlock = Math.min(rel, flat.length);
          break;
        }
        if (offset < bStart) {
          host = b;
          caretInBlock = 0;
          break;
        }
      }
      if (!host) {
        // Past the last block — put caret at end of root.
        try {
          root.focus({ preventScroll: true });
          const range = document.createRange();
          range.selectNodeContents(root);
          range.collapse(false);
          const sel = window.getSelection();
          if (sel) { sel.removeAllRanges(); sel.addRange(range); }
          return true;
        } catch { return false; }
      }

      // Walk the host's text nodes, accumulating length until we hit
      // `caretInBlock`. Place the caret inside the text node that crosses
      // that threshold.
      let remaining = caretInBlock ?? 0;
      let placed = false;
      const placeAt = (n: Text, off: number) => {
        try {
          root.focus({ preventScroll: true });
          const r = document.createRange();
          r.setStart(n, off);
          r.collapse(true);
          const s = window.getSelection();
          if (s) { s.removeAllRanges(); s.addRange(r); }
          placed = true;
        } catch { /* ignore */ }
      };

      const walk = (node: Node): boolean => {
        if (placed) return true;
        if (node.nodeType === Node.TEXT_NODE) {
          const t = node as Text;
          const len = t.length;
          if (remaining <= len) {
            placeAt(t, Math.max(0, remaining));
            return true;
          }
          remaining -= len;
          return false;
        }
        if (node instanceof HTMLElement) {
          if (node.hasAttribute("data-md-inline-src")) {
            // Atomic inline — flattened text is its innerText length.
            const len = node.innerText.length;
            if (remaining <= len) {
              // Can't place caret inside a non-editable atomic; aim just after.
              try {
                root.focus({ preventScroll: true });
                const r = document.createRange();
                r.setStartAfter(node);
                r.collapse(true);
                const s = window.getSelection();
                if (s) { s.removeAllRanges(); s.addRange(r); }
                placed = true;
              } catch { /* ignore */ }
              return true;
            }
            remaining -= len;
            return false;
          }
          if (node.tagName === "BR") return false;
          for (const child of Array.from(node.childNodes)) {
            if (walk(child)) return true;
          }
        }
        return false;
      };

      for (const child of Array.from(host.childNodes)) {
        if (walk(child)) break;
      }
      if (!placed) {
        // Ran out of content — place at end of host.
        try {
          root.focus({ preventScroll: true });
          const r = document.createRange();
          r.selectNodeContents(host);
          r.collapse(false);
          const s = window.getSelection();
          if (s) { s.removeAllRanges(); s.addRange(r); }
          placed = true;
        } catch { /* ignore */ }
      }
      return placed;
    },
    getRoot: () => rootRef.current,
    forceRemount: () => setRenderToken((t) => t + 1),
  }), [onEditableInput]);

  // Render the InnerMarkdown unconditionally so the contenteditable root
  // always has a React-managed first child. In non-editable (read) mode an
  // empty source renders nothing (falls through to ReactMarkdown's empty
  // output) — the placeholder is unused there anyway. In editable mode the
  // `source.trim() === ""` early-return inside InnerMarkdown guarantees at
  // least one wrapped paragraph block.
  return (
    <div
      ref={rootRef}
      className="idea-preview-body"
      contentEditable={editable}
      suppressContentEditableWarning
      onFocus={handleFocus}
      onBlur={handleBlur}
      onInput={handleInput}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      onMouseUp={handleMouseUp}
      onCopy={handleCopy}
      onPaste={handlePaste}
      onCompositionStart={handleCompositionStart}
      onCompositionEnd={handleCompositionEnd}
    >
      <InnerMarkdown
        key={renderToken}
        source={source}
        onMentionClick={onMentionClick}
        editable={editable}
        placeholder={placeholder}
      />
    </div>
  );
});

export default MarkdownPreview;
