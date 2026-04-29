/**
 * PR6 test driver — Idea schema 双轨 (IdeaBlock 表 + parseToBlocks +
 * 写路径同步 + GET /blocks).
 *
 * Run: cd backend && npx tsx scripts/idea-block-pr6-test.ts
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
    const message = err instanceof Error ? err.message : String(err);
    results.push({ id, status: "FAIL", error: message });
    console.log(`  [FAIL] ${id} — ${message}`);
  }
}

const block = await import("../src/services/ideaBlockService.js");
const { PrismaClient } = await import("../src/generated/prisma/client.js");
const pg = (await import("pg")).default;
const { PrismaPg } = await import("@prisma/adapter-pg");
const prisma = new PrismaClient({
  adapter: new PrismaPg(new pg.Pool({ connectionString: process.env.DATABASE_URL })),
});

const TEST_PREFIX = "__pr6_";

async function createTestIdea(suffix: string, content = "") {
  return prisma.idea.create({
    data: { name: `${TEST_PREFIX}${suffix}`, workspaceId: "doc_default", content },
  });
}

// ─── Parser correctness ──────────────────────────────────────────────

await run("PR6-01-empty-input", async () => {
  const r = block.parseToBlocks("");
  assert(r.length === 0, `empty input → 0 blocks, got ${r.length}`);
});

await run("PR6-02-roundtrip-headings", async () => {
  const md = "# H1\n\n## H2\n\n### H3\n";
  const blocks = block.parseToBlocks(md);
  assert(blocks.length === 3, `3 headings, got ${blocks.length}`);
  assert((blocks[0].props as any).level === 1, "h1 level");
  assert((blocks[1].props as any).level === 2, "h2 level");
  assert((blocks[2].props as any).level === 3, "h3 level");
  assert((blocks[0].props as any).slug === "h1", "h1 slug");
  assert(block.reassembleBlocks(blocks) === md, "roundtrip mismatch");
});

await run("PR6-03-roundtrip-mixed", async () => {
  const md = "# Title\n\nA paragraph.\n\n## Sec\n\n- item 1\n- item 2\n\n```js\nconsole.log('hi');\n```\n\n> quote\n\n---\n";
  const blocks = block.parseToBlocks(md);
  assert(block.reassembleBlocks(blocks) === md, "roundtrip mismatch");
  const types = blocks.map(b => b.type);
  assert(types.includes("heading"), "has heading");
  assert(types.includes("paragraph"), "has paragraph");
  assert(types.includes("list"), "has list");
  assert(types.includes("code"), "has code");
  assert(types.includes("quote"), "has quote");
  assert(types.includes("divider"), "has divider");
});

await run("PR6-04-roundtrip-table", async () => {
  const md = "| H1 | H2 |\n|----|----|\n| a  | b  |\n| c  | d  |\n";
  const blocks = block.parseToBlocks(md);
  const t = blocks.find(b => b.type === "table");
  assert(t, "table block missing");
  assert((t!.props as any).columns === 2, "columns");
  assert(block.reassembleBlocks(blocks) === md, "roundtrip mismatch");
});

await run("PR6-05-roundtrip-html-block", async () => {
  const md = "Some text.\n\n<div>\n  <strong>html</strong>\n</div>\n\nMore text.\n";
  const blocks = block.parseToBlocks(md);
  const html = blocks.find(b => b.type === "html");
  assert(html, "html block missing");
  assert((html!.props as any).tag === "div", "html tag");
  assert(block.reassembleBlocks(blocks) === md, "roundtrip mismatch");
});

await run("PR6-06-roundtrip-code-with-fence-language", async () => {
  const md = "```typescript\nconst x = 1;\n```\n";
  const blocks = block.parseToBlocks(md);
  assert(blocks.length === 1, "1 block");
  assert(blocks[0].type === "code", "code");
  assert((blocks[0].props as any).language === "typescript", "language");
  assert(block.reassembleBlocks(blocks) === md, "roundtrip");
});

await run("PR6-07-roundtrip-no-trailing-newline", async () => {
  const md = "# Heading\n\nLast line no newline";
  const blocks = block.parseToBlocks(md);
  assert(block.reassembleBlocks(blocks) === md, `roundtrip mismatch: ${JSON.stringify(block.reassembleBlocks(blocks))}`);
});

await run("PR6-08-heading-slug-dedupe", async () => {
  const md = "# Same\n\n# Same\n\n# Same\n";
  const blocks = block.parseToBlocks(md);
  const slugs = blocks.map(b => (b.props as any).slug);
  assert(slugs[0] === "same", "first");
  assert(slugs[1] === "same-1", "second");
  assert(slugs[2] === "same-2", "third");
});

await run("PR6-09-fence-not-misparsed", async () => {
  // Inside a fenced code, a `# ` line should NOT be parsed as heading.
  const md = "```\n# not a heading\n## also not\n- not a list\n```\n";
  const blocks = block.parseToBlocks(md);
  assert(blocks.length === 1, `inside-fence content should be one block, got ${blocks.length}`);
  assert(blocks[0].type === "code", "code");
  assert(block.reassembleBlocks(blocks) === md, "roundtrip");
});

await run("PR6-10-ordered-list", async () => {
  const md = "1. one\n2. two\n3. three\n";
  const blocks = block.parseToBlocks(md);
  assert(blocks.length === 1, `1 list block, got ${blocks.length}`);
  assert(blocks[0].type === "list", "list");
  assert((blocks[0].props as any).ordered === true, "ordered");
  assert((blocks[0].props as any).startsAt === 1, "startsAt");
});

await run("PR6-11-only-blank-lines", async () => {
  const md = "\n\n\n";
  const blocks = block.parseToBlocks(md);
  assert(block.reassembleBlocks(blocks) === md, "blank-only roundtrip");
});

await run("PR6-12-cjk-content", async () => {
  const md = "# 中文标题\n\n这是段落。\n\n- 项目一\n- 项目二\n";
  const blocks = block.parseToBlocks(md);
  assert(block.reassembleBlocks(blocks) === md, "cjk roundtrip");
  assert(blocks[0].type === "heading", "heading");
});

// ─── DB sync ─────────────────────────────────────────────────────────

await run("PR6-20-sync-fresh-idea", async () => {
  const idea = await createTestIdea("20", "# Hello\n\nWorld\n");
  try {
    await prisma.$transaction(async (tx: any) => {
      await block.syncBlocksForIdea(tx, idea.id, idea.content);
    });
    const blocks = await block.listBlocksForIdea(prisma as any, idea.id);
    assert(blocks.length === 2, `expected 2 blocks, got ${blocks.length}`);
    assert(blocks[0].type === "heading", "block[0] heading");
    assert(blocks[1].type === "paragraph", "block[1] paragraph");
    assert(blocks[0].order < blocks[1].order, "order");
  } finally {
    await prisma.idea.delete({ where: { id: idea.id } }).catch(() => {});
  }
});

await run("PR6-21-sync-replaces-existing", async () => {
  const idea = await createTestIdea("21", "# Old\n");
  try {
    await prisma.$transaction(async (tx: any) => {
      await block.syncBlocksForIdea(tx, idea.id, idea.content);
    });
    let rows = await block.listBlocksForIdea(prisma as any, idea.id);
    assert(rows.length === 1 && rows[0].type === "heading", "initial");

    // Now sync different content
    await prisma.$transaction(async (tx: any) => {
      await block.syncBlocksForIdea(tx, idea.id, "para1\n\npara2\n");
    });
    rows = await block.listBlocksForIdea(prisma as any, idea.id);
    assert(rows.length === 2, `after sync: ${rows.length}`);
    assert(rows.every(r => r.type === "paragraph"), "all paragraphs");
  } finally {
    await prisma.idea.delete({ where: { id: idea.id } }).catch(() => {});
  }
});

await run("PR6-22-sync-empty-content", async () => {
  const idea = await createTestIdea("22", "# Stuff\n");
  try {
    await prisma.$transaction(async (tx: any) => {
      await block.syncBlocksForIdea(tx, idea.id, idea.content);
    });
    let rows = await block.listBlocksForIdea(prisma as any, idea.id);
    assert(rows.length === 1, "initial");

    await prisma.$transaction(async (tx: any) => {
      await block.syncBlocksForIdea(tx, idea.id, "");
    });
    rows = await block.listBlocksForIdea(prisma as any, idea.id);
    assert(rows.length === 0, `expected 0 after empty content, got ${rows.length}`);
  } finally {
    await prisma.idea.delete({ where: { id: idea.id } }).catch(() => {});
  }
});

await run("PR6-23-cascade-on-idea-delete", async () => {
  const idea = await createTestIdea("23", "# X\n");
  await prisma.$transaction(async (tx: any) => {
    await block.syncBlocksForIdea(tx, idea.id, idea.content);
  });
  let rows = await block.listBlocksForIdea(prisma as any, idea.id);
  assert(rows.length > 0, "rows exist");
  await prisma.idea.delete({ where: { id: idea.id } });
  rows = await block.listBlocksForIdea(prisma as any, idea.id);
  assert(rows.length === 0, "FK cascade");
});

// ─── Reassemble proves source-of-truth invariant ──────────────────────

await run("PR6-30-roundtrip-from-db", async () => {
  const md = "# Title\n\n## Sub\n\nA paragraph with **bold** and *italic*.\n\n- one\n- two\n\n```ts\nconst x = 1;\n```\n";
  const idea = await createTestIdea("30", md);
  try {
    await prisma.$transaction(async (tx: any) => {
      await block.syncBlocksForIdea(tx, idea.id, idea.content);
    });
    const rows = await block.listBlocksForIdea(prisma as any, idea.id);
    const reassembled = rows.map(r => r.content).join("");
    assert(reassembled === md, `db-roundtrip mismatch: ${JSON.stringify(reassembled)} vs ${JSON.stringify(md)}`);
  } finally {
    await prisma.idea.delete({ where: { id: idea.id } }).catch(() => {});
  }
});

// ─── Cleanup ─────────────────────────────────────────────────────────

const passed = results.filter(r => r.status === "PASS").length;
const failed = results.filter(r => r.status === "FAIL").length;
console.log(`\n=== PR6 RESULTS ===\nTotal: ${results.length}, PASS: ${passed}, FAIL: ${failed}\n`);

const stale = await prisma.idea.findMany({ where: { name: { startsWith: TEST_PREFIX } } });
for (const s of stale) {
  await prisma.idea.delete({ where: { id: s.id } }).catch(() => {});
}
console.log(`[cleanup] removed ${stale.length} __pr6_* idea rows`);

process.exit(failed > 0 ? 1 : 0);
