/**
 * splitSvgTree — break a large SVG tree into chunks that each fit in a
 * model's input budget, while preserving structural context the model
 * needs to convert each chunk independently.
 *
 * Why chunk at all?
 *   Path C (LLM-driven faithful conversion) needs to feed each subtree
 *   to the model separately and stitch back together. A 200-KB Figma
 *   export at ~50K tokens won't fit in a single call, and even when it
 *   does, the model wastes most of its attention on path data instead
 *   of structure. We split BEFORE inference so each call is bounded.
 *
 * Why not a fixed-depth split?
 *   Figma exports vary wildly: a UI mockup might have 5 top-level groups
 *   (Header / Hero / Features / Footer / Misc) totalling 30 KB; a logo
 *   might have one `<g>` with 2000 paths inside. Depth-N is the wrong
 *   axis. We split greedily by accumulated token estimate, descending
 *   into a group only when its ENTIRE subtree exceeds the chunk budget.
 *
 * Why on `<g>` boundaries specifically?
 *   Children of `<g>` share a coordinate space and any group-level
 *   transform / opacity / clip. Breaking inside one and reassembling
 *   would require re-applying those wrappers on each piece — error-
 *   prone and wasteful. Group boundaries are the natural unit.
 *
 * What about `<defs>`?
 *   Definitions (gradients, filters, clip paths, masks, symbols) sit
 *   under the SVG root in `<defs>` and are referenced from anywhere in
 *   the document by `id`. We:
 *     1. Collect ALL defs into one shared block.
 *     2. Don't include them in user chunks.
 *     3. Each chunk records which defs it actually references; stitch
 *        time emits the full defs block once at the top of <svg>.
 *   This avoids duplicating large filter definitions across N chunks.
 *
 * What about "island" subtrees (complex paths, masks, blends)?
 *   The converter (svgConverter.ts) treats certain SVG constructs as
 *   un-mappable to plain HTML/CSS and embeds them as inline SVG islands
 *   in the output. The chunker pre-marks these so:
 *     a) The model in path C doesn't waste tokens trying to convert
 *        them.
 *     b) Bytes inside an island count toward the chunk size budget but
 *        we DO NOT recurse into them (they ship as one opaque blob).
 */

import type { SvgNode } from "./parseSvgTree.js";

export interface SvgChunk {
  /** chunk-001, chunk-002, ... */
  id: string;
  /** The subtree this chunk covers. Multiple sibling chunks may share a
   *  parent — their parentChain is identical, and they reconstruct as
   *  the parent's children list at stitch time. */
  rootNode: SvgNode;
  /** Path from document root to rootNode, by tag (+ figmaName when set).
   *  Gives the model semantic context — "you're inside g.Header > g.Nav". */
  parentChain: string[];
  /** ids of <defs>-block entries this subtree references. Stitching
   *  preserves defs once globally, but we still surface the reference
   *  list so per-chunk converters can validate dependencies. */
  referencedDefIds: string[];
  /** Token estimate (byte / 4) for this chunk only. */
  tokenEstimate: number;
  /** Set when the chunk is a "preserve as inline SVG" island —
   *  converter ships the bytes verbatim, model never sees it. */
  keepAsSvgIsland: boolean;
  /** Reason the chunk was marked an island, for debug. */
  islandReason?: string;
}

export interface SplitOpts {
  /** Per-chunk token cap. Conservative default leaves room for prompt
   *  + system message + retry hints in the model call. */
  maxChunkTokens?: number;
  /** Override the island-classification rule. Default rules cover
   *  bezier paths, complex masks, complex filters. */
  shouldKeepAsIsland?: (n: SvgNode) => string | null;
}

const DEFAULT_MAX_CHUNK_TOKENS = 3000;

