/**
 * demoBuildService — esbuild Node API wrapper that turns `files/` source
 * into `dist/` bundle, plus an SDK script generated per Demo.
 *
 * Supports two templates today:
 *   - `static`    — HTML entry, optional JS files, no JSX
 *   - `react-spa` — `app.tsx` entry bundled into `bundle.js`, React 18 + TS
 *                   JSX-runtime, Tailwind via CDN script tag in index.html
 *
 * Both templates emit:
 *   dist/index.html         (patched with <script src="./sdk.js" defer>)
 *   dist/sdk.js             (capability-aware SDK from demoSdkInjector)
 *   dist/bundle.js          (react-spa only)
 *   dist/bundle.css         (if any CSS imported by the bundle)
 *   dist/<other static>     (pass-through of HTML/CSS/img etc.)
 *
 * Build timeout: 30s hard (wraps esbuild promise in timeout; abort will
 * throw TOOL_TIMEOUT-style error).
 *
 * Concurrency: per-demo lock; overlapping build_demo calls serialize.
 */

import path from "path";
import fsp from "fs/promises";
import type { BuildOptions, BuildResult as EsBuildResult } from "esbuild";
import { build as esbuild } from "esbuild";
import * as store from "./demoFileStore.js";
import {
  buildSdkJs,
  injectSdkTag,
  type BuildSdkOptions,
} from "./demoSdkInjector.js";

export interface BuildDemoInput {
  demoId: string;
  template: "static" | "react-spa";
  dataTables: string[];
  dataIdeas: string[];
  capabilities: Record<string, string[]>;
  progress?: (payload: {
    phase: string;
    message: string;
    progress?: number;
    current?: number;
    total?: number;
  }) => void;
}

export interface BuildDemoResult {
  ok: boolean;
  durationMs: number;
  sizeBytes?: number;
  fileCount?: number;
  logTail: string;
  error?: string;
}

const BUILD_TIMEOUT_MS = 30_000;

// Per-demo build lock — overlapping builds queue up instead of racing dist/.
const locks = new Map<string, Promise<unknown>>();

export async function buildDemo(input: BuildDemoInput): Promise<BuildDemoResult> {
  const prev = locks.get(input.demoId) ?? Promise.resolve();
  const next = prev.then(() => doBuild(input), () => doBuild(input));
  locks.set(input.demoId, next);
  try {
    return (await next) as BuildDemoResult;
  } finally {
    if (locks.get(input.demoId) === next) locks.delete(input.demoId);
  }
}

