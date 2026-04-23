/**
 * /share/:slug/* — public anonymous access to published Demo snapshots.
 *
 * No authentication, no capability check here — the Demo's declared
 * capabilities are the ACL. All requests to /api/demo-runtime/:demoId/*
 * that originate from inside this iframe still go through demoCapabilityGuard.
 *
 * This route only serves the static snapshot files from published/<N>/.
 * See docs/vibe-demo-plan.md §8.
 */

import { Router, type Request, type Response } from "express";
import path from "path";
import fsp from "fs/promises";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";
import * as store from "../services/demo/demoFileStore.js";
import { resolveSlug } from "../services/demo/demoPublishService.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const router = Router();

async function serveShare(req: Request, res: Response, rel: string): Promise<void> {
  try {
    const slug = req.params.slug;
    const resolved = await resolveSlug(prisma, slug);
    if (!resolved) {
      res.status(404).type("text/plain").send("Demo not found or unpublished.");
      return;
    }
    const { demoId, publishedVersion } = resolved;
    const abs = store.publishedFilePath(demoId, publishedVersion, rel);
    let content: Buffer;
    try {
      content = await fsp.readFile(abs);
    } catch {
      res.status(404).type("text/plain").send("File not found in published snapshot.");
      return;
    }

    // The SDK that ships with the published snapshot expects window.location
    // to be on our origin and fetches /api/demo-runtime/:demoId/* relative
    // to location.origin. That means a published demo on /share/:slug
    // automatically uses the RIGHT demoId because the SDK was generated with
    // DEMO_ID baked in at build time. No path rewriting needed here.

    res.setHeader("Content-Type", contentType(rel));
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; " +
      "script-src 'self' https://cdn.tailwindcss.com https://esm.sh 'unsafe-inline'; " +
      "style-src 'self' https://fonts.googleapis.com https://cdn.tailwindcss.com 'unsafe-inline'; " +
      "font-src 'self' https://fonts.gstatic.com data:; " +
      "img-src 'self' data: blob: https:; " +
      "connect-src 'self';",
    );
    // Discourage indexing
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    // Short cache — allows re-publish to take effect within 5 minutes
    res.setHeader("Cache-Control", "public, max-age=300");
    res.send(content);
  } catch (err) {
    console.error("[publicDemoRoutes]", err);
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

router.get("/:slug", async (req: Request, res: Response) => {
  await serveShare(req, res, "index.html");
});

router.get("/:slug/*", async (req: Request, res: Response) => {
  const rel = ((req.params as any)[0] as string) || "index.html";
  await serveShare(req, res, rel);
});

function contentType(file: string): string {
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