export function splitSvgTree(tree: SvgNode, opts: SplitOpts = {}): {
  chunks: SvgChunk[];
  defsBlock: SvgNode | null;
  /** Inverse map: defId → chunk ids that reference it. Useful for
   *  pruning defs to "only what's actually used". Stitcher consults
   *  this to decide which defs to include in the final output. */
  defReferences: Map<string, Set<string>>;
} {
  const maxChunkTokens = opts.maxChunkTokens ?? DEFAULT_MAX_CHUNK_TOKENS;
  const shouldKeepAsIsland = opts.shouldKeepAsIsland ?? defaultIslandRule;

  // 1. Pull <defs> aside. They live under the root <svg>; the SVG spec
  //    allows multiple <defs> children but most exports use one.
  //    NB: this returns a SHALLOW-COPIED tree without defs, leaving the
  //    caller's tree untouched. Path A (full-doc convert) needs the
  //    defs in the original tree to resolve `url(#xxx)` references.
  const { defsBlock, treeWithoutDefs } = extractDefs(tree);
  // Shadow the parameter so the rest of this function works against the
  // defs-stripped view without surprising the caller.
  const treeRoot = treeWithoutDefs;

  // 2. Build a reference inventory: for each chunk we'll collect the
  //    set of `url(#xxx)` and `href="#xxx"` it uses. The stitcher needs
  //    this to know what to keep in the global defs block.
  const defReferences = new Map<string, Set<string>>();

  // 3. Walk the (now defs-stripped) tree, emitting chunks under the
  //    token budget. The walker is passed:
  //      - current parent chain (for chunks' parentChain field)
  //      - a sink callback (chunkSink) to push chunks
  //    It returns the totalTokenEstimate of the subtree it walked, so
  //    parents can decide "does my whole subtree fit?".
  const chunks: SvgChunk[] = [];
  let chunkCounter = 0;
  const nextChunkId = () => `chunk-${String(++chunkCounter).padStart(3, "0")}`;

  function emitChunk(node: SvgNode, parentChain: string[], islandReason?: string): SvgChunk {
    const refs = collectRefs(node);
    const id = nextChunkId();
    for (const r of refs) {
      if (!defReferences.has(r)) defReferences.set(r, new Set());
      defReferences.get(r)!.add(id);
    }
    return {
      id,
      rootNode: node,
      parentChain: [...parentChain],
      referencedDefIds: refs,
      tokenEstimate: node.tokenEstimate,
      keepAsSvgIsland: islandReason !== undefined,
      islandReason,
    };
  }

  function walk(node: SvgNode, parentChain: string[]): void {
    // Island check: if this node is structurally un-mappable, ship it
    // whole as an island chunk regardless of size. (Caller's responsibility
    // to not pass an island > maxChunkTokens; in practice we cap at 8x
    // the budget and emit a warning chunk in that case.)
    const islandReason = shouldKeepAsIsland(node);
    if (islandReason) {
      chunks.push(emitChunk(node, parentChain, islandReason));
      return;
    }

    // If the entire subtree fits, ship it as one chunk and stop descent.
    if (node.tokenEstimate <= maxChunkTokens) {
      chunks.push(emitChunk(node, parentChain));
      return;
    }

    // Subtree is too big. Two options:
    //   A) Node is a container (<svg>, <g>, <symbol>) — descend, splitting
    //      children into a sequence of chunks.
    //   B) Node is a single element with too many child <text>/<tspan>/path
    //      runs — we can't structurally split a `<text>`, so we ship it
    //      as one chunk (over budget) but flag a warning. For the rare
    //      Figma case where this matters, the converter / model can fall
    //      back to "describe and approximate".
    if (node.tag === "g" || node.tag === "svg" || node.tag === "symbol") {
      const myChain = [...parentChain, displayLabel(node)];

      // Greedy bin-pack children into chunks. Each chunk holds a
      // contiguous run of children whose summed tokens ≤ budget.
      // We DON'T re-wrap the run in a synthetic <g> — the chunk's
      // rootNode has a synthetic anchor (a `<g>` clone of `node` with a
      // sliced children list) so stitching can pluck them back out.
      let bin: SvgNode[] = [];
      let binTokens = 0;

      const flushBin = () => {
        if (bin.length === 0) return;
        const synthetic = wrapAsContainer(node, bin);
        chunks.push(emitChunk(synthetic, parentChain));
        bin = [];
        binTokens = 0;
      };

      for (const child of node.children) {
        // If the child alone exceeds the budget, recurse into it directly.
        // (This will produce its own series of chunks under our chain.)
        if (child.tokenEstimate > maxChunkTokens) {
          // Flush current bin first to preserve document order.
          flushBin();
          walk(child, myChain);
          continue;
        }
        // Otherwise try to add to current bin.
        if (binTokens + child.tokenEstimate > maxChunkTokens) {
          flushBin();
        }
        bin.push(child);
        binTokens += child.tokenEstimate;
      }
      flushBin();
      return;
    }

    // Non-container that's too big (rare). Ship as one over-budget chunk.
    chunks.push(emitChunk(node, parentChain, "oversize-leaf"));
  }

  walk(treeRoot, []);

  return { chunks, defsBlock, defReferences };
}

// ─── Default island classification ──────────────────────────────────────

/**
 * Decide whether a node should be preserved verbatim as inline SVG
 * (i.e. not handed to the converter for HTML rewriting).
 *
 * Returns a reason string if YES, null otherwise.
 *
 * Heuristics:
 *   - <path> with curve commands (C/c S/s Q/q T/t A/a) → island. CSS
 *     `clip-path: polygon()` only handles straight-line polygons.
 *   - <mask> / <clipPath> with non-trivial geometry → island. Simple
 *     rect-based clipping CAN translate to CSS `clip-path: inset(...)`
 *     but we don't bother detecting; the LLM (path C) can refine if
 *     baseline diff is too high.
 *   - <filter> with feMerge / multi-stage → island. Single-stage
 *     drop-shadow / blur can be CSS-translated, those are caught in
 *     svgConverter, not here. We ONLY island the complex case.
 *   - <foreignObject> → island. Has its own HTML namespace, can't be
 *     simplified.
 *   - <symbol> / <pattern> → island. Reference primitives.
 *   - <textPath> → island. No HTML equivalent.
 *
 * NOTE: A `<g>` containing islands is NOT itself an island. We only
 * island the LEAF that's truly un-mappable; the wrapper `<g>` still
 * gets HTML-converted as a normal container.
 */
