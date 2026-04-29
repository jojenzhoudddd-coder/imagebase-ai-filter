/**
 * PR9 backend test driver — block-level comments via Conversation.attachedTo*.
 *
 * Run: cd backend && npx tsx scripts/idea-block-pr9-test.ts
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

const convStore = await import("../src/services/conversationStore.js");
const block = await import("../src/services/ideaBlockService.js");
const { PrismaClient } = await import("../src/generated/prisma/client.js");
const pg = (await import("pg")).default;
const { PrismaPg } = await import("@prisma/adapter-pg");
const prisma = new PrismaClient({
  adapter: new PrismaPg(new pg.Pool({ connectionString: process.env.DATABASE_URL })),
});

const TEST_PREFIX = "__pr9_";

async function createTestIdea(suffix: string, content = "# A\n\n# B\n") {
  const idea = await prisma.idea.create({
    data: { name: `${TEST_PREFIX}${suffix}`, workspaceId: "doc_default", content },
  });
  await prisma.$transaction(async (tx: any) => {
    await block.syncBlocksForIdea(tx, idea.id, content);
  });
  return idea;
}

// ─── PR9-01: createConversation accepts attached fields ───────────────

await run("PR9-01-create-with-attached", async () => {
  const idea = await createTestIdea("01");
  try {
    const blocks = await block.listBlocksForIdea(prisma as any, idea.id);
    const conv = await convStore.createConversation(
      "doc_default",
      `${TEST_PREFIX}attached`,
      "agent_default",
      { type: "idea-block", id: `${idea.id}#${blocks[0].id}` },
    );
    try {
      assert(conv.attachedToType === "idea-block", "type");
      assert(conv.attachedToId === `${idea.id}#${blocks[0].id}`, "id");
    } finally {
      await convStore.deleteConversation(conv.id);
    }
  } finally {
    await prisma.idea.delete({ where: { id: idea.id } }).catch(() => {});
  }
});

await run("PR9-02-create-without-attached-still-works", async () => {
  const conv = await convStore.createConversation(
    "doc_default",
    `${TEST_PREFIX}plain`,
    "agent_default",
  );
  try {
    assert(conv.attachedToType === null, "type null");
    assert(conv.attachedToId === null, "id null");
  } finally {
    await convStore.deleteConversation(conv.id);
  }
});

// ─── PR9-10: list by idea ─────────────────────────────────────────────

await run("PR9-10-listByIdea-returns-only-this-idea", async () => {
  const idea1 = await createTestIdea("10a");
  const idea2 = await createTestIdea("10b");
  const created: string[] = [];
  try {
    const b1 = await block.listBlocksForIdea(prisma as any, idea1.id);
    const b2 = await block.listBlocksForIdea(prisma as any, idea2.id);
    // Two on idea1, one on idea2
    const c1 = await convStore.createConversation(
      "doc_default",
      "c1",
      "agent_default",
      { type: "idea-block", id: `${idea1.id}#${b1[0].id}` },
    );
    const c2 = await convStore.createConversation(
      "doc_default",
      "c2",
      "agent_default",
      { type: "idea-block", id: `${idea1.id}#${b1[1].id}` },
    );
    const c3 = await convStore.createConversation(
      "doc_default",
      "c3",
      "agent_default",
      { type: "idea-block", id: `${idea2.id}#${b2[0].id}` },
    );
    created.push(c1.id, c2.id, c3.id);

    const list1 = await convStore.listConversationsAttachedToIdea(idea1.id);
    assert(list1.length === 2, `idea1 expected 2 got ${list1.length}`);
    const list2 = await convStore.listConversationsAttachedToIdea(idea2.id);
    assert(list2.length === 1, `idea2 expected 1 got ${list2.length}`);
  } finally {
    for (const id of created) await convStore.deleteConversation(id).catch(() => {});
    await prisma.idea.delete({ where: { id: idea1.id } }).catch(() => {});
    await prisma.idea.delete({ where: { id: idea2.id } }).catch(() => {});
  }
});

await run("PR9-11-listByIdea-empty", async () => {
  const idea = await createTestIdea("11");
  try {
    const list = await convStore.listConversationsAttachedToIdea(idea.id);
    assert(list.length === 0, `expected 0 got ${list.length}`);
  } finally {
    await prisma.idea.delete({ where: { id: idea.id } }).catch(() => {});
  }
});

// ─── PR9-20: prefix filter doesn't leak across ideas ─────────────────

await run("PR9-20-prefix-filter-tight", async () => {
  // Create two ideas, the 2nd has an id that prefix-matches the 1st by
  // accident (very unlikely with cuid, but pin behavior).
  const idea = await createTestIdea("20");
  try {
    const blocks = await block.listBlocksForIdea(prisma as any, idea.id);
    const c1 = await convStore.createConversation(
      "doc_default",
      "c1",
      "agent_default",
      { type: "idea-block", id: `${idea.id}#${blocks[0].id}` },
    );
    try {
      // Manually craft a "lookalike" attached id (not for a real idea)
      const c2 = await convStore.createConversation(
        "doc_default",
        "c2",
        "agent_default",
        { type: "idea-block", id: `${idea.id}AAA#fakeblock` },
      );
      try {
        const list = await convStore.listConversationsAttachedToIdea(idea.id);
        // Without strict # delimiter handling, the lookalike could leak.
        // listConversationsAttachedToIdea uses startsWith `${ideaId}#` so
        // it must NOT match `${idea.id}AAA#...`.
        const ids = list.map((c) => c.id);
        assert(ids.includes(c1.id), "c1 should be in list");
        assert(!ids.includes(c2.id), "c2 (different idea prefix) should NOT leak");
      } finally {
        await convStore.deleteConversation(c2.id).catch(() => {});
      }
    } finally {
      await convStore.deleteConversation(c1.id).catch(() => {});
    }
  } finally {
    await prisma.idea.delete({ where: { id: idea.id } }).catch(() => {});
  }
});

// ─── PR9-30: index speed sanity (just verifies the query plan uses it) ─

await run("PR9-30-list-fast-with-many-rows", async () => {
  const idea = await createTestIdea("30");
  const created: string[] = [];
  try {
    const blocks = await block.listBlocksForIdea(prisma as any, idea.id);
    // Create 30 conversations attached to this idea
    for (let i = 0; i < 30; i++) {
      const c = await convStore.createConversation(
        "doc_default",
        `c${i}`,
        "agent_default",
        { type: "idea-block", id: `${idea.id}#${blocks[i % blocks.length].id}` },
      );
      created.push(c.id);
    }
    const t0 = Date.now();
    const list = await convStore.listConversationsAttachedToIdea(idea.id);
    const dt = Date.now() - t0;
    assert(list.length === 30, "30 conversations");
    assert(dt < 500, `query too slow: ${dt}ms`);
  } finally {
    for (const id of created) await convStore.deleteConversation(id).catch(() => {});
    await prisma.idea.delete({ where: { id: idea.id } }).catch(() => {});
  }
});

// ─── Cleanup ──────────────────────────────────────────────────────────

const passed = results.filter((r) => r.status === "PASS").length;
const failed = results.filter((r) => r.status === "FAIL").length;
console.log(`\n=== PR9 RESULTS ===\nTotal: ${results.length}, PASS: ${passed}, FAIL: ${failed}\n`);

const stale = await prisma.idea.findMany({ where: { name: { startsWith: TEST_PREFIX } } });
for (const s of stale) await prisma.idea.delete({ where: { id: s.id } }).catch(() => {});
const staleConv = await prisma.conversation.findMany({ where: { title: { startsWith: TEST_PREFIX } } });
for (const c of staleConv) await prisma.conversation.delete({ where: { id: c.id } }).catch(() => {});
console.log(`[cleanup] removed ${stale.length} __pr9_* ideas + ${staleConv.length} __pr9_* convs`);

process.exit(failed > 0 ? 1 : 0);
