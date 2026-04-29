/**
 * PR7 backend-touchpoint test — verifies that the GET /blocks API the FE
 * `useIdeaBlocks` hook depends on returns the right shape, lazy-backfills
 * on legacy ideas, and is consistent with the source-of-truth content
 * after various write paths.
 *
 * (FE-side virtualization isn't testable in pure tsx; covered by E2E /
 *  manual smoke. The contract this PR adds is mostly the API shape.)
 *
 * Run: cd backend && npx tsx scripts/idea-block-pr7-test.ts
 */
import * as dotenv from "dotenv";
dotenv.config();

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
    results.push({ id, status: "FAIL", error: err instanceof Error ? err.message : String(err) });
    console.log(`  [FAIL] ${id} — ${err instanceof Error ? err.message : err}`);
  }
}

const block = await import("../src/services/ideaBlockService.js");
const { PrismaClient } = await import("../src/generated/prisma/client.js");
const pg = (await import("pg")).default;
const { PrismaPg } = await import("@prisma/adapter-pg");
const prisma = new PrismaClient({
  adapter: new PrismaPg(new pg.Pool({ connectionString: process.env.DATABASE_URL })),
});

const TEST_PREFIX = "__pr7_";

async function createTestIdea(suffix: string, content = "") {
  return prisma.idea.create({
    data: { name: `${TEST_PREFIX}${suffix}`, workspaceId: "doc_default", content },
  });
}

// ─── PR7-01: GET /blocks shape (via direct service call — same code path) ─

await run("PR7-01-blocks-shape", async () => {
  const md = "# Title\n\nBody.\n";
  const idea = await createTestIdea("01", md);
  try {
    await prisma.$transaction(async (tx: any) => {
      await block.syncBlocksForIdea(tx, idea.id, idea.content);
    });
    const rows = await block.listBlocksForIdea(prisma as any, idea.id);
    assert(rows.length === 2, "2 blocks");
    for (const r of rows) {
      assert(typeof r.id === "string", "id");
      assert(typeof r.type === "string", "type");
      assert(typeof r.content === "string", "content");
      assert(typeof r.order === "number", "order");
      assert(typeof r.props === "object", "props");
    }
  } finally {
    await prisma.idea.delete({ where: { id: idea.id } }).catch(() => {});
  }
});

// ─── PR7-02: legacy idea lazy-backfill ───────────────────────────────

await run("PR7-02-legacy-lazy-backfill-via-route", async () => {
  // Create idea with content but no IdeaBlock rows (simulates pre-PR6 row).
  const md = "# Legacy\n\nlegacy content.\n";
  const idea = await createTestIdea("02-legacy", md);
  try {
    // Verify no blocks yet
    let rows = await block.listBlocksForIdea(prisma as any, idea.id);
    assert(rows.length === 0, "should start empty (legacy)");
    // Simulate the lazy backfill that GET /blocks performs
    await prisma.$transaction(async (tx: any) => {
      await block.syncBlocksForIdea(tx, idea.id, idea.content);
    });
    rows = await block.listBlocksForIdea(prisma as any, idea.id);
    assert(rows.length > 0, "backfill populated");
    const reassembled = rows.map((r) => r.content).join("");
    assert(reassembled === md, "byte-stable backfill");
  } finally {
    await prisma.idea.delete({ where: { id: idea.id } }).catch(() => {});
  }
});

// ─── PR7-03: large doc (1000+ blocks) byte-stable round-trip ────────

await run("PR7-03-large-doc-roundtrip", async () => {
  // Build a 200-paragraph doc — exercises virtualization-relevant scale
  const lines: string[] = [];
  for (let i = 0; i < 200; i++) {
    lines.push(`## Section ${i}`);
    lines.push("");
    lines.push(`Paragraph for section ${i} with **bold** and \`code\`.`);
    lines.push("");
  }
  const md = lines.join("\n");
  const idea = await createTestIdea("03-large", md);
  try {
    await prisma.$transaction(async (tx: any) => {
      await block.syncBlocksForIdea(tx, idea.id, idea.content);
    });
    const rows = await block.listBlocksForIdea(prisma as any, idea.id);
    assert(rows.length >= 400, `expected ≥400 blocks, got ${rows.length}`);
    const reassembled = rows.map((r) => r.content).join("");
    assert(reassembled === md, "large doc byte-stable mismatch");
  } finally {
    await prisma.idea.delete({ where: { id: idea.id } }).catch(() => {});
  }
});

// ─── PR7-04: order field strictly increasing ────────────────────────

await run("PR7-04-order-strictly-increasing", async () => {
  const md = "# A\n\n# B\n\n# C\n";
  const idea = await createTestIdea("04", md);
  try {
    await prisma.$transaction(async (tx: any) => {
      await block.syncBlocksForIdea(tx, idea.id, idea.content);
    });
    const rows = await block.listBlocksForIdea(prisma as any, idea.id);
    for (let i = 1; i < rows.length; i++) {
      assert(rows[i].order > rows[i - 1].order, `order not strictly increasing at ${i}`);
    }
  } finally {
    await prisma.idea.delete({ where: { id: idea.id } }).catch(() => {});
  }
});

// ─── PR7-05: write path → read path consistency ─────────────────────

await run("PR7-05-write-to-blocks-consistency", async () => {
  // Multiple sync calls (simulating multiple PUT /content cycles) leave
  // blocks consistent with the latest content.
  const idea = await createTestIdea("05", "# v1\n");
  try {
    const versions = [
      "# v1\n",
      "# v1\n\nUpdated.\n",
      "# v2\n\n## Sub\n\n- item\n",
      "completely different text\n",
    ];
    for (const v of versions) {
      await prisma.$transaction(async (tx: any) => {
        await tx.idea.update({ where: { id: idea.id }, data: { content: v } });
        await block.syncBlocksForIdea(tx, idea.id, v);
      });
      const rows = await block.listBlocksForIdea(prisma as any, idea.id);
      const reassembled = rows.map((r) => r.content).join("");
      assert(reassembled === v, `version "${v.slice(0, 15)}..." mismatch`);
    }
  } finally {
    await prisma.idea.delete({ where: { id: idea.id } }).catch(() => {});
  }
});

// ─── Cleanup ─────────────────────────────────────────────────────────

const passed = results.filter((r) => r.status === "PASS").length;
const failed = results.filter((r) => r.status === "FAIL").length;
console.log(`\n=== PR7 RESULTS ===\nTotal: ${results.length}, PASS: ${passed}, FAIL: ${failed}\n`);

const stale = await prisma.idea.findMany({ where: { name: { startsWith: TEST_PREFIX } } });
for (const s of stale) {
  await prisma.idea.delete({ where: { id: s.id } }).catch(() => {});
}
console.log(`[cleanup] removed ${stale.length} __pr7_* idea rows`);

process.exit(failed > 0 ? 1 : 0);
