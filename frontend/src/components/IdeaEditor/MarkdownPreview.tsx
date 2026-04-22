import {
  forwardRef, memo, useCallback, useEffect, useImperativeHandle,
  useMemo, useRef, useState,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { parseMentionHref } from "./mentionSyntax";
import type { ParsedMention } from "./mentionSyntax";

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
const SAFE_URL_PROTOCOL = /^(https?|ircs?|mailto|xmpp|mention)$/i;
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
  },
  protocols: {
    ...(defaultSchema.protocols || {}),
    href: [...((defaultSchema.protocols?.href) || []), "mention"],
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
  const remarkPlugins = useMemo(() => [remarkGfm], []);
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
      strong: ({ node, children, ...rest }: any) => (
        <strong contentEditable={false} data-md-inline-src={inlineSrcFrom(node)} {...rest}>{children}</strong>
      ),
      em: ({ node, children, ...rest }: any) => (
        <em contentEditable={false} data-md-inline-src={inlineSrcFrom(node)} {...rest}>{children}</em>
      ),
      del: ({ node, children, ...rest }: any) => (
        <del contentEditable={false} data-md-inline-src={inlineSrcFrom(node)} {...rest}>{children}</del>
      ),
      code: ({ node, children, ...rest }: any) => (
        <code contentEditable={false} data-md-inline-src={inlineSrcFrom(node)} {...rest}>{children}</code>
      ),
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
 * as `@label`, so we respect that. */
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

  // If source changes *externally* (tab switch, SSE, etc.) while we're NOT
  // editing, re-snapshot and let InnerMarkdown re-render. While editing we
  // keep the snapshot at its value at focus-start (see handleFocus below).
  useEffect(() => {
    if (!editingRef.current) {
      sourceSnapshotRef.current = source;
    }
  }, [source]);

  // Initial caret on mount — in editable mode the user needs an immediate
  // affordance that typing will insert text. Place the caret at the end of
  // the rendered content so typing appends naturally. Runs once per mount;
  // MarkdownPreview unmounts on mode toggle so we don't need to retrigger.
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
      try {
        root.focus({ preventScroll: true });
        if (root.childNodes.length === 0) return;
        const range = document.createRange();
        range.selectNodeContents(root);
        range.collapse(false);
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

      const currentText = block.innerText.replace(/\u00A0/g, " ");
      if (currentText === origText) return;

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

    if (edits.length === 0) return;

    edits.sort((a, b) => b.start - a.start);
    let newSource = sourceSnapshotRef.current;
    for (const e of edits) {
      newSource = newSource.slice(0, e.start) + e.newSlice + newSource.slice(e.end);
    }
    sourceSnapshotRef.current = newSource;

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

    // Build the separator. We want 2 newlines between content on each side
    // (markdown paragraph break). If the adjacent source already has some
    // newlines — e.g. caret sits at end of a heading that already ends with
    // `\n` — only insert what's missing, so we don't balloon to triple-
    // newline on every Enter.
    const src = sourceSnapshotRef.current;
    const before = src.slice(0, sourceOffset);
    const after = src.slice(sourceOffset);
    const prevNL = (/\n+$/.exec(before)?.[0].length) ?? 0;
    const nextNL = (/^\n+/.exec(after)?.[0].length) ?? 0;
    const sep = "\n".repeat(Math.max(1, 2 - prevNL - nextNL));

    const newSource = before + sep + after;
    sourceSnapshotRef.current = newSource;
    onEditableInput(newSource);
    // Force a fresh parse so the new block structure materialises — the
    // InnerMarkdown memo otherwise holds onto the pre-Enter DOM forever.
    setRenderToken(t => t + 1);

    // Restore caret at the new source position. After remount, find the
    // block whose source range contains `targetOffset` and place the caret
    // accordingly. If we can't locate one (target is past the last block),
    // fall back to end of the editable root — still better than losing the
    // caret entirely.
    const targetOffset = sourceOffset + sep.length;
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
    if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (composingRef.current) return;
      e.preventDefault();
      insertParagraphBreak();
      return;
    }

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
        if (range.collapsed) {
          // Two possible caret-after-chip shapes:
          //  (a) caret is at offset 0 of a text node whose previousSibling is a chip
          //  (b) caret is at index N of an element node, and childNodes[N-1] is a chip
          let chip: HTMLElement | null = null;
          const sc = range.startContainer;
          const so = range.startOffset;
          if (sc.nodeType === Node.TEXT_NODE && so === 0) {
            const prev = (sc as Text).previousSibling;
            if (prev instanceof HTMLElement && prev.classList.contains("idea-mention-chip")) {
              chip = prev;
            }
          } else if (sc.nodeType === Node.ELEMENT_NODE && so > 0) {
            const prev = sc.childNodes[so - 1];
            if (prev instanceof HTMLElement && prev.classList.contains("idea-mention-chip")) {
              chip = prev;
            }
          }
          if (chip) {
            e.preventDefault();
            const parent = chip.parentNode;
            if (parent) {
              // Capture a reference to whatever sits immediately after the
              // chip so we can place the caret there after removal. If the
              // chip was followed by its rebuild-inserted trailing space,
              // we'll drop that too — leaving `foo | bar` → `foo| bar` reads
              // strange, so we trim exactly one leading space when present.
              const nextNode = chip.nextSibling;
              parent.removeChild(chip);
              if (nextNode && nextNode.nodeType === Node.TEXT_NODE) {
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
              commitEdits();
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
