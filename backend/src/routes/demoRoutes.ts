/**
 * /api/demos/* — Demo artifact CRUD + file ops + build/publish.
 *
 * Separate from /api/demo-runtime/* (which is the runtime SDK target):
 *   /api/demos/*         — owner-facing CRUD, file management, build trigger
 *   /api/demos/:id/preview/* — static serve of dist/ for private iframe preview
 *   /api/demo-runtime/*  — runtime SDK endpoints (capability-gated)
 *   /share/:slug/*       — public published snapshot serve
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import path from "path";
import fsp from "fs/promises";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";

import { generateId } from "../services/idGenerator.js";
import * as store from "../services/demo/demoFileStore.js";
import { buildDemo } from "../services/demo/demoBuildService.js";
import { publishDemo, unpublishDemo } from "../services/demo/demoPublishService.js";
import { eventBus } from "../services/eventBus.js";
import {
  createDemoSchema,
  renameDemoSchema,
  updateCapabilitiesSchema,
  writeDemoFileSchema,
  deleteDemoFileSchema,
  demoSummarySchema,
  demoDetailSchema,
  type DemoDetail,
  type Capabilities,
} from "../schemas/demoSchema.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const router = Router();

// ─── Error helpers ────────────────────────────────────────────────────────

function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch((err) => {
      console.error("[demoRoutes]", err);
      const isZod = !!(err && typeof err === "object" && "issues" in err);
      const status = isZod ? 400 : 500;
      res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
    });
  };
}

function getClientId(req: Request): string {
  return (req.headers["x-client-id"] as string) || "unknown";
}

function toSummary(d: any): any {
  return {
    id: d.id,
    workspaceId: d.workspaceId,
    parentId: d.parentId,
    order: d.order,
    name: d.name,
    template: d.template,
    version: d.version,
    lastBuildStatus: d.lastBuildStatus,
    lastBuildAt: d.lastBuildAt?.toISOString?.() ?? d.lastBuildAt ?? null,
    publishSlug: d.publishSlug,
    publishedAt: d.publishedAt?.toISOString?.() ?? d.publishedAt ?? null,
    createdAt: d.createdAt?.toISOString?.() ?? d.createdAt,
    updatedAt: d.updatedAt?.toISOString?.() ?? d.updatedAt,
  };
}

async function toDetail(d: any, withFiles = false): Promise<DemoDetail> {
  const base: DemoDetail = {
    ...toSummary(d),
    dataTables: d.dataTables ?? [],
    dataIdeas: d.dataIdeas ?? [],
    capabilities: (d.capabilities ?? {}) as Capabilities,
    lastBuildError: d.lastBuildError ?? null,
    publishedVersion: d.publishedVersion ?? null,
  };
  if (withFiles) {
    try {
      const files = await store.listFiles(d.id);
      base.files = files.map((f) => ({
        path: f.path,
        size: f.size,
        updatedAt: f.updatedAt.toISOString(),
      }));
    } catch { /* ignore */ }
  }
  return base;
}

// ─── List ─────────────────────────────────────────────────────────────────

router.get("/", asyncHandler(async (req, res) => {
  const workspaceId = (req.query.workspaceId as string) || "doc_default";
  const rows = await prisma.demo.findMany({
    where: { workspaceId },
    orderBy: { order: "asc" },
  });
  res.json(rows.map(toSummary));
}));

// ─── Get ──────────────────────────────────────────────────────────────────

router.get("/:demoId", asyncHandler(async (req, res) => {
  const d = await prisma.demo.findUnique({ where: { id: req.params.demoId } });
  if (!d) { res.status(404).json({ error: "Demo not found" }); return; }
  const includeFiles = req.query.includeFiles !== "false";
  res.json(await toDetail(d, includeFiles));
}));

// ─── Create ───────────────────────────────────────────────────────────────

router.post("/", asyncHandler(async (req, res) => {
  const input = createDemoSchema.parse(req.body);
  const id = await generateId("demo", async (cand) =>
    (await prisma.demo.findUnique({ where: { id: cand }, select: { id: true } })) !== null
  );
  // Compute next order across sibling artifacts (same parent)
  const maxOrder = await prisma.demo.aggregate({
    where: { workspaceId: input.workspaceId, parentId: input.parentId ?? null },
    _max: { order: true },
  });
  const order = (maxOrder._max.order ?? -1) + 1;
  const demo = await prisma.demo.create({
    data: {
      id,
      workspaceId: input.workspaceId,
      name: input.name,
      template: input.template,
      parentId: input.parentId ?? null,
      order,
    },
  });
  await store.ensureDemoDir(id);
  // Scaffold minimal files based on template
  await scaffoldTemplate(id, input.template);

  eventBus.emitWorkspaceChange({
    type: "demo:create",
    workspaceId: input.workspaceId,
    clientId: getClientId(req),
    timestamp: Date.now(),
    payload: { demo: toSummary(demo) },
  });

  res.status(201).json(await toDetail(demo, true));
}));

