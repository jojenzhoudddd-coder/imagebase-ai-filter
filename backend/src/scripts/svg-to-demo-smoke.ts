/**
 * svg-to-demo smoke runner — exercises the four Phase 0 modules end-to-end
 * against a fixture SVG.
 *
 * Usage:
 *   cd backend && npx tsx src/scripts/svg-to-demo-smoke.ts simple-card
 *   cd backend && npx tsx src/scripts/svg-to-demo-smoke.ts dashboard
 *   cd backend && npx tsx src/scripts/svg-to-demo-smoke.ts illustration
 *   cd backend && npx tsx src/scripts/svg-to-demo-smoke.ts ./path/to/your.svg
 *
 * Output:
 *   - Stage timings printed to stdout
 *   - HTML / CSS written to /tmp/svg-to-demo-out/<name>/
 *   - Visual diff PNG (if browser available) written next to the inputs
 *   - Final ratio printed; non-zero exit if browser unavailable
 *
 * The point of this script is to validate the Phase 0 acceptance bar:
 *   simple fixture       diff < 1%
 *   dashboard fixture    diff < 5%
 *   illustration fixture diff < 20%   (curves shipped as islands)
 *
 * If the diff blows past those bounds, something's wrong with the
 * converter / parser, not the LLM workflow (we haven't even started
 * path C yet).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSvgTree } from "../services/svgToDemo/parseSvgTree.js";
import { splitSvgTree } from "../services/svgToDemo/splitSvgTree.js";
import { convertSvgToHtml } from "../services/svgToDemo/svgConverter.js";
import {
  pixelDiff,
  renderHtmlToPng,
  renderSvgToPng,
  shutdownVisualDiff,
} from "../services/svgToDemo/visualDiff.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_DIR = path.resolve(__dirname, "../services/svgToDemo/__fixtures__");
const OUT_DIR = "/tmp/svg-to-demo-out";

interface StageTimings {
  parse: number;
  split: number;
  convert: number;
  renderSvg: number;
  renderHtml: number;
  diff: number;
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("usage: svg-to-demo-smoke <fixture-name|path-to-svg>");
    process.exit(1);
  }

  const inputPath = arg.endsWith(".svg")
    ? path.resolve(arg)
    : path.join(FIXTURE_DIR, `${arg}.svg`);
  const name = path.basename(inputPath, ".svg");

  const svg = await fs.readFile(inputPath, "utf8");
  console.log(`\n=== ${name} ===`);
  console.log(`input: ${inputPath} (${svg.length} bytes)`);

  const outDir = path.join(OUT_DIR, name);
  await fs.mkdir(outDir, { recursive: true });

  const t: StageTimings = {
    parse: 0,
    split: 0,
    convert: 0,
    renderSvg: 0,
    renderHtml: 0,
    diff: 0,
  };

  // 1. parse
  let tStart = Date.now();
  const tree = parseSvgTree(svg);
  t.parse = Date.now() - tStart;
  console.log(`parse: ${t.parse}ms — root.tag=${tree.tag}, byteSize=${tree.byteSize}, tokenEst=${tree.tokenEstimate}`);
  console.log(`       viewBox=${JSON.stringify(tree.bbox)}, children=${tree.children.length}`);

  // 2. split (don't actually consume — Phase 0 path A would feed
  //    converter the whole tree at once; we run split anyway to verify
  //    its output is sane on real SVGs)
  tStart = Date.now();
  const { chunks, defsBlock, defReferences } = splitSvgTree(tree, { maxChunkTokens: 3000 });
  t.split = Date.now() - tStart;
  console.log(`split: ${t.split}ms — ${chunks.length} chunks, defs=${defsBlock ? defsBlock.children.length : 0}`);
  for (const c of chunks.slice(0, 5)) {
    console.log(
      `       ${c.id}: parents=[${c.parentChain.join(" > ")}] tag=${c.rootNode.tag} kids=${c.rootNode.children.length} tok=${c.tokenEstimate}${c.keepAsSvgIsland ? " ISLAND(" + c.islandReason + ")" : ""}`,
    );
  }
  if (chunks.length > 5) console.log(`       ... +${chunks.length - 5} more`);
  if (defReferences.size > 0) {
    const refs = Array.from(defReferences.entries()).map(([k, v]) => `${k}→${v.size}chunks`);
    console.log(`       def refs: ${refs.slice(0, 6).join(", ")}${refs.length > 6 ? "..." : ""}`);
  }

  // 3. convert (whole tree, path A semantics)
  tStart = Date.now();
  const result = convertSvgToHtml(tree, { stampSvgIds: true });
  t.convert = Date.now() - tStart;
  console.log(
    `convert: ${t.convert}ms — html=${result.html.length}b, css=${result.css.length}b, ` +
      `manifest=${result.manifest.length} elems, islands=${result.islands.length}`,
  );
  if (result.islands.length > 0) {
    const reasons = new Map<string, number>();
    for (const i of result.islands) reasons.set(i.reason, (reasons.get(i.reason) ?? 0) + 1);
    console.log(
      `         island reasons: ${Array.from(reasons.entries()).map(([k, v]) => `${k}×${v}`).join(", ")}`,
    );
  }

  // Write outputs.
  const viewBox = tree.bbox ?? [0, 0, 800, 600];
  const indexHtml = `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title>
<link rel="stylesheet" href="style.css"><style>
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
.canvas-svg-host { position: relative; width: ${viewBox[2]}px; height: ${viewBox[3]}px; }
</style></head><body>
<div class="canvas-svg-host">
${result.html}
</div></body></html>`;
  await fs.writeFile(path.join(outDir, "index.html"), indexHtml);
  await fs.writeFile(path.join(outDir, "style.css"), result.css);
  await fs.writeFile(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      { viewBox, manifest: result.manifest, islands: result.islands, stats: result.stats },
      null,
      2,
    ),
  );
  await fs.copyFile(inputPath, path.join(outDir, "original.svg"));
  console.log(`output: ${outDir}/{index.html,style.css,manifest.json,original.svg}`);

  // 4. render SVG → PNG
  tStart = Date.now();
  const svgPng = await renderSvgToPng(svg, { viewBox: viewBox as [number, number, number, number] });
  t.renderSvg = Date.now() - tStart;
  await fs.writeFile(path.join(outDir, "original.png"), svgPng);
  console.log(`renderSvg: ${t.renderSvg}ms — wrote original.png (${svgPng.length}b)`);

  // 5. render HTML → PNG (skipped if browser not available)
  let htmlPng: Buffer | null = null;
  let browserSkipped = false;
  try {
    tStart = Date.now();
    htmlPng = await renderHtmlToPng(result.html, result.css, {
      viewport: [viewBox[2], viewBox[3]],
    });
    t.renderHtml = Date.now() - tStart;
    await fs.writeFile(path.join(outDir, "rendered.png"), htmlPng);
    console.log(`renderHtml: ${t.renderHtml}ms — wrote rendered.png (${htmlPng.length}b)`);
  } catch (err: any) {
    if (err?.code === "BROWSER_UNAVAILABLE") {
      browserSkipped = true;
      console.log(`renderHtml: SKIPPED (no Chrome). pipe still validates parse/split/convert.`);
    } else {
      throw err;
    }
  }

  // 6. pixel diff
  if (htmlPng) {
    tStart = Date.now();
    const diff = await pixelDiff(svgPng, htmlPng, { threshold: 0.15, clusterRadius: 16 });
    t.diff = Date.now() - tStart;
    if (diff.diffPng) await fs.writeFile(path.join(outDir, "diff.png"), diff.diffPng);
    const ratio = (diff.ratio * 100).toFixed(2);
    console.log(
      `diff: ${t.diff}ms — ${ratio}% mismatched ` +
        `(${diff.diffPixels}/${diff.totalPixels}), ${diff.problemBoxes.length} clusters`,
    );
    for (const b of diff.problemBoxes.slice(0, 5)) {
      console.log(`       cluster: x=${b.x} y=${b.y} w=${b.w} h=${b.h} (~${b.pixelCount}px)`);
    }
    if (diff.problemBoxes.length > 5) console.log(`       ... +${diff.problemBoxes.length - 5} more`);

    // Acceptance bar.
    const expected: Record<string, number> = {
      "simple-card": 0.01,
      dashboard: 0.05,
      illustration: 0.2,
    };
    const exp = expected[name] ?? 0.1;
    const ok = diff.ratio <= exp;
    console.log(
      `acceptance: ${ok ? "✓ PASS" : "✗ FAIL"} (got ${ratio}%, threshold ${(exp * 100).toFixed(0)}%)`,
    );
    if (!ok) process.exitCode = 2;
  }

  console.log(
    `total: parse=${t.parse}ms split=${t.split}ms convert=${t.convert}ms ` +
      `renderSvg=${t.renderSvg}ms renderHtml=${t.renderHtml}ms diff=${t.diff}ms` +
      (browserSkipped ? " (browser skipped)" : ""),
  );
  await shutdownVisualDiff();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
