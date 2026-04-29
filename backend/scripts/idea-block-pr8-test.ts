/**
 * PR8 backend test driver — block-level mutations.
 *
 * Tests:
 *   - getBlockWithContext: byte position correctness
 *   - spliceBlockContent / spliceBlockDelete / spliceBlockMove
 *   - transformBlockContent: each transform pair
 *   - End-to-end: full content stays consistent across N mutations
 *
 * Run: cd backend && npx tsx scripts/idea-block-pr8-test.ts
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

const TEST_PREFIX = "__pr8_";

async function createIdea(suffix: string, content: string) {
  const idea = await prisma.idea.create({
    data: { name: `${TEST_PREFIX}${suffix}`, workspaceId: "doc_default", content },
  });
  await prisma.$transaction(async (tx: any) => {
    await block.syncBlocksForIdea(tx, idea.id, content);
  });
  return idea;
}

async function reload(ideaId: string) {
  const idea = await prisma.idea.findUnique({ where: { id: ideaId } });
  if (!idea) throw new Error("idea gone");
  return idea;
}

// ─── getBlockWithContext ──────────────────────────────────────────────

await run("PR8-01-getBlockWithContext-byte-positions", async () => {
  const md = "# A\n\n# B\n\n# C\n";
  const idea = await createIdea("01", md);
  try {
    const blocks = await block.listBlocksForIdea(prisma as any, idea.id);
    // pick the middle block
    const ctx = await block.getBlockWithContext(prisma as any, blocks[1].id);
    assert(ctx.index === 1, `index ${ctx.index}`);
    assert(ctx.byteStart === blocks[0].content.length, "byteStart");
    assert(ctx.byteEnd === blocks[0].content.length + blocks[1].content.length, "byteEnd");
    // sanity: slice equals the block's content
    assert(idea.content.slice(ctx.byteStart, ctx.byteEnd) === blocks[1].content, "slice match");
  } finally {
    await prisma.idea.delete({ where: { id: idea.id } }).catch(() => {});
  }
});

await run("PR8-02-getBlockWithContext-not-found", async () => {
  let threw = false;
  try {
    await block.getBlockWithContext(prisma as any, "definitely-not-an-id");
  } catch (err) {
    threw = true;
    assert(err instanceof block.IdeaBlockNotFoundError, "right error type");
  }
  assert(threw, "should throw");
});

// ─── spliceBlockContent / Delete ──────────────────────────────────────

await run("PR8-10-splice-content", async () => {
  const md = "# A\n\n# B\n\n# C\n";
  const idea = await createIdea("10", md);
  try {
    const blocks = await block.listBlocksForIdea(prisma as any, idea.id);
    const ctx = await block.getBlockWithContext(prisma as any, blocks[1].id);
    const next = block.spliceBlockContent(ctx, "## NEW\n\n");
    assert(next === "# A\n\n## NEW\n\n# C\n", `got ${JSON.stringify(next)}`);
  } finally {
    await prisma.idea.delete({ where: { id: idea.id } }).catch(() => {});
  }
});

await run("PR8-11-splice-delete", async () => {
  const md = "# A\n\n# B\n\n# C\n";
  const idea = await createIdea("11", md);
  try {
    const blocks = await block.listBlocksForIdea(prisma as any, idea.id);
    const ctx = await block.getBlockWithContext(prisma as any, blocks[1].id);
    const next = block.spliceBlockDelete(ctx);
    assert(next === "# A\n\n# C\n", `got ${JSON.stringify(next)}`);
  } finally {
    await prisma.idea.delete({ where: { id: idea.id } }).catch(() => {});
  }
});

// ─── spliceBlockMove ──────────────────────────────────────────────────

await run("PR8-20-move-up", async () => {
  const md = "# A\n\n# B\n\n# C\n";
  const idea = await createIdea("20", md);
  try {
    const blocks = await block.listBlocksForIdea(prisma as any, idea.id);
    // Move C (index 2) to position 0
    const ctx = await block.getBlockWithContext(prisma as any, blocks[2].id);
    const next = block.spliceBlockMove(ctx, 0);
    assert(next === "# C\n\n# A\n\n# B\n", `got ${JSON.stringify(next)}`);
  } finally {
    await prisma.idea.delete({ where: { id: idea.id } }).catch(() => {});
  }
});

await run("PR8-21-move-down", async () => {
  const md = "# A\n\n# B\n\n# C\n";
  const idea = await createIdea("21", md);
  try {
    const blocks = await block.listBlocksForIdea(prisma as any, idea.id);
    const ctx = await block.getBlockWithContext(prisma as any, blocks[0].id);
    const next = block.spliceBlockMove(ctx, 2);
    assert(next === "# B\n\n# C\n\n# A\n", `got ${JSON.stringify(next)}`);
  } finally {
    await prisma.idea.delete({ where: { id: idea.id } }).catch(() => {});
  }
});

await run("PR8-22-move-noop", async () => {
  const md = "# A\n\n# B\n";
  const idea = await createIdea("22", md);
  try {
    const blocks = await block.listBlocksForIdea(prisma as any, idea.id);
    const ctx = await block.getBlockWithContext(prisma as any, blocks[0].id);
    const next = block.spliceBlockMove(ctx, 0);
    assert(next === md, "noop");
  } finally {
    await prisma.idea.delete({ where: { id: idea.id } }).catch(() => {});
  }
});

await run("PR8-23-move-clamp", async () => {
  const md = "# A\n\n# B\n";
  const idea = await createIdea("23", md);
  try {
    const blocks = await block.listBlocksForIdea(prisma as any, idea.id);
    const ctx = await block.getBlockWithContext(prisma as any, blocks[0].id);
    // toIndex too large → clamps to last
    const next = block.spliceBlockMove(ctx, 999);
    assert(next === "# B\n\n# A\n", `got ${JSON.stringify(next)}`);
  } finally {
    await prisma.idea.delete({ where: { id: idea.id } }).catch(() => {});
  }
});

// ─── transformBlockContent ────────────────────────────────────────────

// transformBlockContent preserves the input's trailing whitespace so the
// surrounding block separator survives. If the input ended with `\n\n`,
// the transformed output keeps `\n\n` (it's a non-last block in context).
await run("PR8-30-transform-paragraph-to-h2", async () => {
  const out = block.transformBlockContent("hello world\n\n", "paragraph", "heading-2");
  assert(out === "## hello world\n\n", `got ${JSON.stringify(out)}`);
});

await run("PR8-31-transform-h1-to-paragraph", async () => {
  const out = block.transformBlockContent("# Title\n\n", "heading", "paragraph");
  assert(out === "Title\n\n", `got ${JSON.stringify(out)}`);
});

await run("PR8-32-transform-paragraph-to-quote", async () => {
  const out = block.transformBlockContent("line one\nline two\n\n", "paragraph", "quote");
  assert(out === "> line one\n> line two\n\n", `got ${JSON.stringify(out)}`);
});

await run("PR8-33-transform-paragraph-to-list", async () => {
  const out = block.transformBlockContent("a\nb\nc\n\n", "paragraph", "list-bullet");
  assert(out === "- a\n- b\n- c\n\n", `got ${JSON.stringify(out)}`);
});

await run("PR8-34-transform-h2-to-h4", async () => {
  const out = block.transformBlockContent("## Hello\n\n", "heading", "heading-4");
  assert(out === "#### Hello\n\n", `got ${JSON.stringify(out)}`);
});

await run("PR8-35-transform-anything-to-divider", async () => {
  const out = block.transformBlockContent("some text\n\n", "paragraph", "divider");
  assert(out === "---\n\n", `got ${JSON.stringify(out)}`);
});

// Bonus: last-block transform with single \n trailing
await run("PR8-36-transform-last-block-keeps-single-newline", async () => {
  const out = block.transformBlockContent("hello\n", "paragraph", "heading-2");
  assert(out === "## hello\n", `got ${JSON.stringify(out)}`);
});

// ─── End-to-end consistency: chain mutations through real DB ──────────

await run("PR8-40-e2e-mutation-chain", async () => {
  const md = "# Title\n\npara 1\n\n## Sub\n\npara 2\n";
  const idea = await createIdea("40", md);
  try {
    // Step 1: convert "para 1" to a quote
    let blocks = await block.listBlocksForIdea(prisma as any, idea.id);
    const para1 = blocks.find((b) => b.type === "paragraph");
    assert(para1, "para1");
    let ctx = await block.getBlockWithContext(prisma as any, para1!.id);
    const transformed = block.transformBlockContent(ctx.block.content, ctx.block.type, "quote");
    let next = block.spliceBlockContent(ctx, transformed);
    await prisma.$transaction(async (tx: any) => {
      await tx.idea.update({ where: { id: idea.id }, data: { content: next } });
      await block.syncBlocksForIdea(tx, idea.id, next);
    });
    let cur = await reload(idea.id);
    assert(cur.content.includes("> para 1"), `step1: ${JSON.stringify(cur.content)}`);

    // Step 2: delete "## Sub"
    blocks = await block.listBlocksForIdea(prisma as any, idea.id);
    const sub = blocks.find((b) => b.type === "heading" && (b.props as any).level === 2);
    assert(sub, "sub heading");
    ctx = await block.getBlockWithContext(prisma as any, sub!.id);
    next = block.spliceBlockDelete(ctx);
    await prisma.$transaction(async (tx: any) => {
      await tx.idea.update({ where: { id: idea.id }, data: { content: next } });
      await block.syncBlocksForIdea(tx, idea.id, next);
    });
    cur = await reload(idea.id);
    assert(!cur.content.includes("## Sub"), "sub gone");
    assert(cur.content.includes("> para 1"), "para 1 still quoted");
    assert(cur.content.includes("para 2"), "para 2 preserved");

    // Step 3: move "para 2" to start
    blocks = await block.listBlocksForIdea(prisma as any, idea.id);
    const para2 = blocks.find((b) => b.type === "paragraph" && b.content.includes("para 2"));
    assert(para2, "para2");
    ctx = await block.getBlockWithContext(prisma as any, para2!.id);
    next = block.spliceBlockMove(ctx, 0);
    await prisma.$transaction(async (tx: any) => {
      await tx.idea.update({ where: { id: idea.id }, data: { content: next } });
      await block.syncBlocksForIdea(tx, idea.id, next);
    });
    cur = await reload(idea.id);
    // para 2 should now appear before "# Title"
    const idxPara2 = cur.content.indexOf("para 2");
    const idxTitle = cur.content.indexOf("# Title");
    assert(idxPara2 < idxTitle, `move: para2(${idxPara2}) should precede title(${idxTitle})`);
  } finally {
    await prisma.idea.delete({ where: { id: idea.id } }).catch(() => {});
  }
});

// ─── Cleanup ──────────────────────────────────────────────────────────

const passed = results.filter((r) => r.status === "PASS").length;
const failed = results.filter((r) => r.status === "FAIL").length;
console.log(`\n=== PR8 RESULTS ===\nTotal: ${results.length}, PASS: ${passed}, FAIL: ${failed}\n`);

const stale = await prisma.idea.findMany({ where: { name: { startsWith: TEST_PREFIX } } });
for (const s of stale) await prisma.idea.delete({ where: { id: s.id } }).catch(() => {});
console.log(`[cleanup] removed ${stale.length} __pr8_* idea rows`);

process.exit(failed > 0 ? 1 : 0);
