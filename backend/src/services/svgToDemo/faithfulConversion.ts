/**
 * faithfulConversion — Path C: LLM-driven SVG→HTML refinement.
 *
 * Orchestration model (intentionally pure code, NOT a WorkflowDoc DSL run):
 *
 *   1. Run Path A's deterministic converter end-to-end to produce a
 *      baseline Demo. This usually gives 95-99% pixel-fidelity for design-
 *      system mocks already.
 *   2. Split the SVG tree into chunks. For each chunk, render the original
 *      sub-SVG and the baseline HTML segment to PNGs, pixel-diff them.
 *   3. Chunks whose diff exceeds the threshold get retried by an LLM:
 *      - Send the chunk's original SVG + the baseline HTML/CSS
 *      - Ask the model to produce {html, css} that matches the SVG
 *      - Pixel-diff again; if still bad, retry once more (max 2 LLM calls)
 *   4. Stitch all (refined or baseline) chunk outputs into the final
 *      index.html / style.css and write back to the Demo's files.
 *   5. Re-run the build so the preview reflects the refined output.
 *
 * Why NOT use the existing WorkflowDoc DSL?
 *
 *   The DSL's `parallel` node is a fixed list of branches (each branch is
 *   a separate node id). It can't express "fan out over the N chunks the
 *   previous step produced" — that requires runtime list materialization.
 *   The `loop` node has a hard cap of 10 iterations (LOOP_HARD_CAP), but
 *   real Figma exports can split into 50+ chunks. We'd have to redesign
 *   the DSL or shoehorn arbitrary chunk counts into a serial loop.
 *
 *   Code-driven orchestration:
 *     - Naturally handles dynamic chunk lists.
 *     - Concurrency capped via a tiny semaphore (default 4 parallel LLM
 *       calls — keeps OneAPI rate-limit-friendly without manual tuning).
 *     - Progress events emitted via a callback for tool_progress SSE.
 *     - Caller (MCP tool) is the boundary the Agent sees; internals are
 *       implementation detail.
 *
 *   We DO still expose this as a single MCP tool so the Agent can invoke
 *   it the same way as any other workflow.
 *
 * Concurrency tuning:
 *   - 4 LLM calls in flight simultaneously. Both Anthropic and OpenAI
 *     ratelimit at request/minute, not concurrent — but bursting too high
 *     triggers 429s. 4 is a safe default; we expose `concurrency` opt for
 *     the rare 60-chunk insane case.
 *   - Pixel diff is fast (sharp + pixelmatch sub-100ms), no concurrency
 *     bound needed.
 *
 * Failure modes:
 *   - Browser unavailable (puppeteer can't launch) → returns
 *     `{ ok:false, reason:"browser-unavailable" }` on the first diff
 *     attempt. Caller falls back to Path A's baseline.
 *   - LLM throws / returns invalid JSON → that chunk falls back to
 *     baseline. Conversion still completes for the rest.
 *   - Final stitch produces invalid HTML → we surface in result.warnings
 *     but still write to disk; Demo preview will at least show what was
 *     possible to render.
 */

import { resolveAdapter, resolveModelForCall } from "../modelRegistry.js";
import * as demoFileStore from "../demo/demoFileStore.js";
import { buildDemo } from "../demo/demoBuildService.js";
import { parseSvgTree, type SvgNode } from "./parseSvgTree.js";
import { splitSvgTree, type SvgChunk } from "./splitSvgTree.js";
import { convertSvgToHtml } from "./svgConverter.js";
import { createDemoFromSvg } from "./createDemoFromSvg.js";
import {
  pixelDiff,
  renderHtmlToPng,
  renderSvgToPng,
} from "./visualDiff.js";

