/**
 * createDemoFromSvg — high-level entry that produces a runnable Vibe Demo
 * from an SVG string. Used by:
 *   - Path A:  MCP `create_demo_from_taste` (Agent dialog)
 *   - Path B:  REST `/api/svg-to-demo/from-taste/:tasteId` (UI right-click)
 *   - Path C:  workflow's baseline pre-pass (so the LLM only refines
 *              chunks that fail the visual diff bar)
 *
 * Output side-effects:
 *   1. New Prisma `Demo` row (template = "static", scaffoldTemplate skipped
 *      because we write our own files immediately).
 *   2. Filesystem layout under `~/.imagebase/demos/<demoId>/files/`:
 *        index.html      — minimal shell hosting the converted markup
 *        style.css       — emitted by svgConverter
 *        script.js       — empty placeholder for Agent to add interactions
 *        canvas.svg      — original SVG copy (for the user to inspect /
 *                          export back; also useful as ground-truth ref
 *                          when Path C re-runs visual diffs later)
 *        manifest.json   — {viewBox, manifest[], islands[], stats, source}
 *                          — Agent's compact map for "what's in this Demo
 *                          and which IDs to bind interactions to"
 *
 * Returns:
 *   { demoId, filesWritten, manifest, droppedFeatures }
 *
 * Why we DON'T call demoBuildService here:
 *   The "static" template doesn't need building — index.html + style.css +
 *   script.js are served directly by `/api/demos/:id/preview/*`. Calling
 *   build_demo on it produces dist/ identical to files/. Saves ~2s per
 *   creation. Agent can call build_demo later if/when interactions land.
 *
 * Failure modes:
 *   - SVG parse error → throws, caller surfaces toast "couldn't parse SVG".
 *   - Demo row create conflict (id collision) → retry inside generateId.
 *   - File write fails (disk full, perms) → throws, demo row is left
 *     orphaned (we don't bother cleaning up because it's harmless and
 *     visible in the UI for the user to delete).
 */

import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client.js";
import { generateId } from "../idGenerator.js";
import * as demoFileStore from "../demo/demoFileStore.js";
import { buildDemo } from "../demo/demoBuildService.js";
import { eventBus } from "../eventBus.js";
import { parseSvgTree } from "./parseSvgTree.js";
import { convertSvgToHtml, type ManifestElement } from "./svgConverter.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter } as any);

export interface CreateDemoFromSvgInput {
  /** Workspace the new Demo belongs to. Should match the source taste's
   *  design.workspaceId for path B; chat agent's active workspace for
   *  path A. */
  workspaceId: string;
  /** Display name. Caller usually prefixes with "<source name> Demo". */
  name: string;
  /** Raw SVG content. */
  svg: string;
  /** Optional: the Taste id this demo was generated from. We don't store
   *  it in Prisma yet (no schema column) — only emit it in manifest.json
   *  so the Agent can mention "this demo was generated from taste X" in
   *  follow-up conversations. */
  sourceTasteId?: string;
  /** Client id for the eventBus broadcast. Defaults to "system". */
  clientId?: string;
  /** Parent folder id for the new demo, if any. */
  parentId?: string | null;
}

export interface CreateDemoFromSvgResult {
  demoId: string;
  /** Relative file paths actually written. */
  filesWritten: string[];
  /** Element manifest produced by svgConverter — same shape as the
   *  manifest.json file, surfaced inline so the caller can show the
   *  Agent / user a quick summary without reading the file back. */
  manifest: ManifestElement[];
  /** Human-readable list of unsupported features that were preserved
   *  as inline SVG islands rather than translated to HTML. Surface to
   *  user as a toast subtitle so they understand what may not look
   *  perfect. */
  droppedFeatures: string[];
  /** Quick stats for telemetry. */
  stats: {
    htmlBytes: number;
    cssBytes: number;
    elements: number;
    islands: number;
    cssVars: number;
  };
}