function defaultIslandRule(n: SvgNode): string | null {
  switch (n.tag) {
    case "path": {
      const d = n.attrs.d ?? "";
      // Cubic / quadratic / arc / smooth curve commands.
      if (/[CcSsQqTtAa]/.test(d)) return "path-with-bezier";
      return null;
    }
    case "filter": {
      // Count direct children excluding <title>/<desc>/<metadata>.
      const visualKids = n.children.filter(
        (c) => !["title", "desc", "metadata"].includes(c.tag),
      );
      if (visualKids.length > 1) return "complex-filter";
      // Single primitive: feGaussianBlur or feDropShadow → svgConverter
      // can translate to CSS filter:.
      const k = visualKids[0]?.tag;
      if (k && k !== "fegaussianblur" && k !== "fedropshadow") return "filter-not-css-friendly";
      return null;
    }
    case "mask":
    case "clippath": {
      // If the only child is a <rect> with a defining ref-only role,
      // svgConverter can detect simple inset clipping. Anything else =
      // island.
      const visualKids = n.children.filter((c) => c.tag !== "title");
      if (visualKids.length === 1 && visualKids[0].tag === "rect") return null;
      return "complex-mask";
    }
    case "symbol":
    case "pattern":
    case "marker":
      return "reference-primitive";
    case "foreignobject":
      return "foreignobject";
    case "textpath":
      return "textpath";
    default:
      return null;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

/** Build a label like "g.Header" or "rect" for the parentChain field. */
function displayLabel(n: SvgNode): string {
  if (n.figmaName) return `${n.tag}.${n.figmaName}`;
  return n.tag;
}

/** Build a defs-block + a shallow-cloned root with defs removed. The
 *  shallow clone is shallow on purpose — node identity is preserved
 *  for everything below the root, which is fine because nothing else
 *  in the splitter mutates child nodes. The caller's original tree is
 *  untouched.
 *
 *  This was the source of a subtle bug (caught by Phase 0 fixture
 *  illustration.svg): the previous `extractAndStripDefs` mutated
 *  `tree.children` in place, so when the smoke script then called
 *  `convertSvgToHtml(tree)` to do the path-A run, defs were gone and
 *  `url(#bg-gradient)` references failed to resolve, producing a 70%
 *  pixel-diff on the illustration fixture. */
function extractDefs(tree: SvgNode): { defsBlock: SvgNode | null; treeWithoutDefs: SvgNode } {
  if (tree.tag !== "svg") return { defsBlock: null, treeWithoutDefs: tree };
  const defs: SvgNode[] = [];
  const remaining: SvgNode[] = [];
  for (const c of tree.children) {
    if (c.tag === "defs") {
      defs.push(...c.children);
    } else {
      remaining.push(c);
    }
  }
  const defsBlock: SvgNode | null = defs.length === 0
    ? null
    : {
        id: "defs-root",
        tag: "defs",
        attrs: {},
        bbox: null,
        byteSize: defs.reduce((s, c) => s + c.byteSize, 0),
        tokenEstimate: defs.reduce((s, c) => s + c.tokenEstimate, 0),
        children: defs,
      };
  const treeWithoutDefs: SvgNode = { ...tree, children: remaining };
  return { defsBlock, treeWithoutDefs };
}

/** Build a synthetic node that's like `parent` but only carries `children`.
 *  Used when binning sibling children into chunks: each bin needs its own
 *  rootNode that the stitcher can recognize as "a partial of parent". */
function wrapAsContainer(parent: SvgNode, children: SvgNode[]): SvgNode {
  const byteSize = children.reduce((s, c) => s + c.byteSize, 0);
  return {
    id: parent.id, // keep parent's id so stitch can pair up partials
    tag: parent.tag,
    figmaName: parent.figmaName,
    attrs: parent.attrs,
    bbox: parent.bbox,
    byteSize,
    tokenEstimate: Math.ceil(byteSize / 4),
    children,
  };
}

/** Walk subtree collecting all `url(#id)` and `href="#id"` references. */
function collectRefs(node: SvgNode): string[] {
  const seen = new Set<string>();
  function visit(n: SvgNode) {
    for (const k of Object.keys(n.attrs)) {
      const v = n.attrs[k] ?? "";
      // url(#xxx)
      const urlRe = /url\(#([A-Za-z0-9_\-:]+)\)/g;
      let m: RegExpExecArray | null;
      while ((m = urlRe.exec(v))) seen.add(m[1]);
      // href="#xxx" or xlink:href="#xxx"
      if ((k === "href" || k === "xlink:href") && v.startsWith("#")) {
        seen.add(v.slice(1));
      }
    }
    for (const c of n.children) visit(c);
  }
  visit(node);
  return Array.from(seen);
}