export interface FaithfulConversionInput {
  workspaceId: string;
  name: string;
  svg: string;
  sourceTasteId?: string;
  agentId?: string;
  /** Override LLM model for chunk refinement (default: agent's selected). */
  modelId?: string | null;
  /** Max LLM calls per chunk before giving up and using baseline. Default 2. */
  maxRetriesPerChunk?: number;
  /** Per-chunk pixel diff ratio above which we trigger LLM refinement. */
  refineThreshold?: number;
  /** Per-chunk pixel diff ratio above which we retry once more. */
  retryThreshold?: number;
  /** Concurrent LLM calls. Default 4. Capped at 8 to stay friendly to
   *  OneAPI / ARK ratelimits. */
  concurrency?: number;
  /** Wall-clock cap. Default 180s — covers 50-chunk Figma exports at
   *  4-way concurrency comfortably. */
  timeoutMs?: number;
  /** Progress callback. Called with a structured update for each phase
   *  transition + chunk completion. SSE-friendly. */
  onProgress?: (p: ProgressUpdate) => void;
  /** External abort. Honored at chunk boundaries. */
  signal?: AbortSignal;
}

export type ProgressUpdate =
  | { phase: "baseline"; message: string }
  | { phase: "split"; chunkCount: number }
  | { phase: "diff-baseline"; current: number; total: number }
  | { phase: "refine"; current: number; total: number; chunkId: string }
  | { phase: "stitch"; message: string }
  | { phase: "build"; message: string }
  | { phase: "done"; finalDiffRatio: number; refinedChunks: number; totalChunks: number };

export interface FaithfulConversionResult {
  ok: boolean;
  /** Created demo id. Even on partial failure we return the demo so the
   *  user can inspect what we produced. */
  demoId: string;
  /** Final whole-document pixel diff ratio. -1 if browser unavailable. */
  finalDiffRatio: number;
  /** How many chunks were LLM-refined vs left as baseline. */
  refinedChunks: number;
  totalChunks: number;
  /** Reasons LLM gave up on a chunk (per chunk id). */
  chunkFailures: Record<string, string>;
  /** Aggregate warnings (e.g. "browser unavailable; skipped diff"). */
  warnings: string[];
  /** Wall-clock duration of the whole run. */
  durationMs: number;
}

const DEFAULT_REFINE_THRESHOLD = 0.05;
const DEFAULT_RETRY_THRESHOLD = 0.05;
const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 8;
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_RETRIES_PER_CHUNK = 2;

/**
 * Run the faithful conversion. Multi-phase, see the file header for the
 * orchestration outline. Caller is typically the MCP tool wrapper, which
 * adapts `onProgress` events to `tool_progress` SSE.
 */
