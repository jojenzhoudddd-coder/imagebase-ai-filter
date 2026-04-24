/**
 * demoPublishService — snapshot dist/ into published/<version>/ and
 * allocate a public slug.
 *
 * Semantics (see docs/vibe-demo-plan.md §8):
 *  - First publish: allocate fresh slug + publishedVersion=1
 *  - Re-publish: same slug, publishedVersion++
 *  - Unpublish: clear slug + publishedAt; keep published/ dirs (user may undo)
 *  - Slug is 12-char base62 (distinct from internal 12-digit numeric ids).
 */

import { PrismaClient } from "../../generated/prisma/client.js";
import * as store from "./demoFileStore.js";
import { generateSlugCandidate } from "../../schemas/demoSchema.js";

export interface PublishInput {
  demoId: string;
  prisma: PrismaClient;
}

export interface PublishResult {
  demoId: string;
  slug: string;
  publishedVersion: number;
  publishedAt: Date;
  url: string;
}

const PUBLIC_URL_BASE =
  process.env.PUBLIC_URL_BASE ||
  (process.env.NODE_ENV === "production"
    ? "https://www.imagebase.cc"
    : "http://localhost:5173"); // FE dev server proxies /share to backend

export async function publishDemo({
  demoId,
  prisma,
}: PublishInput): Promise<PublishResult> {
  const demo = await prisma.demo.findUnique({ where: { id: demoId } });
  if (!demo) throw new Error(`Demo not found: ${demoId}`);

  // Require a successful build — published/<N>/ is copied from dist/
  if (!(await store.hasDist(demoId))) {
    throw new Error(
      "Demo 还没有成功构建过 (dist/ 为空)。先调 build_demo 产出可发布内容。",
    );
  }

  // Allocate slug (reuse on re-publish, generate fresh on first publish)
  let slug = demo.publishSlug;
  if (!slug) {
    slug = await allocateSlug(prisma);
  }

  const nextVersion = (demo.publishedVersion ?? 0) + 1;

  // Copy dist/ → published/<nextVersion>/
  await store.copyDistToPublished(demoId, nextVersion);

  const publishedAt = new Date();
  await prisma.demo.update({
    where: { id: demoId },
    data: {
      publishSlug: slug,
      publishedVersion: nextVersion,
      publishedAt,
      // Stamp the source version at the moment we publish. Subsequent file
      // writes bump `version` further; the FE compares (version >
      // sourceVersionAtPublish) to decide whether to show the "has unpublished
      // changes" green dot + Republish button.
      sourceVersionAtPublish: demo.version,
    },
  });

  return {
    demoId,
    slug,
    publishedVersion: nextVersion,
    publishedAt,
    url: `${PUBLIC_URL_BASE}/share/${slug}`,
  };
}

export async function unpublishDemo({
  demoId,
  prisma,
}: {
  demoId: string;
  prisma: PrismaClient;
}): Promise<void> {
  await prisma.demo.update({
    where: { id: demoId },
    data: {
      publishSlug: null,
      // publishedVersion stays — we kept the snapshot on disk so user can
      // re-publish with a different slug to "take back" the old URL.
      publishedAt: null,
      // Clear the version stamp so re-publish starts fresh (no leftover
      // "has unpublished changes" indicator on the newly unpublished demo).
      sourceVersionAtPublish: null,
    },
  });
}

async function allocateSlug(prisma: PrismaClient): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const cand = generateSlugCandidate();
    const conflict = await prisma.demo.findUnique({
      where: { publishSlug: cand },
      select: { id: true },
    });
    if (!conflict) return cand;
  }
  throw new Error("slug collision five times in a row — should be extremely rare");
}

/** Resolve slug → {demoId, publishedVersion} for public `/share/:slug/*` serve. */
export async function resolveSlug(
  prisma: PrismaClient,
  slug: string,
): Promise<{ demoId: string; publishedVersion: number } | null> {
  const demo = await prisma.demo.findUnique({
    where: { publishSlug: slug },
    select: { id: true, publishedVersion: true },
  });
  if (!demo || !demo.publishedVersion) return null;
  return { demoId: demo.id, publishedVersion: demo.publishedVersion };
}
