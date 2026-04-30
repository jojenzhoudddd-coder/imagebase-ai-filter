/**
 * visualDiff — three rendering primitives + one pixel-diff primitive used
 * by the SVG→Demo pipeline:
 *
 *   renderSvgToPng(svg, viewBox?)        → PNG bytes
 *   renderHtmlToPng(html, css, viewport) → PNG bytes
 *   pixelDiff(a, b)                      → ratio + problemBoxes
 *
 * Why these three primitives specifically?
 *   The path-C workflow's value depends entirely on having an OBJECTIVE
 *   feedback loop: "does the model's HTML reproduce the original SVG
 *   pixel-for-pixel?". A subjective LLM-judge approach (asking another
 *   call to grade fidelity) would be both expensive and unreliable.
 *   Pixel comparison is cheap (~200ms per chunk) and gives a hard signal
 *   the workflow can branch on (`if diffRatio > 5%: retry`).
 *
 * Implementation choices:
 *   - SVG → PNG: `sharp` (already a backend dep). Native SVG renderer
 *     is `librsvg`-based via `resvg` shim; visually equivalent to a
 *     browser for typical Figma exports. ~5-50ms per chunk.
 *   - HTML → PNG: `playwright-core` reusing the browser singleton from
 *     `demoScreenshotService`. ~200-800ms per call (cold) /
 *     ~50-200ms (warm).
 *   - pixel diff: `pixelmatch` + `pngjs`. Includes anti-aliasing
 *     tolerance to ignore sub-pixel shifts that don't matter visually.
 *
 * Caching strategy:
 *   We DON'T cache here — chunk inputs are unique per workflow run and
 *   re-running is rare. If we ever need caching, hash (svg, viewBox)
 *   into a content-addressed PNG file in `~/.imagebase/svg-cache/`.
 */

import fs from "node:fs/promises";
import sharp from "sharp";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import type { Browser, BrowserType } from "playwright-core";

// ─── SVG → PNG (sharp) ─────────────────────────────────────────────────

export interface RenderSvgOpts {
  /** Override the viewBox the SVG declares. Useful when rendering a
   *  cropped chunk: we want it sized to its OWN bbox, not the parent's. */
  viewBox?: [number, number, number, number];
  /** Output width in pixels. Output height auto-computes from aspect.
   *  Default: viewBox.w (1:1 px-to-unit). */
  outputWidth?: number;
  /** DPR to multiply by; default 1. Bumped to 2 in workflow C for
   *  sharper diffs at the cost of 4× more pixels. */
  dpr?: number;
}

export async function renderSvgToPng(svg: string, opts: RenderSvgOpts = {}): Promise<Buffer> {
  // sharp's SVG path will derive viewBox from the source unless we wrap.
  // For chunks we want to FORCE the viewBox so the visible area matches
  // the bbox we computed in parseSvgTree.
  const wrapped = opts.viewBox ? wrapSvgWithViewBox(svg, opts.viewBox) : svg;
  const viewBox = opts.viewBox ?? extractViewBox(svg);
  const width = Math.round((opts.outputWidth ?? viewBox?.[2] ?? 800) * (opts.dpr ?? 1));
  // Use a high "density" so sharp upscales the SVG before rasterizing —
  // critical for crisp text. Density 144 ≈ 2× DPR; we let outputWidth
  // do the final scale.
  const density = 144 * (opts.dpr ?? 1);
  return await sharp(Buffer.from(wrapped, "utf8"), { density })
    .resize({ width, withoutEnlargement: false })
    .png({ compressionLevel: 1 }) // fast, we don't store these
    .toBuffer();
}

function wrapSvgWithViewBox(svg: string, vb: [number, number, number, number]): string {
  // If the input has no <svg> root (it's a chunk subtree), wrap it.
  const hasRoot = /^\s*(?:<\?xml[^>]*>\s*)?<svg\b/.test(svg);
  if (!hasRoot) {
    return `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.join(" ")}">${svg}</svg>`;
  }
  // Otherwise patch the existing <svg>'s viewBox attribute.
  return svg.replace(/<svg\b([^>]*)>/, (full, attrs) => {
    if (/viewBox=/.test(attrs)) {
      return full.replace(/viewBox="[^"]*"/, `viewBox="${vb.join(" ")}"`);
    }
    return `<svg${attrs} viewBox="${vb.join(" ")}">`;
  });
}

function extractViewBox(svg: string): [number, number, number, number] | null {
  const m = /viewBox="([^"]+)"/.exec(svg);
  if (!m) return null;
  const parts = m[1].split(/[\s,]+/).map(Number);
  if (parts.length === 4 && parts.every(Number.isFinite)) {
    return [parts[0], parts[1], parts[2], parts[3]];
  }
  return null;
}