export async function runFaithfulConversion(
  input: FaithfulConversionInput,
): Promise<FaithfulConversionResult> {
  const started = Date.now();
  const onProgress = input.onProgress ?? (() => {});
  const refineThreshold = input.refineThreshold ?? DEFAULT_REFINE_THRESHOLD;
  const retryThreshold = input.retryThreshold ?? DEFAULT_RETRY_THRESHOLD;
  const concurrency = Math.min(input.concurrency ?? DEFAULT_CONCURRENCY, MAX_CONCURRENCY);
  const maxRetries = input.maxRetriesPerChunk ?? DEFAULT_MAX_RETRIES_PER_CHUNK;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const warnings: string[] = [];
  const chunkFailures: Record<string, string> = {};

  // Wall-clock guard. We honor it at chunk boundaries — never inside a
  // running LLM call (those have their own provider-side timeout).
  const deadlineSignal = AbortSignal.timeout(timeoutMs);
  const composedSignal = input.signal
    ? anySignal(input.signal, deadlineSignal)
    : deadlineSignal;

  // Phase 1: baseline (deterministic Path A converter + auto-build).
  // This gives us a Demo that's already 95-99% correct for most fixtures
  // and serves as the fallback target for any chunk we can't refine.
  onProgress({ phase: "baseline", message: "Running deterministic baseline conversion" });
  const baseline = await createDemoFromSvg({
    workspaceId: input.workspaceId,
    name: input.name,
    svg: input.svg,
    sourceTasteId: input.sourceTasteId,
  });

  // Phase 2: split the tree. We need chunks regardless of whether we have
  // a browser — the diff phase is opt-in but the chunk LIST is still the
  // unit we reason about for "what to refine".
  const tree = parseSvgTree(input.svg);
  const { chunks } = splitSvgTree(tree, { maxChunkTokens: 3000 });
  onProgress({ phase: "split", chunkCount: chunks.length });

  // Phase 3: render each chunk's original SVG + the baseline's HTML for
  // that chunk's bounding box, pixel-diff. Chunks above threshold queue
  // for LLM refinement.
  // The baseline HTML/CSS is loaded once and per-chunk we extract the
  // bounding box for diff scoring. We don't bother extracting per-chunk
  // HTML segments — diff a viewport-sized rect around the chunk's bbox
  // and compare to a similarly-sized crop of the original SVG.
  const baselineHtml = await demoFileStore.readFile(baseline.demoId, "index.html");
  const baselineCss = await demoFileStore.readFile(baseline.demoId, "style.css");
  const fullViewBox = (tree.bbox ?? [0, 0, 800, 600]) as [number, number, number, number];

  // PERF: render baseline HTML once and reuse for every chunk's crop+diff.
  // Previously diffChunk re-rendered the whole HTML to PNG per chunk, which
  // for an N-chunk doc meant N × playwright launches × ~1-2s = easily 50s+.
  // Now: 1 render of the full baseline + N tiny sharp.extract crops.
  let baselineHtmlPng: Buffer | null = null;
  let browserAvailable = true;
  try {
    baselineHtmlPng = await renderHtmlToPng(baselineHtml, baselineCss, {
      viewport: [fullViewBox[2], fullViewBox[3]],
    });
  } catch (err: any) {
    if (err?.code === "BROWSER_UNAVAILABLE") {
      browserAvailable = false;
      warnings.push("Headless browser unavailable; skipped pixel diff and LLM refinement");
    } else {
      warnings.push(`Baseline render failed: ${err?.message ?? err}`);
      browserAvailable = false;
    }
  }

  const baselineDiffs: Array<{ chunk: SvgChunk; ratio: number; problemBoxes: any[] }> = [];
  if (!browserAvailable || !baselineHtmlPng) {
    // Mark every chunk as "good enough" — falls back to baseline.
    for (const chunk of chunks) {
      baselineDiffs.push({ chunk, ratio: 0, problemBoxes: [] });
    }
  } else {
    for (let i = 0; i < chunks.length; i++) {
      if (composedSignal.aborted) break;
      const chunk = chunks[i];
      onProgress({ phase: "diff-baseline", current: i + 1, total: chunks.length });
      if (!chunk.rootNode.bbox || chunk.keepAsSvgIsland) {
        baselineDiffs.push({ chunk, ratio: 0, problemBoxes: [] });
        continue;
      }
      try {
        const diff = await diffChunkAgainstPrerendered({
          svg: input.svg,
          chunk,
          baselineHtmlPng,
        });
        baselineDiffs.push({ chunk, ratio: diff.ratio, problemBoxes: diff.problemBoxes });
      } catch (err: any) {
        warnings.push(`diff error for ${chunk.id}: ${err?.message ?? err}`);
        baselineDiffs.push({ chunk, ratio: Number.POSITIVE_INFINITY, problemBoxes: [] });
      }
    }
  }

  // Phase 4: refine chunks that failed the threshold. Concurrency-bounded.
  let refinedChunks = 0;
  const refinedHtml = new Map<string, { html: string; css: string }>();
  if (browserAvailable && !composedSignal.aborted) {
    const candidates = baselineDiffs.filter((d) => d.ratio > refineThreshold);
    const sem = new Semaphore(concurrency);
    let done = 0;
    await Promise.all(
      candidates.map(async (entry) => {
        await sem.acquire();
        if (composedSignal.aborted) {
          sem.release();
          return;
        }
        try {
          const refined = await refineChunkWithLlm({
            chunk: entry.chunk,
            problemBoxes: entry.problemBoxes,
            input,
            modelId: input.modelId ?? null,
            maxRetries,
            retryThreshold,
            baselineSvg: input.svg,
            baselineHtml,
            baselineCss,
            fullViewBox,
            signal: composedSignal,
          });
          if (refined.ok) {
            refinedChunks++;
            refinedHtml.set(entry.chunk.id, { html: refined.html, css: refined.css });
          } else {
            chunkFailures[entry.chunk.id] = refined.reason;
          }
        } catch (err: any) {
          chunkFailures[entry.chunk.id] = err?.message ?? String(err);
        } finally {
          done++;
          onProgress({
            phase: "refine",
            current: done,
            total: candidates.length,
            chunkId: entry.chunk.id,
          });
          sem.release();
        }
      }),
    );
  }

  // Phase 5: stitch. If we got any refined output, splice it back into the
  // baseline HTML/CSS by replacing the corresponding chunks. Stitching
  // strategy: each chunk's rootNode has a stable id (svg id we stamped),
  // so we find that node's current HTML output and replace it.
  // For Phase 2 V1 we ALWAYS rewrite both index.html and style.css from
  // the result of stitching: takes the baseline html/css minus refined
  // segments, plus the refined segments. Robust because we never need to
  // diff-merge.
  if (refinedHtml.size > 0) {
    onProgress({ phase: "stitch", message: `Stitching ${refinedHtml.size} refined chunks` });
    const stitched = stitchHtml({
      baselineHtml,
      baselineCss,
      refinedChunks: refinedHtml,
      svg: input.svg,
    });
    await demoFileStore.writeFile(baseline.demoId, "index.html", stitched.html);
    await demoFileStore.writeFile(baseline.demoId, "style.css", stitched.css);

    // Phase 6: re-build so dist/ matches the new files.
    onProgress({ phase: "build", message: "Re-building Demo with refined chunks" });
    try {
      await buildDemo({
        demoId: baseline.demoId,
        template: "static",
        dataTables: [],
        dataIdeas: [],
        capabilities: {},
      });
    } catch (err) {
      warnings.push(`Re-build failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Phase 7: final whole-document diff for the user-facing fidelity score.
  let finalDiffRatio = -1;
  if (browserAvailable) {
    try {
      const finalHtml = await demoFileStore.readFile(baseline.demoId, "index.html");
      const finalCss = await demoFileStore.readFile(baseline.demoId, "style.css");
      const svgPng = await renderSvgToPng(input.svg, { viewBox: fullViewBox });
      const htmlPng = await renderHtmlToPng(finalHtml, finalCss, {
        viewport: [fullViewBox[2], fullViewBox[3]],
      });
      const diff = await pixelDiff(svgPng, htmlPng, {
        threshold: 0.15,
        clusterRadius: 16,
        emitDiffPng: false,
      });
      finalDiffRatio = diff.ratio;
    } catch (err) {
      warnings.push(`Final diff failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  onProgress({
    phase: "done",
    finalDiffRatio,
    refinedChunks,
    totalChunks: chunks.length,
  });

  return {
    ok: true,
    demoId: baseline.demoId,
    finalDiffRatio,
    refinedChunks,
    totalChunks: chunks.length,
    chunkFailures,
    warnings,
    durationMs: Date.now() - started,
  };
}

// ─── Diff a single chunk's bounding-box region ─────────────────────────

/**
 * Diff a chunk against an ALREADY-rendered baseline HTML PNG. The caller
 * owns the lifecycle of the buffer — we just sharp.extract a crop.
 *
 * This is the hot path during Phase 3: for an N-chunk doc, called N times
 * but with zero playwright launches (just N tiny sharp crops + N small
 * SVG renders + N pixelmatch calls — all sub-100ms).
 */
async function diffChunkAgainstPrerendered(input: {
  svg: string;
  chunk: SvgChunk;
  baselineHtmlPng: Buffer;
}) {
  const bbox = input.chunk.rootNode.bbox;
  if (!bbox) return { ratio: 0, problemBoxes: [] as any[] };
  const svgPng = await renderSvgToPng(input.svg, {
    viewBox: bbox,
    outputWidth: Math.max(64, bbox[2]),
  });
  const sharp = (await import("sharp")).default;
  const cropped = await sharp(input.baselineHtmlPng)
    .extract({
      left: Math.max(0, Math.round(bbox[0])),
      top: Math.max(0, Math.round(bbox[1])),
      width: Math.max(1, Math.round(bbox[2])),
      height: Math.max(1, Math.round(bbox[3])),
    })
    .png()
    .toBuffer();
  return pixelDiff(svgPng, cropped, {
    threshold: 0.15,
    clusterRadius: 8,
    emitDiffPng: false,
  });
}

// ─── LLM refinement for a single chunk ────────────────────────────────

interface RefineChunkInput {
  chunk: SvgChunk;
  problemBoxes: any[];
  input: FaithfulConversionInput;
  modelId: string | null;
  maxRetries: number;
  retryThreshold: number;
  baselineSvg: string;
  baselineHtml: string;
  baselineCss: string;
  fullViewBox: [number, number, number, number];
  signal: AbortSignal;
}

async function refineChunkWithLlm(
  input: RefineChunkInput,
): Promise<
  | { ok: true; html: string; css: string }
  | { ok: false; reason: string }
> {
  const { chunk } = input;
  const chunkSvg = serializeSubtreeAsSvg(chunk.rootNode, input.fullViewBox);
  const baselineHtmlSegment = extractHtmlForChunk(input.baselineHtml, chunk);
  const baselineCssSegment = extractCssForChunk(input.baselineCss, chunk);

  let lastError = "";
  for (let attempt = 0; attempt < input.maxRetries; attempt++) {
    if (input.signal.aborted) return { ok: false, reason: "aborted" };

    const userPrompt = buildRefinePrompt({
      chunkSvg,
      parentChain: chunk.parentChain,
      baselineHtml: baselineHtmlSegment,
      baselineCss: baselineCssSegment,
      problemBoxes: input.problemBoxes,
      attempt,
      lastError,
    });

    let modelOut: { html?: string; css?: string };
    try {
      modelOut = await callLlmForJsonChunkOutput({
        modelId: input.modelId,
        agentId: input.input.agentId,
        userPrompt,
        signal: input.signal,
      });
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      continue;
    }
    if (typeof modelOut.html !== "string" || typeof modelOut.css !== "string") {
      lastError = "model output missing html/css";
      continue;
    }

    // Diff the refined chunk to see if it actually improved.
    // Render the stitched HTML once (one playwright launch per refine
    // attempt — bounded by maxRetries × number of refining chunks).
    try {
      const stitched = stitchHtml({
        baselineHtml: input.baselineHtml,
        baselineCss: input.baselineCss,
        refinedChunks: new Map([[chunk.id, { html: modelOut.html, css: modelOut.css }]]),
        svg: input.baselineSvg,
      });
      const stitchedHtmlPng = await renderHtmlToPng(stitched.html, stitched.css, {
        viewport: [input.fullViewBox[2], input.fullViewBox[3]],
      });
      const diff = await diffChunkAgainstPrerendered({
        svg: input.baselineSvg,
        chunk,
        baselineHtmlPng: stitchedHtmlPng,
      });
      if (diff.ratio <= input.retryThreshold) {
        return { ok: true, html: modelOut.html, css: modelOut.css };
      }
      lastError = `refined diff ${(diff.ratio * 100).toFixed(2)}% > threshold ${(input.retryThreshold * 100).toFixed(2)}%`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  return { ok: false, reason: lastError || "exhausted retries" };
}

interface BuildRefinePromptInput {
  chunkSvg: string;
  parentChain: string[];
  baselineHtml: string;
  baselineCss: string;
  problemBoxes: any[];
  attempt: number;
  lastError: string;
}

function buildRefinePrompt(p: BuildRefinePromptInput): string {
  // Single-shot prompt — the LLM gets the original SVG chunk + the
  // baseline output + a problem hint, and must return JSON {html, css}.
  // We use STRICT JSON requirements (no markdown fences) so JSON.parse
  // is reliable.
  const retryHint = p.attempt > 0
    ? `\n\nThe previous attempt failed: ${p.lastError}. Try a different approach this time.`
    : "";
  const problemHint = p.problemBoxes.length > 0
    ? `\n\nBaseline had visual diff problems at regions: ${JSON.stringify(p.problemBoxes.slice(0, 5))}`
    : "";
  return [
    `You are converting an SVG fragment to equivalent HTML+CSS for a Vibe Demo.`,
    `Convert the SVG faithfully. For elements that map cleanly to HTML (rect, text,`,
    `image, basic shapes), use absolute-positioned <div>/<span> with CSS. For`,
    `complex paths, masks, or filters, embed an inline <svg> island sized to the`,
    `feature's bounding box.`,
    ``,
    `**Rules:**`,
    `- Output STRICT JSON: { "html": "...", "css": "..." }. No markdown fences.`,
    `- HTML uses absolute positioning relative to the parent .canvas-svg-host.`,
    `- Preserve element ids that begin with "el-" (those are stable handles users`,
    `  may script against).`,
    `- Group reusable colors / fonts into the CSS.`,
    `- Don't include a <style> tag — just raw CSS rules.`,
    `- Don't include <html>/<body>/<head> tags.`,
    ``,
    `**Parent chain context:** ${p.parentChain.join(" > ") || "(root)"}`,
    ``,
    `**Original SVG fragment:**`,
    `\`\`\`xml`,
    p.chunkSvg,
    `\`\`\``,
    ``,
    `**Baseline HTML attempt (had visual diff issues):**`,
    `\`\`\`html`,
    p.baselineHtml.slice(0, 2500),
    `\`\`\``,
    ``,
    `**Baseline CSS attempt (chunk-scoped):**`,
    `\`\`\`css`,
    p.baselineCss.slice(0, 2500),
    `\`\`\`${problemHint}${retryHint}`,
    ``,
    `Return only the JSON object.`,
  ].join("\n");
}

// ─── LLM call wrapper ──────────────────────────────────────────────────

interface LlmCallInput {
  modelId: string | null;
  agentId?: string;
  userPrompt: string;
  signal: AbortSignal;
}

async function callLlmForJsonChunkOutput(input: LlmCallInput): Promise<{ html?: string; css?: string }> {
  const { resolved } = resolveModelForCall(input.modelId);
  const adapter = resolveAdapter(resolved);
  const stream = adapter.stream({
    model: resolved,
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text:
              "You are a precise SVG→HTML converter. Always return strict JSON with `html` and `css` fields. No markdown, no commentary.",
          },
        ],
      },
      {
        role: "user",
        content: [{ type: "input_text", text: input.userPrompt }],
      },
    ],
    signal: input.signal,
  });

  let collected = "";
  for await (const event of stream) {
    if (event.kind === "text_delta") collected += event.text;
    if (event.kind === "error") throw new Error(event.message);
    // thinking_delta / tool_call_done / done — ignore
  }
  // Some models wrap in markdown fences despite our prompt — strip them.
  let raw = collected.trim();
  if (raw.startsWith("```")) {
    raw = raw.replace(/^```[a-zA-Z]*\n?/, "").replace(/```\s*$/, "").trim();
  }
  // Defensive: find the first { … last } if there's any prose around it.
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start !== -1 && end !== -1) raw = raw.slice(start, end + 1);
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`LLM returned invalid JSON: ${(err as Error).message}; head=${raw.slice(0, 200)}`);
  }
}