export async function createDemoFromSvg(input: CreateDemoFromSvgInput): Promise<CreateDemoFromSvgResult> {
  const { workspaceId, name, svg, sourceTasteId, clientId = "system", parentId = null } = input;

  // 1. Parse + convert. We do this BEFORE creating the Demo row so a parse
  //    failure doesn't leave an empty demo behind.
  const tree = parseSvgTree(svg);
  const result = convertSvgToHtml(tree, { stampSvgIds: true });

  // 2. Allocate demo id and create the Prisma row.
  const id = await generateId("demo", async (cand) =>
    (await prisma.demo.findUnique({ where: { id: cand }, select: { id: true } })) !== null,
  );
  const maxOrder = await prisma.demo.aggregate({
    where: { workspaceId, parentId: parentId ?? null },
    _max: { order: true },
  });
  const order = (maxOrder._max.order ?? -1) + 1;
  const demo = await prisma.demo.create({
    data: {
      id,
      workspaceId,
      name,
      template: "static",
      parentId: parentId ?? null,
      order,
    },
  });

  // 3. Write the files. The host viewBox is what we got back from the
  //    converter (the SVG's own viewBox). We size the canvas-svg-host
  //    div to that so the converted absolute-positioned children land
  //    inside the right frame.
  await demoFileStore.ensureDemoDir(id);
  const viewBox = result.viewBox ?? [0, 0, 800, 600];
  const indexHtml = renderIndexHtml(name, viewBox, result.html);
  const filesWritten: string[] = [];

  await demoFileStore.writeFile(id, "index.html", indexHtml);
  filesWritten.push("index.html");
  await demoFileStore.writeFile(id, "style.css", result.css);
  filesWritten.push("style.css");
  await demoFileStore.writeFile(id, "script.js", buildEmptyScript());
  filesWritten.push("script.js");
  await demoFileStore.writeFile(id, "canvas.svg", svg);
  filesWritten.push("canvas.svg");
  await demoFileStore.writeFile(
    id,
    "manifest.json",
    JSON.stringify(
      {
        viewBox,
        sourceTasteId: sourceTasteId ?? null,
        manifest: result.manifest,
        islands: result.islands,
        stats: result.stats,
        generatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  filesWritten.push("manifest.json");

  // 4. Run an immediate build so the user can preview without an extra
  //    click. For static template this is essentially a files/ → dist/
  //    copy + sdk.js injection — sub-second. We swallow build errors here
  //    because: (a) the demo is fully usable as raw files even if dist
  //    fails, (b) the build flow already writes a build log the user can
  //    read, (c) blocking demo creation on a build failure would surprise
  //    the user when they don't even know building is happening.
  try {
    const buildResult = await buildDemo({
      demoId: id,
      template: "static",
      dataTables: [],
      dataIdeas: [],
      capabilities: {},
    });
    if (!buildResult.ok) {
      // eslint-disable-next-line no-console
      console.warn(
        `[createDemoFromSvg] auto-build failed for ${id} (non-fatal):`,
        buildResult.error,
      );
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[createDemoFromSvg] auto-build threw for ${id} (non-fatal):`, err);
  }

  // 5. Broadcast workspace change so the sidebar picks up the new demo
  //    immediately (matches /api/demos POST behavior).
  eventBus.emitWorkspaceChange({
    type: "demo:create",
    workspaceId,
    clientId,
    timestamp: Date.now(),
    payload: {
      demo: {
        id: demo.id,
        name: demo.name,
        template: demo.template,
        parentId: demo.parentId,
        order: demo.order,
        publishSlug: null,
        lastBuildStatus: "success",
      },
    },
  });

  // 6. Build the human-readable "what we couldn't translate" list.
  //    Group island reasons so we say "3 paths with curves" not
  //    "3 island reasons: bezier-path-leaked-through".
  const droppedFeatures = summarizeDroppedFeatures(result.islands);

  return {
    demoId: id,
    filesWritten,
    manifest: result.manifest,
    droppedFeatures,
    stats: {
      htmlBytes: result.html.length,
      cssBytes: result.css.length,
      elements: result.manifest.length,
      islands: result.islands.length,
      cssVars: result.stats.cssVars,
    },
  };
}

// ─── helpers ───────────────────────────────────────────────────────────

function renderIndexHtml(
  title: string,
  viewBox: [number, number, number, number],
  bodyHtml: string,
): string {
  const [, , w, h] = viewBox;
  // Match what visualDiff.renderHtmlToPng wraps so the live preview
  // and diff target render identically.
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="./style.css" />
  <style>
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: transparent; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", "Helvetica Neue", Arial, sans-serif; }
    .canvas-svg-host {
      position: relative;
      width: ${w}px;
      height: ${h}px;
      margin: 0 auto;
    }
  </style>
</head>
<body>
  <div class="canvas-svg-host">
${bodyHtml}
  </div>
  <script src="./script.js"></script>
</body>
</html>
`;
}

function buildEmptyScript(): string {
  // The Agent will fill this in to bind interactions to elements
  // identified by their data-md-svg-id / id attributes. We seed with a
  // helpful comment listing the common entry points so an LLM editing
  // this file has the conventions in front of it.
  return `// Demo interaction logic — populate this file when the user asks
// for behaviour. Element IDs follow this pattern (see manifest.json
// for the full list):
//
//   document.getElementById("el-rect-3").addEventListener("click", ...)
//   document.querySelector("[data-figma-name='Login_Button']")
//
// window.ImageBase is available if this Demo declares dataTables /
// dataIdeas via update_demo_capabilities — see demo-skill prompt.
`;
}

function summarizeDroppedFeatures(
  islands: { nodeId: string; reason: string; bbox: [number, number, number, number] }[],
): string[] {
  if (islands.length === 0) return [];
  // Reason → human label.
  const labels: Record<string, string> = {
    "path-with-bezier": "曲线路径",
    "complex-filter": "复杂滤镜",
    "filter-not-css-friendly": "无 CSS 等价滤镜",
    "complex-mask": "复杂遮罩",
    "reference-primitive": "符号 / 图案",
    foreignobject: "foreignObject 嵌入",
    textpath: "曲线文字",
    "diagonal-line": "斜线",
    "straight-path-as-island": "复杂多段路径",
    "polygon-as-island": "多边形 / 折线",
    "untranslatable-tag": "未支持的 SVG 元素",
    "unresolved-use": "未解析的引用",
    "bezier-path-leaked-through": "曲线路径",
    "oversize-leaf": "超大单一元素",
  };
  const counts = new Map<string, number>();
  for (const i of islands) {
    const label = labels[i.reason] ?? i.reason;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return Array.from(counts.entries()).map(([label, n]) => `${n} 个${label}`);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