// ─── HTML+CSS → PNG (playwright) ───────────────────────────────────────

export interface RenderHtmlOpts {
  /** Viewport size. The HTML is rendered against this. Caller usually
   *  wants this to match the SVG's viewBox (so identical pixel coords). */
  viewport: [width: number, height: number];
  /** Render at higher DPR; default 1. */
  dpr?: number;
  /** Time budget (ms) for the page to settle before screenshotting. */
  timeoutMs?: number;
}

const CHROMIUM_CANDIDATES = [
  process.env.CHROME_BIN,
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/opt/google/chrome/chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
].filter(Boolean) as string[];

let browserPromise: Promise<Browser | null> | null = null;

async function findBrowserBinary(): Promise<string | null> {
  for (const p of CHROMIUM_CANDIDATES) {
    try {
      await fs.access(p);
      return p;
    } catch {
      /* not here */
    }
  }
  return null;
}

async function getBrowser(): Promise<Browser | null> {
  if (browserPromise) return browserPromise;
  browserPromise = (async () => {
    const execPath = await findBrowserBinary();
    if (!execPath) return null;
    const { chromium } = (await import("playwright-core")) as { chromium: BrowserType };
    try {
      return await chromium.launch({
        executablePath: execPath,
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[svgToDemo/visualDiff] browser launch failed:", err);
      browserPromise = null;
      return null;
    }
  })();
  return browserPromise;
}

export async function renderHtmlToPng(html: string, css: string, opts: RenderHtmlOpts): Promise<Buffer> {
  const [vw, vh] = opts.viewport;
  const dpr = opts.dpr ?? 1;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const browser = await getBrowser();
  if (!browser) {
    throw Object.assign(new Error("BROWSER_UNAVAILABLE: install Chrome or set CHROME_BIN"), {
      code: "BROWSER_UNAVAILABLE",
    });
  }
  const ctx = await browser.newContext({
    viewport: { width: vw, height: vh },
    deviceScaleFactor: dpr,
  });
  const page = await ctx.newPage();
  // Use a setContent doc that mounts the canvas-svg-host wrapper.
  // Background is intentionally transparent so trailing-edge artifacts
  // don't fool the diff (we compare against transparent SVG too).
  const doc = `<!doctype html><html><head><meta charset="utf-8"><style>
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { background: transparent; }
.canvas-svg-host { position: relative; width: ${vw}px; height: ${vh}px; }
${css}
</style></head><body><div class="canvas-svg-host">${html}</div></body></html>`;
  try {
    await page.setContent(doc, { waitUntil: "load", timeout: timeoutMs });
    const buf = await page.screenshot({
      type: "png",
      fullPage: false,
      omitBackground: true,
      clip: { x: 0, y: 0, width: vw, height: vh },
    });
    return Buffer.from(buf);
  } finally {
    await page.close();
    await ctx.close();
  }
}

// ─── pixel diff ────────────────────────────────────────────────────────

export interface PixelDiffResult {
  /** Fraction of pixels that differ (0..1). 0 = identical. */
  ratio: number;
  /** Total mismatched pixels. */
  diffPixels: number;
  /** Total compared pixels. */
  totalPixels: number;
  /** Bounding boxes of contiguous mismatch regions, in pixel coords. */
  problemBoxes: { x: number; y: number; w: number; h: number; pixelCount: number }[];
  /** Optional diff visualization PNG (red highlights on transparent base). */
  diffPng?: Buffer;
}

export interface PixelDiffOpts {
  /** Sub-pixel anti-aliasing tolerance (0..1). 0.1 is the pixelmatch
   *  default and forgives 1 px shifts caused by font hinting. */
  threshold?: number;
  /** Generate the diff visualization PNG. Default true; turn off in
   *  production hot loops to save memory. */
  emitDiffPng?: boolean;
  /** Cluster mismatching pixels into rects with this radius (in px).
   *  Larger = fewer boxes, each bigger. Default 8. */
  clusterRadius?: number;
}

export async function pixelDiff(a: Buffer, b: Buffer, opts: PixelDiffOpts = {}): Promise<PixelDiffResult> {
  const threshold = opts.threshold ?? 0.1;
  const emitDiffPng = opts.emitDiffPng ?? true;
  const clusterRadius = opts.clusterRadius ?? 8;

  const imgA = PNG.sync.read(a);
  let imgB = PNG.sync.read(b);

  // If sizes don't match we can't pixel-diff directly. The convention
  // here is that the CALLER aligns sizes (renderSvgToPng + renderHtmlToPng
  // with same viewport). If they slipped, resize the smaller to match —
  // safer than throwing, and the tiny sub-pixel error from one resize
  // is below pixelmatch threshold.
  if (imgA.width !== imgB.width || imgA.height !== imgB.height) {
    const resized = await sharp(b).resize(imgA.width, imgA.height, { fit: "fill" }).png().toBuffer();
    imgB = PNG.sync.read(resized);
  }

  const { width, height } = imgA;
  const totalPixels = width * height;
  const diffImg = emitDiffPng ? new PNG({ width, height }) : null;
  const diffPixels = pixelmatch(imgA.data, imgB.data, diffImg ? diffImg.data : null!, width, height, {
    threshold,
    includeAA: false,
  });
  const ratio = totalPixels === 0 ? 0 : diffPixels / totalPixels;

  // Cluster mismatched pixels into bounding boxes. Walk the diff data,
  // for each "diff" pixel (non-zero in red channel of the diff image),
  // find its containing cluster via a simple flood-fill on a coarse grid.
  // For chunk-level retry hints we just need APPROXIMATE problem regions,
  // not pixel-perfect blobs.
  let problemBoxes: PixelDiffResult["problemBoxes"] = [];
  if (diffImg && diffPixels > 0) {
    problemBoxes = clusterDiffPixels(diffImg, clusterRadius);
  }

  return {
    ratio,
    diffPixels,
    totalPixels,
    problemBoxes,
    diffPng: emitDiffPng && diffImg ? PNG.sync.write(diffImg) : undefined,
  };
}

/** Coarse-grid clustering. Divides the image into clusterRadius²-pixel
 *  tiles, marks each tile that contains any diff pixel, then merges
 *  adjacent marked tiles into rectangles via connected components. */
function clusterDiffPixels(
  diffImg: PNG,
  clusterRadius: number,
): PixelDiffResult["problemBoxes"] {
  const { width, height, data } = diffImg;
  const tilesW = Math.ceil(width / clusterRadius);
  const tilesH = Math.ceil(height / clusterRadius);
  const tiles = new Uint8Array(tilesW * tilesH);
  // pixelmatch marks differing pixels as red (255, 0, 0). Detect by
  // checking the red channel high & green/blue low.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const bch = data[i + 2];
      if (r > 200 && g < 100 && bch < 100) {
        const tx = Math.floor(x / clusterRadius);
        const ty = Math.floor(y / clusterRadius);
        tiles[ty * tilesW + tx] = 1;
      }
    }
  }
  // Connected-components on the tile grid (4-neighbour).
  const labels = new Int32Array(tilesW * tilesH);
  let nextLabel = 1;
  const boxes = new Map<number, { x0: number; y0: number; x1: number; y1: number; count: number }>();
  for (let ty = 0; ty < tilesH; ty++) {
    for (let tx = 0; tx < tilesW; tx++) {
      if (tiles[ty * tilesW + tx] === 0) continue;
      if (labels[ty * tilesW + tx] !== 0) continue;
      // BFS flood-fill.
      const label = nextLabel++;
      const stack: number[] = [ty * tilesW + tx];
      while (stack.length) {
        const idx = stack.pop()!;
        if (labels[idx] !== 0) continue;
        labels[idx] = label;
        const ix = idx % tilesW;
        const iy = (idx - ix) / tilesW;
        let box = boxes.get(label);
        if (!box) {
          box = { x0: ix, y0: iy, x1: ix, y1: iy, count: 0 };
          boxes.set(label, box);
        }
        if (ix < box.x0) box.x0 = ix;
        if (iy < box.y0) box.y0 = iy;
        if (ix > box.x1) box.x1 = ix;
        if (iy > box.y1) box.y1 = iy;
        box.count++;
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const nx = ix + dx;
          const ny = iy + dy;
          if (nx < 0 || ny < 0 || nx >= tilesW || ny >= tilesH) continue;
          const nIdx = ny * tilesW + nx;
          if (tiles[nIdx] === 1 && labels[nIdx] === 0) stack.push(nIdx);
        }
      }
    }
  }
  return Array.from(boxes.values()).map((b) => ({
    x: b.x0 * clusterRadius,
    y: b.y0 * clusterRadius,
    w: (b.x1 - b.x0 + 1) * clusterRadius,
    h: (b.y1 - b.y0 + 1) * clusterRadius,
    pixelCount: b.count * clusterRadius * clusterRadius,
  }));
}

// ─── Cleanup hook (call from process exit) ─────────────────────────────

export async function shutdownVisualDiff(): Promise<void> {
  if (!browserPromise) return;
  const b = await browserPromise;
  browserPromise = null;
  if (b) await b.close().catch(() => {});
}
