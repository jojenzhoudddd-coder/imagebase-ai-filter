/**
 * PR5 test driver — Idea attachment 管线 (service + dedup + reap + cascade).
 *
 * Run: cd backend && npx tsx scripts/idea-attachment-pr5-test.ts
 *
 * Each test gets fresh BlobStorage root via mkdtemp + IMAGEBASE_HOME override.
 * Real prisma DB used (test rows prefixed `__pr5_*`, cleaned at end).
 */
import * as dotenv from "dotenv";
dotenv.config();

import { promises as fs, existsSync } from "fs";
import * as os from "os";
import * as path from "path";

interface TestResult { id: string; status: "PASS" | "FAIL"; error?: string }
const results: TestResult[] = [];

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
async function run(id: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ id, status: "PASS" });
    console.log(`  [PASS] ${id}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    results.push({ id, status: "FAIL", error: message });
    console.log(`  [FAIL] ${id} — ${message}`);
  }
}
async function withFreshFs<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pr5-"));
  const oldHome = process.env.IMAGEBASE_HOME;
  process.env.IMAGEBASE_HOME = root;
  delete process.env.BLOB_STORAGE_BACKEND;
  const storage = await import("../src/services/storage/index.js");
  storage._resetBlobStorageForTest();
  try {
    return await fn(root);
  } finally {
    process.env.IMAGEBASE_HOME = oldHome;
    storage._resetBlobStorageForTest();
    await fs.rm(root, { recursive: true, force: true });
  }
}

const TEST_PREFIX = "__pr5_";

const att = await import("../src/services/ideaAttachmentService.js");
const { PrismaClient } = await import("../src/generated/prisma/client.js");
const pg = (await import("pg")).default;
const { PrismaPg } = await import("@prisma/adapter-pg");
const prisma = new PrismaClient({
  adapter: new PrismaPg(new pg.Pool({ connectionString: process.env.DATABASE_URL })),
});

// Helper:create a real idea row to attach to
async function createTestIdea(suffix: string) {
  return prisma.idea.create({
    data: { name: `${TEST_PREFIX}${suffix}`, workspaceId: "doc_default" },
  });
}

// ─── PR5-01: validation ──────────────────────────────────────────────

await run("PR5-01-mime-whitelist", async () => {
  for (const allowed of ["image/png", "image/svg+xml", "application/pdf", "video/mp4"]) {
    const r = att.validateUpload({ mime: allowed, size: 1024 });
    assert(typeof r.ext === "string" && r.ext.length > 0, `${allowed} ext`);
  }
});

await run("PR5-02-mime-rejected", async () => {
  for (const bad of ["application/x-msdownload", "text/html", "image/tiff", ""]) {
    let threw = false;
    try { att.validateUpload({ mime: bad, size: 100 }); } catch { threw = true; }
    assert(threw, `should reject mime "${bad}"`);
  }
});

await run("PR5-03-size-limits", async () => {
  // SVG 1MB cap
  let threw = false;
  try { att.validateUpload({ mime: "image/svg+xml", size: 1024 * 1024 + 1 }); }
  catch { threw = true; }
  assert(threw, "SVG > 1MB should fail");
  // PNG 10MB ok
  att.validateUpload({ mime: "image/png", size: 10 * 1024 * 1024 });
  // PNG 10MB+1 fail
  threw = false;
  try { att.validateUpload({ mime: "image/png", size: 10 * 1024 * 1024 + 1 }); }
  catch { threw = true; }
  assert(threw, "PNG > 10MB should fail");
});

await run("PR5-04-zero-size-rejected", async () => {
  let threw = false;
  try { att.validateUpload({ mime: "image/png", size: 0 }); } catch { threw = true; }
  assert(threw, "size 0 should fail");
});

// ─── PR5-10: upload + read ───────────────────────────────────────────

await run("PR5-10-upload-creates-row-and-blob", async () => {
  await withFreshFs(async (root) => {
    const idea = await createTestIdea("10");
    try {
      const buf = Buffer.from("hello");
      const r = await att.uploadAttachment({
        ideaId: idea.id,
        workspaceId: "doc_default",
        buffer: buf,
        mime: "image/png",
        originalName: "hi.png",
      });
      assert(r.id, "row created");
      assert(r.url.startsWith("/api/idea-attachments/"), `url: ${r.url}`);
      const blobPath = path.join(root, "idea-attachments/doc_default", `${r.hash}.png`);
      assert(existsSync(blobPath), `blob missing at ${blobPath}`);
    } finally {
      await prisma.idea.delete({ where: { id: idea.id } }).catch(() => {});
    }
  });
});

await run("PR5-11-hash-is-sha256", async () => {
  await withFreshFs(async () => {
    const idea = await createTestIdea("11");
    try {
      const buf = Buffer.from("hello");
      const r = await att.uploadAttachment({
        ideaId: idea.id, workspaceId: "doc_default", buffer: buf, mime: "image/png",
      });
      // sha256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
      assert(
        r.hash === "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
        `unexpected hash: ${r.hash}`,
      );
    } finally {
      await prisma.idea.delete({ where: { id: idea.id } }).catch(() => {});
    }
  });
});

await run("PR5-12-roundtrip-by-path", async () => {
  await withFreshFs(async () => {
    const idea = await createTestIdea("12");
    try {
      const buf = Buffer.from("svg-here");
      const r = await att.uploadAttachment({
        ideaId: idea.id, workspaceId: "doc_default", buffer: buf, mime: "image/svg+xml",
      });
      const found = await att.findByPath("doc_default", `${r.hash}.svg`);
      assert(found, "findByPath returned null");
      assert(found!.id === r.id, "id mismatch");
      assert(found!.size === 8, `size: ${found!.size}`);
    } finally {
      await prisma.idea.delete({ where: { id: idea.id } }).catch(() => {});
    }
  });
});

// ─── PR5-20: dedup ──────────────────────────────────────────────────

await run("PR5-20-same-hash-dedups-blob", async () => {
  await withFreshFs(async (root) => {
    const idea = await createTestIdea("20");
    try {
      const buf = Buffer.from("dedup-me");
      const r1 = await att.uploadAttachment({
        ideaId: idea.id, workspaceId: "doc_default", buffer: buf, mime: "image/png",
      });
      const r2 = await att.uploadAttachment({
        ideaId: idea.id, workspaceId: "doc_default", buffer: buf, mime: "image/png",
      });
      assert(r1.id !== r2.id, "should be 2 rows");
      assert(r1.hash === r2.hash, "hash should match");
      // Only one blob file exists (we wrote idempotently)
      const blobPath = path.join(root, "idea-attachments/doc_default", `${r1.hash}.png`);
      assert(existsSync(blobPath), "blob exists");
    } finally {
      await prisma.idea.delete({ where: { id: idea.id } }).catch(() => {});
    }
  });
});

await run("PR5-21-cross-workspace-no-dedup", async () => {
  // Different workspaces should not dedup. Only verifying the key namespace —
  // we don't have a second real workspace row to attach to, so we directly
  // call buildAttachmentKey to confirm it produces different keys.
  const k1 = att.buildAttachmentKey("ws_a", "abc123def", "png");
  const k2 = att.buildAttachmentKey("ws_b", "abc123def", "png");
  assert(k1 !== k2, "cross-workspace keys should differ");
});

// ─── PR5-30: delete + reap ──────────────────────────────────────────

await run("PR5-30-delete-keeps-blob-when-shared", async () => {
  await withFreshFs(async (root) => {
    const idea = await createTestIdea("30");
    try {
      const buf = Buffer.from("shared-blob");
      const r1 = await att.uploadAttachment({
        ideaId: idea.id, workspaceId: "doc_default", buffer: buf, mime: "image/png",
      });
      const r2 = await att.uploadAttachment({
        ideaId: idea.id, workspaceId: "doc_default", buffer: buf, mime: "image/png",
      });
      const blobPath = path.join(root, "idea-attachments/doc_default", `${r1.hash}.png`);
      await att.deleteAttachment(r1.id);
      assert(existsSync(blobPath), "blob should remain after first delete (refcount=1)");
      await att.deleteAttachment(r2.id);
      assert(!existsSync(blobPath), "blob should be reaped after last delete");
    } finally {
      await prisma.idea.delete({ where: { id: idea.id } }).catch(() => {});
    }
  });
});

await run("PR5-31-delete-missing-row-noop", async () => {
  await withFreshFs(async () => {
    await att.deleteAttachment("definitely_not_an_id"); // should NOT throw
  });
});

// ─── PR5-40: cascade on idea delete ─────────────────────────────────

await run("PR5-40-idea-delete-cascades-rows", async () => {
  await withFreshFs(async () => {
    const idea = await createTestIdea("40");
    const buf = Buffer.from("cascade-test");
    const r = await att.uploadAttachment({
      ideaId: idea.id, workspaceId: "doc_default", buffer: buf, mime: "image/png",
    });
    // FK ON DELETE CASCADE: removing idea should remove attachment rows.
    await prisma.idea.delete({ where: { id: idea.id } });
    const found = await prisma.ideaAttachment.findUnique({ where: { id: r.id } });
    assert(found === null, "cascade should have deleted attachment row");
  });
});

await run("PR5-41-idea-delete-snapshot-then-reap", async () => {
  await withFreshFs(async (root) => {
    const idea = await createTestIdea("41");
    const buf = Buffer.from("snapshot-then-reap");
    const r = await att.uploadAttachment({
      ideaId: idea.id, workspaceId: "doc_default", buffer: buf, mime: "image/png",
    });
    const blobPath = path.join(root, "idea-attachments/doc_default", `${r.hash}.png`);
    // Mimic the route flow: snapshot → cascade delete → reap
    const snap = await att.snapshotAttachmentBlobs(idea.id);
    assert(snap.workspaceId === "doc_default", "snapshot ws");
    assert(snap.pairs.length === 1, "snapshot pairs");
    await prisma.idea.delete({ where: { id: idea.id } });
    const removed = await att.reapBlobsByHashes(snap.workspaceId, snap.pairs);
    assert(removed.length === 1, `should have reaped 1 blob, got ${removed.length}`);
    assert(!existsSync(blobPath), "blob should be gone after reap");
  });
});

// ─── PR5-50: path safety ────────────────────────────────────────────

await run("PR5-50-buildKey-rejects-traversal", async () => {
  for (const bad of [
    ["../escape", "abc", "png"],
    ["ws", "../escape", "png"],
    ["ws", "abc", "../"],
    ["ws", "NOT-HEX", "png"],
    ["ws", "abc", "PNG"],   // ext must be lowercase
    ["ws", "abc", "p/q"],
  ]) {
    let threw = false;
    try { att.buildAttachmentKey(bad[0], bad[1], bad[2]); } catch { threw = true; }
    assert(threw, `should reject ${JSON.stringify(bad)}`);
  }
});

// ─── PR5-60: list ────────────────────────────────────────────────────

await run("PR5-60-list-for-idea", async () => {
  await withFreshFs(async () => {
    const idea = await createTestIdea("60");
    try {
      for (let i = 0; i < 3; i++) {
        await att.uploadAttachment({
          ideaId: idea.id, workspaceId: "doc_default",
          buffer: Buffer.from(`unique-${i}`), mime: "image/png",
        });
      }
      const list = await att.listForIdea(idea.id);
      assert(list.length === 3, `expected 3, got ${list.length}`);
    } finally {
      await prisma.idea.delete({ where: { id: idea.id } }).catch(() => {});
    }
  });
});

// ─── Summary + cleanup ──────────────────────────────────────────────

const passed = results.filter(r => r.status === "PASS").length;
const failed = results.filter(r => r.status === "FAIL").length;
console.log(`\n=== PR5 RESULTS ===\nTotal: ${results.length}, PASS: ${passed}, FAIL: ${failed}\n`);

// DB cleanup
const stale = await prisma.idea.findMany({
  where: { name: { startsWith: TEST_PREFIX } },
});
for (const r of stale) {
  await prisma.idea.delete({ where: { id: r.id } }).catch(() => {});
}
console.log(`[cleanup] removed ${stale.length} __pr5_* idea rows`);

process.exit(failed > 0 ? 1 : 0);