async function doBuild(input: BuildDemoInput): Promise<BuildDemoResult> {
  const { demoId, template } = input;
  const started = Date.now();
  const logLines: string[] = [];
  const log = (s: string) => logLines.push(`[${new Date().toISOString()}] ${s}`);

  try {
    await store.ensureDemoDir(demoId);
    input.progress?.({ phase: "preparing", message: "检查源文件" });

    const files = await store.listFiles(demoId);
    if (files.length === 0) {
      throw new Error("Demo 没有任何文件。先调 write_demo_file 写入代码。");
    }

    // Clear dist, start fresh
    await store.clearDist(demoId);
    log(`prepared dist/, source files = ${files.length}`);

    input.progress?.({ phase: "bundling", message: `esbuild 打包 (${template})` });

    const bundleResult = await runWithTimeout(
      template === "react-spa"
        ? buildReactSpa(demoId, files, log)
        : buildStatic(demoId, files, log),
      BUILD_TIMEOUT_MS,
    );

    log(`esbuild done, warnings=${bundleResult.warnings.length}, errors=${bundleResult.errors.length}`);

    if (bundleResult.errors.length > 0) {
      for (const e of bundleResult.errors) log(`ERR: ${e.text} (${e.location?.file}:${e.location?.line})`);
      throw new Error(bundleResult.errors.map((e) => e.text).join("; "));
    }

    // Generate SDK
    input.progress?.({ phase: "injecting", message: "注入 ImageBase SDK" });
    const sdkJs = buildSdkJs({
      demoId,
      dataTables: input.dataTables,
      dataIdeas: input.dataIdeas,
      capabilities: input.capabilities as BuildSdkOptions["capabilities"],
    });
    await store.writeDist(demoId, "sdk.js", sdkJs);
    log(`wrote sdk.js (${Buffer.byteLength(sdkJs)} bytes)`);

    // Patch index.html to reference SDK
    input.progress?.({ phase: "finalizing", message: "写入 dist/" });
    const indexPath = store.distFilePath(demoId, "index.html");
    try {
      const html = await fsp.readFile(indexPath, "utf-8");
      const patched = injectSdkTag(html);
      if (patched !== html) {
        await fsp.writeFile(indexPath, patched, "utf-8");
        log(`patched index.html with sdk script tag`);
      }
    } catch (err) {
      // If no index.html yet (static template with no HTML file), generate a minimal one.
      const stub = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Demo</title>
  <script src="./sdk.js" defer></script>
</head>
<body>
  ${template === "react-spa" ? '<div id="root"></div>\n  <script src="./bundle.js"></script>' : "<p>This Demo has no index.html.</p>"}
</body>
</html>`;
      await store.writeDist(demoId, "index.html", stub);
      log(`generated stub index.html`);
    }

    // Final stats
    const distFiles = await listDist(store.demoFilesDir(demoId).replace(/\/files$/, "/dist"));
    const sizeBytes = distFiles.reduce((acc, f) => acc + f.size, 0);
    log(`dist: ${distFiles.length} files, ${sizeBytes} bytes`);

    const buildLog = logLines.join("\n");
    await store.writeBuildLog(demoId, buildLog);

    return {
      ok: true,
      durationMs: Date.now() - started,
      sizeBytes,
      fileCount: distFiles.length,
      logTail: tailLines(buildLog, 40),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`BUILD FAILED: ${msg}`);
    const buildLog = logLines.join("\n");
    await store.writeBuildLog(demoId, buildLog).catch(() => undefined);
    return {
      ok: false,
      durationMs: Date.now() - started,
      logTail: tailLines(buildLog, 80),
      error: msg,
    };
  }
}

// ─── Template: static ─────────────────────────────────────────────────────
//
// Copies HTML / CSS / images directly. Bundles JS through esbuild only if
// there are .js / .mjs files; otherwise no bundle step. No JSX support.

async function buildStatic(
  demoId: string,
  files: store.FileEntry[],
  log: (s: string) => void,
): Promise<EsBuildResult> {
  const srcRoot = store.demoFilesDir(demoId);
  const jsEntries = files.filter((f) => /\.(js|mjs)$/.test(f.path) && !f.path.includes("node_modules"));

  // Copy all non-JS files straight to dist
  for (const f of files) {
    if (jsEntries.some((j) => j.path === f.path)) continue;
    const content = await fsp.readFile(path.join(srcRoot, f.path));
    await store.writeDist(demoId, f.path, content);
  }
  log(`copied ${files.length - jsEntries.length} static assets`);

  // Bundle JS entries if any
  if (jsEntries.length === 0) {
    return { errors: [], warnings: [], metafile: undefined, outputFiles: undefined } as any as EsBuildResult;
  }

  const opts: BuildOptions = {
    entryPoints: jsEntries.map((f) => path.join(srcRoot, f.path)),
    outdir: path.join(srcRoot, "../dist"),
    bundle: true,
    format: "iife",
    target: "es2020",
    sourcemap: false,
    minify: false, // V1 prioritize debuggability
    logLevel: "silent",
  };
  return esbuild(opts);
}

// ─── Template: react-spa ──────────────────────────────────────────────────
//
// Expects `app.tsx` (or `index.tsx`) as the entry. Bundles to `bundle.js`.
// React is NOT bundled — loaded via ESM CDN inside index.html (see prompt).

async function buildReactSpa(
  demoId: string,
  files: store.FileEntry[],
  log: (s: string) => void,
): Promise<EsBuildResult> {
  const srcRoot = store.demoFilesDir(demoId);
  const distRoot = path.join(srcRoot, "../dist");

  // Copy HTML / CSS / image assets directly
  const pass = files.filter(
    (f) => /\.(html|css|png|jpg|jpeg|gif|svg|ico|webp|woff2?)$/i.test(f.path),
  );
  for (const f of pass) {
    const content = await fsp.readFile(path.join(srcRoot, f.path));
    await store.writeDist(demoId, f.path, content);
  }
  log(`copied ${pass.length} static assets`);

  // Find entry
  const entryCandidates = ["app.tsx", "app.ts", "app.jsx", "app.js", "index.tsx", "main.tsx"];
  const entry = entryCandidates.find((c) => files.some((f) => f.path === c));
  if (!entry) {
    throw new Error(
      `react-spa 模板需要入口文件之一：${entryCandidates.join(" / ")}。当前文件列表：${files.map((f) => f.path).join(", ")}`,
    );
  }

  const opts: BuildOptions = {
    entryPoints: [path.join(srcRoot, entry)],
    outfile: path.join(distRoot, "bundle.js"),
    bundle: true,
    format: "iife",
    target: "es2020",
    jsx: "automatic",
    jsxImportSource: "react",
    sourcemap: false,
    minify: false,
    logLevel: "silent",
    loader: {
      ".ts": "ts",
      ".tsx": "tsx",
      ".js": "js",
      ".jsx": "jsx",
      ".css": "css",
      ".png": "file",
      ".jpg": "file",
      ".svg": "file",
    },
    // React & ReactDOM loaded from CDN in index.html — mark them external
    // so esbuild doesn't try to resolve them in node_modules (we have none).
    external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"],
    // Override imports to CDN URLs via banner+alias — simpler via plugin,
    // but V1 uses prompt convention: Agent writes `import React from "react"`,
    // index.html pre-declares `window.React` from CDN, bundle references it.
    // Instead of injecting import map, we use a simple rewriting banner.
    banner: {
      js: "",
    },
    footer: { js: "" },
  };

  const result = await esbuild(opts);
  log(`bundled ${entry} → bundle.js`);
  return result;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

async function listDist(root: string): Promise<Array<{ path: string; size: number }>> {
  const out: Array<{ path: string; size: number }> = [];
  async function walk(dir: string, relBase: string): Promise<void> {
    let entries: any[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const rel = relBase ? path.join(relBase, e.name) : e.name;
      if (e.isDirectory()) await walk(full, rel);
      else if (e.isFile()) {
        const stat = await fsp.stat(full).catch(() => null);
        if (stat) out.push({ path: rel, size: stat.size });
      }
    }
  }
  await walk(root, "");
  return out;
}

function runWithTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`build timeout after ${ms}ms`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function tailLines(s: string, n: number): string {
  const lines = s.split("\n");
  return lines.slice(-n).join("\n");
}