async function scaffoldTemplate(demoId: string, template: string): Promise<void> {
  if (template === "react-spa") {
    await store.writeFile(
      demoId,
      "index.html",
      `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Demo</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script type="importmap">
  {
    "imports": {
      "react": "https://esm.sh/react@18",
      "react-dom/client": "https://esm.sh/react-dom@18/client",
      "react/jsx-runtime": "https://esm.sh/react@18/jsx-runtime"
    }
  }
  </script>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="./bundle.js"></script>
</body>
</html>
`,
    );
    await store.writeFile(
      demoId,
      "app.tsx",
      `import React from "react";
import { createRoot } from "react-dom/client";

function App() {
  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold">Hello from Demo</h1>
      <p className="text-gray-600 mt-2">Edit app.tsx to customize.</p>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
`,
    );
  } else {
    // static
    await store.writeFile(
      demoId,
      "index.html",
      `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Demo</title>
</head>
<body>
  <h1>Hello from Demo</h1>
  <p>Edit index.html to customize.</p>
</body>
</html>
`,
    );
  }
}

// ─── Rename ───────────────────────────────────────────────────────────────

router.patch("/:demoId", asyncHandler(async (req, res) => {
  const input = renameDemoSchema.parse(req.body);
  const d = await prisma.demo.update({
    where: { id: req.params.demoId },
    data: { name: input.name },
  });
  eventBus.emitWorkspaceChange({
    type: "demo:rename",
    workspaceId: d.workspaceId,
    clientId: getClientId(req),
    timestamp: Date.now(),
    payload: { demoId: d.id, name: d.name },
  });
  res.json(toSummary(d));
}));

// ─── Delete ───────────────────────────────────────────────────────────────

router.delete("/:demoId", asyncHandler(async (req, res) => {
  const d = await prisma.demo.findUnique({ where: { id: req.params.demoId } });
  if (!d) { res.status(404).json({ error: "Demo not found" }); return; }
  await prisma.demo.delete({ where: { id: d.id } });
  await store.deleteDemoDir(d.id);
  eventBus.emitWorkspaceChange({
    type: "demo:delete",
    workspaceId: d.workspaceId,
    clientId: getClientId(req),
    timestamp: Date.now(),
    payload: { demoId: d.id },
  });
  res.json({ ok: true });
}));

// ─── Update capabilities ──────────────────────────────────────────────────

router.put("/:demoId/capabilities", asyncHandler(async (req, res) => {
  const input = updateCapabilitiesSchema.parse(req.body);
  const d = await prisma.demo.update({
    where: { id: req.params.demoId },
    data: {
      dataTables: input.dataTables,
      dataIdeas: input.dataIdeas,
      capabilities: input.capabilities as any,
    },
  });
  res.json(await toDetail(d, false));
}));

// ─── File ops ─────────────────────────────────────────────────────────────

router.get("/:demoId/files", asyncHandler(async (req, res) => {
  const files = await store.listFiles(req.params.demoId);
  res.json(files.map((f) => ({ path: f.path, size: f.size, updatedAt: f.updatedAt.toISOString() })));
}));

router.get("/:demoId/file", asyncHandler(async (req, res) => {
  const p = req.query.path as string;
  if (!p) { res.status(400).json({ error: "path query required" }); return; }
  try {
    const content = await store.readFile(req.params.demoId, p);
    res.json({ path: p, content });
  } catch (err: any) {
    if (err?.code === "ENOENT") res.status(404).json({ error: "File not found" });
    else throw err;
  }
}));

router.put("/:demoId/file", asyncHandler(async (req, res) => {
  const input = writeDemoFileSchema.parse(req.body);
  await store.ensureDemoDir(req.params.demoId);
  await store.writeFile(req.params.demoId, input.path, input.content);
  const d = await prisma.demo.update({
    where: { id: req.params.demoId },
    data: { version: { increment: 1 } },
  });
  eventBus.emitWorkspaceChange({
    type: "demo:file-update",
    workspaceId: d.workspaceId,
    clientId: getClientId(req),
    timestamp: Date.now(),
    payload: { demoId: d.id, path: input.path, version: d.version },
  });
  res.json({ ok: true, version: d.version });
}));

router.delete("/:demoId/file", asyncHandler(async (req, res) => {
  const input = deleteDemoFileSchema.parse(req.body);
  await store.deleteFile(req.params.demoId, input.path);
  const d = await prisma.demo.update({
    where: { id: req.params.demoId },
    data: { version: { increment: 1 } },
  });
  res.json({ ok: true, version: d.version });
}));

// ─── Build ────────────────────────────────────────────────────────────────