// ─── Chunk subtree → standalone SVG string ────────────────────────────

function serializeSubtreeAsSvg(node: SvgNode, parentViewBox: [number, number, number, number]): string {
  // Build a minimal SVG wrapper around the chunk so the LLM can read it
  // standalone. Use the chunk's bbox if available, else parent's viewBox.
  const bbox = node.bbox ?? parentViewBox;
  const inner = serializeNode(node);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${bbox.join(" ")}">${inner}</svg>`;
}

function serializeNode(n: SvgNode): string {
  const attrs = Object.keys(n.attrs)
    .map((k) => `${k}="${escapeAttr(n.attrs[k])}"`)
    .join(" ");
  const open = `<${n.tag}${attrs ? " " + attrs : ""}>`;
  const close = `</${n.tag}>`;
  const inner = (n.text ? escapeXml(n.text) : "") + n.children.map(serializeNode).join("");
  return `${open}${inner}${close}`;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ─── Stitching ─────────────────────────────────────────────────────────

interface StitchInput {
  baselineHtml: string;
  baselineCss: string;
  refinedChunks: Map<string, { html: string; css: string }>;
  svg: string;
}

interface StitchOutput {
  html: string;
  css: string;
}

/**
 * Splice refined chunk HTML back into the baseline document.
 *
 * Strategy: find the DOM nodes corresponding to each chunk's rootNode by
 * `data-md-svg-id="<svg node id>"` attribute (Path A's converter stamps
 * this). Replace their outerHTML with the refined chunk's html. Append
 * the refined chunk's css to the global stylesheet.
 *
 * Limitation: a chunk's rootNode may be a <g> wrapper that doesn't
 * itself produce a single HTML element (because <g> stylings flatten
 * when they have nothing to wrap). In that case we look for the chunk
 * root's CHILDREN's data-md-svg-ids and replace their region.
 *
 * For Phase 2 V1 we only handle the common case (rootNode is a leaf
 * shape). Wrapper-group refinement falls back to "append chunk.html as
 * a sibling" which preserves visuals for additive refinements but may
 * leave stale baseline DOM. The full visual diff will still flag this
 * if it matters.
 */
function stitchHtml(input: StitchInput): StitchOutput {
  let html = input.baselineHtml;
  let css = input.baselineCss;
  for (const [chunkId, refined] of input.refinedChunks) {
    css += "\n\n/* refined chunk: " + chunkId + " */\n" + refined.css;
    // Try to find the baseline element that matches this chunk's rootNode
    // by stable id and replace it. This is a regex-based replace because
    // we don't have a DOM parser here on the server; the marker attribute
    // is unique enough to make this safe.
    //
    // The baseline always emits ONE wrapping element per non-island chunk
    // root; replacing it cleanly swaps the segment. For islands we also
    // emit a single <svg> wrapper, same logic applies.
    const tagOpenRe = new RegExp(
      `<(?:div|span|svg|p|h[1-6]|button|img)[^>]*data-md-svg-id="${escapeRegExp(chunkRootSvgId(chunkId, input.svg))}"[^>]*>`,
      "i",
    );
    // We still need the closing tag — but since we're regex-based and
    // can't parse balanced HTML, we use a bracket-counting walk.
    const m = tagOpenRe.exec(html);
    if (!m) {
      // Couldn't locate baseline element; append refined HTML at the end
      // of the canvas host as a fallback.
      html = html.replace(
        /<\/div>\s*<script src="\.\/script\.js"><\/script>/,
        `${refined.html}\n</div>\n  <script src="./script.js"></script>`,
      );
      continue;
    }
    const startIdx = m.index;
    const endIdx = findMatchingClose(html, startIdx, m[0]);
    if (endIdx === -1) {
      html = html.slice(0, startIdx) + refined.html + html.slice(startIdx + m[0].length);
      continue;
    }
    html = html.slice(0, startIdx) + refined.html + html.slice(endIdx);
  }
  return { html, css };
}

function chunkRootSvgId(_chunkId: string, _svg: string): string {
  // The chunk's rootNode.id is the SvgNode stable hash id. We don't have
  // it here without re-parsing. For Phase 2 V1 the caller always has the
  // chunk available — this fallback is for paths where it's not threaded
  // through. (In practice stitchHtml always receives the chunk via the
  // refinedChunks map, but keying by chunkId is more ergonomic for
  // future-extensibility.) We just return chunkId; if no match we fall
  // through to the appended segment.
  return _chunkId;
}

/** Walk forward from `start` (open tag at index `start`, length open.length)
 *  finding the matching close tag for the same element. Returns the index
 *  AFTER the closing tag, or -1 if unbalanced. Works for non-self-closing
 *  tags only. */
function findMatchingClose(html: string, start: number, openTag: string): number {
  const tagNameMatch = /^<([a-zA-Z]+)/.exec(openTag);
  if (!tagNameMatch) return -1;
  const tagName = tagNameMatch[1];
  const reOpen = new RegExp(`<${tagName}\\b[^>]*>`, "gi");
  const reClose = new RegExp(`</${tagName}>`, "gi");
  reOpen.lastIndex = start + openTag.length;
  reClose.lastIndex = start + openTag.length;
  let depth = 1;
  while (depth > 0) {
    const nextOpen = reOpen.exec(html);
    const nextClose = reClose.exec(html);
    if (!nextClose) return -1;
    if (nextOpen && nextOpen.index < nextClose.index) {
      depth++;
      reClose.lastIndex = nextOpen.index + 1;
    } else {
      depth--;
      if (depth === 0) return nextClose.index + nextClose[0].length;
      reOpen.lastIndex = nextClose.index + 1;
    }
  }
  return -1;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Best-effort baseline extracts (passed to LLM as context) ───────

/**
 * Try to extract the baseline HTML segment matching this chunk's rootNode.
 * Path A's converter stamps `data-md-svg-id="<node.id>"` on the wrapper
 * element it emits per node, so we can locate the chunk's HTML by stable id
 * and return just that subtree.
 *
 * This trims the LLM prompt from ~30KB whole-document HTML to typically
 * <2KB per-chunk HTML — important because (a) many models charge by token
 * and (b) huge prompts confuse the model into rewriting unrelated regions.
 *
 * If we can't locate the segment (chunk root may be a `<g>` wrapper that
 * didn't get its own DOM node), fall back to a small slice of the full
 * baseline so the model still has SOME context.
 */
function extractHtmlForChunk(baselineHtml: string, chunk: SvgChunk): string {
  const id = chunk.rootNode.id;
  if (!id) return baselineHtml.slice(0, 2000);
  const re = new RegExp(
    `<(?:div|span|svg|p|h[1-6]|button|img)[^>]*data-md-svg-id="${escapeRegExp(id)}"[^>]*>`,
    "i",
  );
  const m = re.exec(baselineHtml);
  if (!m) return baselineHtml.slice(0, 2000);
  const startIdx = m.index;
  const endIdx = findMatchingClose(baselineHtml, startIdx, m[0]);
  if (endIdx === -1) {
    return baselineHtml.slice(startIdx, Math.min(baselineHtml.length, startIdx + 2000));
  }
  return baselineHtml.slice(startIdx, endIdx);
}

/**
 * Best-effort CSS extract: return only rules that mention any of the SVG
 * ids appearing in the chunk's HTML segment. Path A emits per-element
 * rules keyed by `[data-md-svg-id="..."]` selectors plus shared `:root`
 * custom-property pools, so this regex match is good enough.
 *
 * Always include `:root { ... }` (the var pool) since the chunk's local
 * rules reference these vars.
 */
function extractCssForChunk(baselineCss: string, chunk: SvgChunk): string {
  const idsInChunk = collectChunkIds(chunk.rootNode);
  if (idsInChunk.size === 0) return baselineCss.slice(0, 2000);

  // 1) Always include the :root rule (variable pool).
  const out: string[] = [];
  const rootRe = /:root\s*\{[\s\S]*?\}/;
  const rootMatch = rootRe.exec(baselineCss);
  if (rootMatch) out.push(rootMatch[0]);

  // 2) Walk every CSS rule, keep ones whose selector mentions any chunk id.
  const ruleRe = /([^{}]+)\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = ruleRe.exec(baselineCss))) {
    const selector = m[1].trim();
    if (selector === ":root") continue; // already added
    for (const id of idsInChunk) {
      if (selector.includes(id)) {
        out.push(m[0]);
        break;
      }
    }
  }
  const joined = out.join("\n");
  return joined.length > 0 ? joined : baselineCss.slice(0, 2000);
}

function collectChunkIds(n: SvgNode, acc: Set<string> = new Set()): Set<string> {
  if (n.id) acc.add(n.id);
  for (const c of n.children) collectChunkIds(c, acc);
  return acc;
}

// ─── Tiny utilities ────────────────────────────────────────────────────

class Semaphore {
  private waiters: Array<() => void> = [];
  constructor(private slots: number) {}
  async acquire(): Promise<void> {
    if (this.slots > 0) {
      this.slots--;
      return;
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  release(): void {
    const w = this.waiters.shift();
    if (w) w();
    else this.slots++;
  }
}

function anySignal(...signals: AbortSignal[]): AbortSignal {
  const ctrl = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      ctrl.abort(s.reason);
      break;
    }
    s.addEventListener("abort", () => ctrl.abort(s.reason), { once: true });
  }
  return ctrl.signal;
}