router.post("/:demoId/build", asyncHandler(async (req, res) => {
  const d = await prisma.demo.findUnique({ where: { id: req.params.demoId } });
  if (!d) { res.status(404).json({ error: "Demo not found" }); return; }

  await prisma.demo.update({
    where: { id: d.id },
    data: { lastBuildStatus: "building", lastBuildError: null },
  });
  eventBus.emitWorkspaceChange({
    type: "demo:build-status",
    workspaceId: d.workspaceId,
    clientId: getClientId(req),
    timestamp: Date.now(),
    payload: { demoId: d.id, status: "building" },
  });

  const result = await buildDemo({
    demoId: d.id,
    template: d.template as "static" | "react-spa",
    dataTables: d.dataTables,
    dataIdeas: d.dataIdeas,
    capabilities: (d.capabilities ?? {}) as any,
  });

  await prisma.demo.update({
    where: { id: d.id },
    data: {
      lastBuildAt: new Date(),
      lastBuildStatus: result.ok ? "success" : "error",
      lastBuildError: result.ok ? null : result.error ?? null,
    },
  });

  eventBus.emitWorkspaceChange({
    type: "demo:build-status",
    workspaceId: d.workspaceId,
    clientId: getClientId(req),
    timestamp: Date.now(),
    payload: {
      demoId: d.id,
      status: result.ok ? "success" : "error",
      durationMs: result.durationMs,
      sizeBytes: result.sizeBytes,
      error: result.error,
    },
  });

  res.json(result);
}));

router.get("/:demoId/build-log", asyncHandler(async (req, res) => {
  const log = await store.readBuildLog(req.params.demoId);
  res.json({ log: log ?? "" });
}));

// ─── Publish / unpublish ──────────────────────────────────────────────────

router.post("/:demoId/publish", asyncHandler(async (req, res) => {
  const d = await prisma.demo.findUnique({ where: { id: req.params.demoId } });
  if (!d) { res.status(404).json({ error: "Demo not found" }); return; }
  const result = await publishDemo({ demoId: d.id, prisma });
  eventBus.emitWorkspaceChange({
    type: "demo:publish",
    workspaceId: d.workspaceId,
    clientId: getClientId(req),
    timestamp: Date.now(),
    payload: {
      demoId: d.id,
      slug: result.slug,
      publishedVersion: result.publishedVersion,
      url: result.url,
    },
  });
  res.json({ ok: true, ...result });
}));

router.post("/:demoId/unpublish", asyncHandler(async (req, res) => {
  const d = await prisma.demo.findUnique({ where: { id: req.params.demoId } });
  if (!d) { res.status(404).json({ error: "Demo not found" }); return; }
  await unpublishDemo({ demoId: d.id, prisma });
  eventBus.emitWorkspaceChange({
    type: "demo:unpublish",
    workspaceId: d.workspaceId,
    clientId: getClientId(req),
    timestamp: Date.now(),
    payload: { demoId: d.id },
  });
  res.json({ ok: true });
}));

// ─── Export as zip ────────────────────────────────────────────────────────

router.get("/:demoId/export", asyncHandler(async (req, res) => {
  const d = await prisma.demo.findUnique({ where: { id: req.params.demoId } });
  if (!d) { res.status(404).json({ error: "Demo not found" }); return; }
  const zip = await store.exportFilesAsZip(d.id);
  const safeName = d.name.replace(/[^a-zA-Z0-9_\-]/g, "_").slice(0, 60) || d.id;
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${safeName}.zip"`);
  res.send(zip);
}));

// ─── Private preview static serve ─────────────────────────────────────────
//
// `/api/demos/:demoId/preview/*` serves the demo's latest build output
// (dist/) for the iframe preview panel. Response headers set an iframe-
// friendly policy — scripts allowed, same-origin blocked on the iframe
// side (that's on the consumer's <iframe sandbox>).

// Shared handler: serves `index.html` when the URL is `/preview` or `/preview/`,
// otherwise serves the named file relative to dist/. We don't redirect
// because Express 4 route matching treats `/preview` and `/preview/` as
// equivalent (strict routing off) — redirecting "to add a slash" loops.
async function servePreview(req: Request, res: Response, rel: string): Promise<void> {
  const d = await prisma.demo.findUnique({ where: { id: req.params.demoId } });
  if (!d) { res.status(404).send("Demo not found"); return; }
  try {
    const abs = store.distFilePath(d.id, rel || "index.html");
    const content = await fsp.readFile(abs);
    res.setHeader("Content-Type", guessContentType(rel || "index.html"));
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; " +
      "script-src 'self' https://cdn.tailwindcss.com https://esm.sh 'unsafe-inline'; " +
      "style-src 'self' https://fonts.googleapis.com https://cdn.tailwindcss.com 'unsafe-inline'; " +
      "font-src 'self' https://fonts.gstatic.com data:; " +
      "img-src 'self' data: blob: https:; " +
      "connect-src 'self';",
    );
    res.send(content);
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      res.status(404).send("Not built yet — call POST /api/demos/:id/build first");
    } else {
      throw err;
    }
  }
}

router.get("/:demoId/preview", asyncHandler(async (req, res) => {
  await servePreview(req, res, "index.html");
}));

router.get("/:demoId/preview/*", asyncHandler(async (req, res) => {
  const rel = ((req.params as any)[0] as string) || "index.html";
  await servePreview(req, res, rel);
}));

function guessContentType(file: string): string {
  const ext = path.extname(file).toLowerCase();
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".mjs": "application/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".ico": "image/x-icon",
      ".woff": "font/woff",
      ".woff2": "font/woff2",
    }[ext] || "application/octet-stream"
  );
}

export default router;
export { prisma };
